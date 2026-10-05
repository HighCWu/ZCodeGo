/**
 * zcode-go 移动端远程控制桥（阶段 2：out-of-band offer + mailbox + 资源通道）。
 *
 * 架构：手机（CF Worker 容器页）↔ 桌面隐藏桥窗口 P2P。Worker 仅是 answer
 * mailbox（+ QR 路径的 offer 取回）。配对两级：
 *   - 复制链接：#v=1&t=<token>&p=<secret>&o=<完整 offer（non-trickle，base64url）>
 *     ——手机本地解 offer 即刻协商，全程仅 answer 一条信令
 *   - 二维码：#v=1&t=<token>&p=<secret>&oc=<压缩 offer（过滤候选+deflate）>
 *     ——与链接同为 direct；压缩失败回退 i=<offer_id> 经 mailbox 取回
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
  /** 二维码内容（压缩 offer 优先，体积小）。 */
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
  // 用户主动停止 → idle；其余 teardown 原因都值得在对话框里露出。
  const stopped = reason === "stopped";
  session.status = { state: stopped ? "idle" : "error", error: stopped ? undefined : reason };
  session.onStatus({ ...session.status });
}

/**
 * 桥窗口页面脚本源码（纯 JS 字符串，运行在 nodeIntegration 页面里）。
 * 硬约束（破坏任一条 = 页面在隐藏窗口里静默死亡）：
 * 1) 不得出现反引号与 "${"——外层是模板字符串，String.raw 只保护反斜杠
 *    转义序列，不保护这两者；
 * 2) 不得引用本字符串之外的任何标识符——rendererRoot/iceServers 由发射时
 *    的外层包装函数注入；
 * 3) 改动后必须过 /tmp/zgbridge 的隔离页面加载 e2e（隐藏窗口内 SyntaxError
 *    不会浮出到任何日志）。
 * 用 String.raw 字符串而非函数 toString() 发射：esbuild 会给函数源码注入
 * keepNames（__name 包装每个具名函数）、require 互操作等外部引用，toString()
 * 出来的代码在页面里不可独立执行；字符串常量则原样穿过 bundler。
 */
const PAGE_SCRIPT_SOURCE = String.raw`
var pageRequire = globalThis.require;
var ipcRenderer = pageRequire("electron").ipcRenderer;
var fs = pageRequire("node:fs");
var path = pageRequire("node:path");

var pc = null;
var channels = {};

function makePeer(iceServers) {
  var peer = new RTCPeerConnection({ iceServers: iceServers });
  ["control", "rpc", "resource"].forEach(function (label) {
    var dc = peer.createDataChannel("zcode-go-" + label, { ordered: true });
    channels[label] = dc;
    dc.onopen = function () {
      ipcRenderer.send("zcode-go-bridge-event", { kind: "channel-open", label: label });
    };
    dc.onclose = function () {
      ipcRenderer.send("zcode-go-bridge-event", { kind: "channel-closed", label: label });
    };
  });
  channels.control.onmessage = function (event) {
    if (channels.control.readyState === "open") {
      channels.control.send("echo:" + event.data);
    }
  };
  channels.resource.onmessage = function (event) {
    handleResourceRequest(event.data);
  };
  peer.onconnectionstatechange = function () {
    ipcRenderer.send("zcode-go-bridge-event", {
      kind: "pc-state",
      state: peer.connectionState,
    });
  };
  return peer;
}

function filterCandidates(sdp) {
  return sdp
    .split("\r\n")
    .filter(function (line) {
      if (line.indexOf("a=candidate:") !== 0) return true;
      if (line.indexOf(" tcptype ") >= 0) return false; // TCP host：浏览器间几乎不生效
      if (/ [fF][dD][0-9a-fA-F]{2}:/.test(line) && line.indexOf(" typ srflx") < 0) {
        return false; // 链路本地 IPv6：手机侧不可达
      }
      return true;
    })
    .join("\r\n");
}

// ── offer 预生成：建 PC → createOffer → 等 ICE gathering complete → 完整 offer ──
async function pregenerateOffer(iceServers) {
  try {
    pc = makePeer(iceServers);
    var peer = pc;
    var offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await new Promise(function (resolve) {
      if (peer.iceGatheringState === "complete") {
        resolve();
        return;
      }
      var check = function () {
        if (peer.iceGatheringState === "complete") {
          peer.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      peer.addEventListener("icegatheringstatechange", check);
      // 兜底超时：srflx 慢或不可达时 8s 后带现有候选收工。
      setTimeout(resolve, 8000);
    });
    var local = peer.localDescription;
    if (!local) throw new Error("missing local description");
    var full = { type: local.type, sdp: local.sdp };
    // 二维码容量优化：过滤无效候选（TCP 在浏览器对浏览器场景几乎从不生效；
    // 链路本地 IPv6 手机侧不可达）+ deflate 压缩——实测 4.2KB 压到 ~1.1KB
    // base64url，完整 offer 得以装进二维码（上限 2953B），扫码路径与复制
    // 链接同为 direct（省掉 mailbox 取 offer 的一跳）。
    var compressed = null;
    try {
      var filteredSdp = filterCandidates(full.sdp);
      var json = JSON.stringify({ type: full.type, sdp: filteredSdp });
      var stream = new Blob([json])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw"));
      var buf = new Uint8Array(await new Response(stream).arrayBuffer());
      var bin = "";
      for (var i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);
      compressed = btoa(bin)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    } catch (e) {
      compressed = null; // 压缩失败回退 mailbox 路径（二维码只带 offer_id）
    }
    ipcRenderer.send("zcode-go-bridge-event", {
      kind: "offer-ready",
      offer: full,
      compressed: compressed,
    });
  } catch (error) {
    ipcRenderer.send("zcode-go-bridge-event", { kind: "offer-failed", error: String(error) });
  }
}

// mailbox 送来的完整 answer（direct 与 QR 路径共用）。
ipcRenderer.on("zcode-go-bridge-answer", function (_event, answer) {
  if (!pc || !answer || typeof answer.sdp !== "string") return;
  pc.setRemoteDescription({ type: "answer", sdp: answer.sdp }).then(
    function () {
      ipcRenderer.send("zcode-go-bridge-event", { kind: "answer-set" });
    },
    function (error) {
      ipcRenderer.send("zcode-go-bridge-event", { kind: "answer-err", error: String(error) });
    },
  );
});

// QR 路径：mailbox 转来 req-offer → 通知 main 推预生成的 offer。
ipcRenderer.on("zcode-go-bridge-req-offer", function () {
  if (pc && pc.localDescription && pc.localDescription.sdp) {
    ipcRenderer.send("zcode-go-bridge-event", { kind: "req-offer-received" });
  }
});

// ── resource 通道：手机请求桌面 renderer 产物（白名单在 rendererRoot 内）──
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function handleResourceRequest(raw) {
  var request;
  try {
    request = JSON.parse(raw);
  } catch (e) {
    return;
  }
  var id = request && request.id;
  var urlPath = request && request.path;
  if (typeof id !== "number" || typeof urlPath !== "string") return;
  var dc = channels.resource;
  if (!dc || dc.readyState !== "open") return;
  var send = function (payload) {
    dc.send(JSON.stringify(payload));
  };
  // path 归一化：/app/<rel> → rendererRoot/<rel>；resolve 后必须仍在根内（禁穿越）。
  var rel = urlPath.replace(/^\/app\//, "").replace(/^\/+/, "");
  var resolved = path.resolve(rendererRoot, rel);
  if (resolved !== rendererRoot && !resolved.startsWith(rendererRoot + path.sep)) {
    send({ id: id, type: "error", message: "forbidden" });
    return;
  }
  var data;
  try {
    data = fs.readFileSync(resolved);
  } catch (e) {
    send({ id: id, type: "error", message: "not-found" });
    return;
  }
  var mime = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
  var CHUNK = 48 * 1024;
  send({ id: id, type: "meta", status: 200, mime: mime, size: data.length });
  for (var offset = 0; offset < data.length; offset += CHUNK) {
    send({
      id: id,
      type: "chunk",
      seq: offset / CHUNK,
      b64: data.slice(offset, offset + CHUNK).toString("base64"),
    });
  }
  send({ id: id, type: "end" });
}

pregenerateOffer(iceServers);
ipcRenderer.send("zcode-go-bridge-event", { kind: "ready" });
`;

