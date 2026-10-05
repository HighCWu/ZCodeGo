/**
 * zcode-go 移动端远程控制桥（阶段 2：out-of-band offer + mailbox + 资源通道）。
 *
 * 架构：手机（CF Worker 容器页）↔ 桌面隐藏桥窗口 P2P。Worker 仅是 answer
 * mailbox（+ QR 路径的 offer 取回）。配对两级：
 *   - 复制链接：#v=1&t=<token>&p=<secret>&o=<完整 offer（non-trickle，base64url）>
 *     ——手机本地解 offer 即刻协商，全程仅 answer 一条信令
 *   - 二维码：#v=1&t=<token>&p=<secret>&i=<offer_id>——扫码后经 mailbox
 *     req-offer 取回（URL 小，可扫）
 * 旧 trickle 路径保留（容器页 URL 无 v= 参数时走 legacy），A/B 实测后移除。
 *
 * 桥窗口职责：持有 RTCPeerConnection（offer 侧预生成：等 ICE gathering
 * complete）、三条 DataChannel（control/rpc/resource）；resource 通道以
 * fs 直读桌面 renderer 产物并分片回传（版本天然对齐桌面当前运行的构建）。
 * 注意 RTCSessionDescription/RTCIceCandidate 跨 ipcRenderer 序列化会丢成
 * 空对象——桥内一律先解构为普通对象。
 *
 * 信令地址：~/.zcode-go/config.json → mobileBridge.signalingOrigin；
 * ZCODE_GO_SIGNALING_ORIGIN env 覆盖；兜底 https://zcode-go.aimon.win。
 */
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, ipcMain } from "electron";

const STATE_DIR = join(homedir(), ".zcode-go");
const ICE_SERVERS = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];
/** 桌面 renderer 产物根（resource 通道的只读白名单根）。 */
const RENDERER_ROOT = join(
  homedir(),
  ".zcode-go",
  "electron",
  "resources",
  "app",
  "out",
  "renderer",
);

export interface MobileBridgeStatus {
  state: "idle" | "signaling" | "waiting-mobile" | "connecting" | "connected" | "error";
  /** 复制链接（携带完整 offer，direct 最快路径）。 */
  pairingUrl?: string;
  /** 二维码内容（仅 token/secret/offer_id，体积小）。 */
  qrUrl?: string;
  token?: string;
  error?: string;
}

interface MobileBridgeLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface Session {
  token: string;
  secret: string;
  offerId: string;
  offer: { type: string; sdp: string } | null;
  pairingUrl: string;
  qrUrl: string;
  ws: WebSocket | null;
  bridgeWindow: BrowserWindow | null;
  status: MobileBridgeStatus;
  onStatus: (status: MobileBridgeStatus) => void;
}

let activeSession: Session | null = null;

/** [a-z2-9] 去 0/1/o/i 的防误读字母表。 */
function generateToken(length = 8): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

function resolveSignalingOrigin(): string {
  const fromEnv = process.env.ZCODE_GO_SIGNALING_ORIGIN?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    const configPath = join(STATE_DIR, "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        mobileBridge?: { signalingOrigin?: unknown };
      };
      const origin =
        typeof config.mobileBridge?.signalingOrigin === "string"
          ? config.mobileBridge.signalingOrigin.trim()
          : "";
      if (origin) return origin.replace(/\/$/, "");
    }
  } catch {
    /* 坏配置按未配置处理 */
  }
  // 默认信令地址（用户自有 Worker 部署，aimon.win zone 托管在 CF）。
  return "https://zcode-go.aimon.win";
}

function emit(session: Session): void {
  session.onStatus({ ...session.status });
}

function teardown(session: Session, reason: string): void {
  if (activeSession !== session) return;
  activeSession = null;
  try {
    session.ws?.close();
  } catch {
    /* 尽力而为 */
  }
  if (session.bridgeWindow && !session.bridgeWindow.isDestroyed()) {
    session.bridgeWindow.destroy();
  }
  session.status = { state: "idle", error: reason };
  session.onStatus({ ...session.status });
}

/** 桥窗口页面：本地生成（可信内容），nodeIntegration 直用 ipcRenderer/fs。 */
function writeBridgeWindowHtml(): string {
  const html = `<!doctype html>
<html><body><script>
const { ipcRenderer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const RENDERER_ROOT = ${JSON.stringify(RENDERER_ROOT)};

let pc = null;
const channels = {};

function makePeer() {
  const peer = new RTCPeerConnection({ iceServers: ${JSON.stringify(ICE_SERVERS)} });
  for (const label of ["control", "rpc", "resource"]) {
    const dc = peer.createDataChannel("zcode-go-" + label, { ordered: true });
    channels[label] = dc;
    dc.onopen = () => ipcRenderer.send("zcode-go-bridge-event", { kind: "channel-open", label });
    dc.onclose = () => ipcRenderer.send("zcode-go-bridge-event", { kind: "channel-closed", label });
  }
  channels.control.onmessage = (event) => {
    if (channels.control.readyState === "open") channels.control.send("echo:" + event.data);
  };
  channels.resource.onmessage = (event) => handleResourceRequest(event.data);
  peer.onconnectionstatechange = () => {
    ipcRenderer.send("zcode-go-bridge-event", { kind: "pc-state", state: peer.connectionState });
  };
  return peer;
}

function filterCandidates(sdp) {
  return sdp.split("\r\n").filter(function (line) {
    if (line.indexOf("a=candidate:") !== 0) return true;
    if (line.indexOf(" tcptype ") >= 0) return false; // TCP host：浏览器间几乎不生效
    if (/ [fF][dD][0-9a-fA-F]{2}:/.test(line) && line.indexOf(" typ srflx") < 0) return false; // 链路本地 IPv6
    return true;
  }).join("\r\n");
}

// ── offer 预生成：建 PC → createOffer → 等 ICE gathering complete → 完整 offer ──
async function pregenerateOffer() {
  try {
    pc = makePeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const check = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", check);
      // 兜底超时：srflx 慢或不可达时 8s 后带现有候选收工。
      setTimeout(resolve, 8000);
    });
    const full = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
    // 二维码容量优化：过滤无效候选（TCP 在浏览器对浏览器场景几乎从不生效；
    // 链路本地 IPv6 手机侧不可达）+ deflate 压缩——实测 3.0KB SDP 压到
    // ~1.0KB base64url，完整 offer 得以装进二维码（上限 2953B），扫码路径
    // 与复制链接同为 direct（省掉 mailbox 取 offer 的一跳）。
    let compressed = null;
    try {
      const filteredSdp = filterCandidates(full.sdp);
      const json = JSON.stringify({ type: full.type, sdp: filteredSdp });
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);
      compressed = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (e) {
      compressed = null; // 压缩失败回退 mailbox 路径（二维码只带 offer_id）
    }
    ipcRenderer.send("zcode-go-bridge-event", { kind: "offer-ready", offer: full, compressed });
  } catch (error) {
    ipcRenderer.send("zcode-go-bridge-event", { kind: "offer-failed", error: String(error) });
  }
}

// mailbox 送来的完整 answer（direct 与 QR 路径共用）。
ipcRenderer.on("zcode-go-bridge-answer", (_event, answer) => {
  if (!pc || !answer || typeof answer.sdp !== "string") return;
  pc.setRemoteDescription({ type: "answer", sdp: answer.sdp }).then(
    () => ipcRenderer.send("zcode-go-bridge-event", { kind: "answer-set" }),
    (error) =>
      ipcRenderer.send("zcode-go-bridge-event", { kind: "answer-err", error: String(error) }),
  );
});

// QR 路径：mailbox 转来 req-offer → 通知 main 推预生成的 offer。
ipcRenderer.on("zcode-go-bridge-req-offer", () => {
  if (pc && pc.localDescription && pc.localDescription.sdp) {
    ipcRenderer.send("zcode-go-bridge-event", { kind: "req-offer-received" });
  }
});

// ── resource 通道：手机请求桌面 renderer 产物（白名单在 RENDERER_ROOT 内）──
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function handleResourceRequest(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return;
  }
  const id = request && request.id;
  const urlPath = request && request.path;
  if (typeof id !== "number" || typeof urlPath !== "string") return;
  const dc = channels.resource;
  if (!dc || dc.readyState !== "open") return;
  const send = (payload) => dc.send(JSON.stringify(payload));
  // path 归一化：/app/<rel> → RENDERER_ROOT/<rel>；resolve 后必须仍在根内（禁穿越）。
  const rel = urlPath.replace(/^\\/app\\//, "").replace(/^\\/+/, "");
  const resolved = path.resolve(RENDERER_ROOT, rel);
  if (resolved !== RENDERER_ROOT && !resolved.startsWith(RENDERER_ROOT + path.sep)) {
    send({ id, type: "error", message: "forbidden" });
    return;
  }
  let data;
  try {
    data = fs.readFileSync(resolved);
  } catch {
    send({ id, type: "error", message: "not-found" });
    return;
  }
  const mime = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
  const CHUNK = 48 * 1024;
  send({ id, type: "meta", status: 200, mime, size: data.length });
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    send({
      id,
      type: "chunk",
      seq: offset / CHUNK,
      b64: data.slice(offset, offset + CHUNK).toString("base64"),
    });
  }
  send({ id, type: "end" });
}

pregenerateOffer();
ipcRenderer.send("zcode-go-bridge-event", { kind: "ready" });
</script></body></html>`;
  mkdirSync(STATE_DIR, { recursive: true });
  const filePath = join(STATE_DIR, "mobile-bridge-window.html");
  writeFileSync(filePath, html, "utf8");
  return filePath;
}