/**
 * 桥窗口页面：本地生成（可信内容），nodeIntegration 直用 ipcRenderer/fs。
 * 发射前先在主进程用 new Function 做纯解析自检——拼装错误在写文件前抛出，
 * 不再依赖隐藏窗口里的静默 SyntaxError（历史两种事故：模板字符串对页面代码
 * 的正则/转义二次求值；函数 toString() 被 esbuild 注入 keepNames/require
 * helper 变得不可独立执行）。
 */
function writeBridgeWindowHtml(): string {
  new Function("rendererRoot", "iceServers", PAGE_SCRIPT_SOURCE);
  const html = `<!doctype html>
<html><body><script>(function(rendererRoot,iceServers){${PAGE_SCRIPT_SOURCE}})(${JSON.stringify(
    RENDERER_ROOT,
  )},${JSON.stringify(ICE_SERVERS)});</script></body></html>`;
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
      // 隐藏窗口会被节流（计时器暂停会拖慢 8s gathering 兜底），关掉。
      backgroundThrottling: false,
    },
  });
  const bridgeWindow = session.bridgeWindow;

  const onBridgeEvent = (_event: unknown, payload: { kind: string; [key: string]: unknown }) => {
    if (activeSession !== session) return;
    if (payload.kind === "offer-ready") {
      const offer = payload.offer as { type: string; sdp: string };
      const compressed = typeof payload.compressed === "string" ? payload.compressed : null;
      clearTimeout(readinessWatchdog);
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
      logger.info("[zcode-go-mobile-bridge] offer 预生成完成", {
        token,
        sdpBytes: offer.sdp.length,
        compressedBytes: compressed ? compressed.length : null,
      });
    } else if (payload.kind === "offer-failed") {
      teardown(session, `offer 预生成失败：${String(payload.error)}`);
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
        teardown(
          session,
          "无法建立 P2P 连接。当前网络可能限制了 WebRTC，请尝试切换 Wi-Fi / 蜂窝网络或关闭 VPN。",
        );
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
          if (activeSession === session) teardown(session, "信令连接已断开，请刷新重试");
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
    if (activeSession === session) teardown(session, "桥窗口已关闭");
  });

  // 就绪看门狗：15s 内仍未拿到 offer（窗口未加载/页面异常）就显式报错，
  // 不让对话框无限停在「启动中」。
  const readinessWatchdog = setTimeout(() => {
    if (activeSession === session && !session.offer) {
      teardown(session, "桥就绪超时（15s 内未生成 offer）");
    }
  }, 15000);

  // 关键：窗口必须显式导航到桥页面，否则页面脚本（offer 预生成）不会执行、
  // did-finish-load（Worker 登记）不会触发——会话永远停在 signaling。
  bridgeWindow.webContents.once("did-fail-load", (_event, code, desc) => {
    if (activeSession === session) teardown(session, `桥窗口加载失败（${code} ${desc}）`);
  });
  void bridgeWindow.loadFile(htmlPath).catch((error: unknown) => {
    if (activeSession === session) teardown(session, `桥窗口加载失败：${String(error)}`);
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