export function startMobileBridgePairing(
  logger: MobileBridgeLogger,
  onStatus: (status: MobileBridgeStatus) => void,
): MobileBridgeStatus {
  if (activeSession) {
    return { ...activeSession.status };
  }
  const origin = resolveSignalingOrigin();
  const token = generateToken();
  const secret = randomBytes(16).toString("hex");
  const offerId = randomBytes(6).toString("hex");
  const session: Session = {
    token,
    secret,
    offerId,
    offer: null,
    pairingUrl: "",
    qrUrl: `${origin}/#v=1&t=${token}&p=${secret}&i=${offerId}`,
    ws: null,
    bridgeWindow: null,
    status: { state: "signaling", token },
    onStatus,
  };
  activeSession = session;

  const htmlPath = writeBridgeWindowHtml();
  session.bridgeWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  const bridgeWindow = session.bridgeWindow;

  const onBridgeEvent = (_event: unknown, payload: { kind: string; [key: string]: unknown }) => {
    if (activeSession !== session) return;
    if (payload.kind === "offer-ready") {
      const offer = payload.offer as { type: string; sdp: string };
      const compressed = typeof payload.compressed === "string" ? payload.compressed : null;
      session.offer = offer;
      // 链接形态（direct 最快路径）：完整 offer base64url 进 hash。
      const encoded = Buffer.from(JSON.stringify(offer), "utf8").toString("base64url");
      session.pairingUrl = `${origin}/#v=1&t=${token}&p=${secret}&o=${encoded}`;
      // 二维码：压缩后体积 ~1KB（候选过滤+deflate，实测 4.2KB→1.1KB），低于
      // QR 字节模式上限（2953B）——扫码路径同为 direct；压缩失败回退 offer_id。
      session.qrUrl = compressed
        ? `${origin}/#v=1&t=${token}&p=${secret}&oc=${compressed}`
        : `${origin}/#v=1&t=${token}&p=${secret}&i=${session.offerId}`;
      session.status = {
        ...session.status,
        state: "waiting-mobile",
        pairingUrl: session.pairingUrl,
        qrUrl: session.qrUrl,
      };
      emit(session);
    } else if (payload.kind === "req-offer-received") {
      // QR 路径应答：经信令 WS 推预生成的 offer。
      if (session.offer && session.ws?.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ t: "offer", i: session.offerId, data: session.offer }));
      }
    } else if (payload.kind === "pc-state") {
      const state = payload.state as string;
      if (state === "connected") {
        session.status = { ...session.status, state: "connected" };
        emit(session);
      } else if (state === "failed") {
        teardown(session, "p2p-failed");
      }
    } else if (payload.kind === "channel-open" && payload.label === "zcode-go-control") {
      session.status = { ...session.status, state: "connected" };
      emit(session);
    }
  };
  ipcMain.on("zcode-go-bridge-event", onBridgeEvent);

  const sendToBridge = (channel: string, data: unknown): void => {
    if (activeSession !== session || !bridgeWindow || bridgeWindow.isDestroyed()) return;
    bridgeWindow.webContents.send(channel, data);
  };

  bridgeWindow.webContents.once("did-finish-load", () => {
    void (async () => {
      try {
        const registerResponse = await fetch(`${origin}/api/rooms`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!registerResponse.ok) {
          teardown(session, `房间登记失败（${registerResponse.status}）`);
          return;
        }
        const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/api/signal/${token}?role=desktop`);
        session.ws = ws;
        ws.onopen = () => {
          if (activeSession !== session) return;
          // mailbox 注册 capability secret。
          ws.send(JSON.stringify({ t: "register", p: session.secret }));
          session.status = { ...session.status, state: "waiting-mobile", qrUrl: session.qrUrl };
          emit(session);
        };
        ws.onmessage = (event) => {
          if (activeSession !== session) return;
          let message: { t?: string; i?: unknown; data?: unknown };
          try {
            message = JSON.parse(String(event.data)) as { t?: string; i?: unknown; data?: unknown };
          } catch {
            return;
          }
          if (message.t === "req-offer") {
            // QR 路径：手机凭 secret 请求 offer。
            sendToBridge("zcode-go-bridge-req-offer", null);
          } else if (message.t === "answer") {
            if (!session.offer) return; // offer 预生成未完成（极端时序），手机会重试
            session.status = { ...session.status, state: "connecting" };
            emit(session);
            sendToBridge("zcode-go-bridge-answer", message.data);
          }
        };
        ws.onclose = () => {
          if (activeSession === session) teardown(session, "signaling-closed");
        };
        ws.onerror = () => {
          if (activeSession === session) teardown(session, "信令连接失败");
        };
      } catch (error) {
        teardown(session, error instanceof Error ? error.message : String(error));
      }
    })();
  });

  bridgeWindow.once("closed", () => {
    ipcMain.removeListener("zcode-go-bridge-event", onBridgeEvent);
    if (activeSession === session) teardown(session, "bridge-window-closed");
  });
  logger.info("[zcode-go-mobile-bridge] 配对开始", { token });
  emit(session);
  return { ...session.status };
}

export function stopMobileBridgePairing(): void {
  if (activeSession) teardown(activeSession, "stopped");
}

export function getMobileBridgeStatus(): MobileBridgeStatus {
  return activeSession ? { ...activeSession.status } : { state: "idle" };
}
