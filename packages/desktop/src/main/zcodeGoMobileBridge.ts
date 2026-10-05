/**
 * zcode-go 移动端远程控制桥（阶段 1：信令 + WebRTC DataChannel echo）。
 *
 * 架构：手机（CF Worker 容器页，answer 侧）↔ 桌面隐藏桥窗口（offer 侧）。
 * main 只做配对编排与信令转发——WebRTC 必须活在桥窗口（Chromium）里：
 * Electron main 是纯 Node，没有 WebRTC。
 *
 * 生命周期：startPairing() 生成一次性 token → 登记房间 → 连信令（desktop）→
 * 打开桥窗口待命；手机 join 后桥窗口发 offer → answer/ICE 交换 → DataChannel
 * open 即配对完成。任一环失败/断开整体回收；无 TURN，ICE 失败即终态（容器页
 * 负责向用户展示换网络提示）。
 *
 * 信令地址：~/.zcode-go/config.json → mobileBridge.signalingOrigin；
 * ZCODE_GO_SIGNALING_ORIGIN env 覆盖（dev 指向 wrangler dev 的 localhost）。
 */
import { randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, ipcMain } from "electron";

const STATE_DIR = join(homedir(), ".zcode-go");
const ICE_SERVERS = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

export interface MobileBridgeStatus {
  state: "idle" | "signaling" | "waiting-mobile" | "connecting" | "connected" | "error";
  pairingUrl?: string;
  token?: string;
  error?: string;
}

interface MobileBridgeLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface Session {
  token: string;
  pairingUrl: string;
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

/** 桥窗口页面：本地生成（可信内容），nodeIntegration 直用 ipcRenderer。 */
function writeBridgeWindowHtml(): string {
  const html = `<!doctype html>
<html><body><script>
const { ipcRenderer } = require("electron");
const pc = new RTCPeerConnection({ iceServers: ${JSON.stringify(ICE_SERVERS)} });
const channels = {};
for (const label of ["control", "rpc", "resource"]) {
  const dc = pc.createDataChannel("zcode-go-" + label, { ordered: true });
  channels[label] = dc;
  dc.onopen = () => ipcRenderer.send("zcode-go-bridge-event", { kind: "channel-open", label });
  dc.onclose = () => ipcRenderer.send("zcode-go-bridge-event", { kind: "channel-closed", label });
}
const control = channels.control;
// 阶段 1 echo：control 通道回环（容器页输入 → 桥回复 echo:...）。
control.onmessage = (event) => {
  if (control.readyState === "open") control.send("echo:" + event.data);
};
// RTCIceCandidate/RTCSessionDescription 跨 ipcRenderer structured clone 会丢成
// 空对象——发送前必须解构为普通对象（e2e 实测：mobile 收到空 offer）。
pc.onicecandidate = (event) => {
  if (event.candidate) {
    ipcRenderer.send("zcode-go-bridge-signal-out", {
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
      usernameFragment: event.candidate.usernameFragment,
    });
  }
};
pc.onconnectionstatechange = () => {
  ipcRenderer.send("zcode-go-bridge-event", { kind: "pc-state", state: pc.connectionState });
};
ipcRenderer.on("zcode-go-bridge-signal-start", async () => {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ipcRenderer.send("zcode-go-bridge-signal-out", {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp,
    });
  } catch (error) {
    ipcRenderer.send("zcode-go-bridge-event", { kind: "offer-failed", error: String(error) });
  }
});
ipcRenderer.on("zcode-go-bridge-signal-in", (_event, data) => {
  if (data && data.type === "answer") {
    pc.setRemoteDescription(data).catch((error) => {
      ipcRenderer.send("zcode-go-bridge-event", { kind: "answer-failed", error: String(error) });
    });
  } else if (data && data.candidate) {
    pc.addIceCandidate(data).catch(() => {});
  }
});
ipcRenderer.send("zcode-go-bridge-event", { kind: "ready" });
</script></body></html>`;
  const path = join(STATE_DIR, "mobile-bridge-window.html");
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(path, html, "utf8");
  return path;
}

export function startMobileBridgePairing(
  logger: MobileBridgeLogger,
  onStatus: (status: MobileBridgeStatus) => void,
): MobileBridgeStatus {
  if (activeSession) {
    return { ...activeSession.status };
  }
  const origin = resolveSignalingOrigin();
  if (!origin) {
    const status: MobileBridgeStatus = {
      state: "error",
      error: "未配置信令服务器：请在 ~/.zcode-go/config.json 设置 mobileBridge.signalingOrigin",
    };
    onStatus(status);
    return status;
  }
  const token = generateToken();
  const session: Session = {
    token,
    pairingUrl: `${origin}/#${token}`,
    ws: null,
    bridgeWindow: null,
    status: { state: "signaling", pairingUrl: `${origin}/#${token}`, token },
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
  const webContentsId = session.bridgeWindow.webContents.id;
  const bridgeWindow = session.bridgeWindow;
  void bridgeWindow.loadFile(htmlPath).catch((error) => {
    logger.warn("[zcode-go-mobile-bridge] 桥窗口加载失败:", error);
  });
  const onBridgeEvent = (_event: unknown, payload: { kind: string; [key: string]: unknown }) => {
    if (activeSession !== session) return;
    if (payload.kind === "pc-state") {
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

  const signalOut = (_event: unknown, data: unknown) => {
    if (activeSession !== session || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;
    session.ws.send(JSON.stringify({ t: "signal", data }));
  };
  ipcMain.on("zcode-go-bridge-signal-out", signalOut);

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
          session.status = { ...session.status, state: "waiting-mobile" };
          emit(session);
        };
        ws.onmessage = (event) => {
          if (activeSession !== session) return;
          let message: { t?: string; data?: unknown };
          try {
            message = JSON.parse(String(event.data)) as { t?: string; data?: unknown };
          } catch {
            return;
          }
          if (message.t === "peer-joined") {
            session.status = { ...session.status, state: "connecting" };
            emit(session);
            sendToBridge("zcode-go-bridge-signal-start", null);
          } else if (message.t === "signal") {
            sendToBridge("zcode-go-bridge-signal-in", message.data);
          } else if (message.t === "peer-left") {
            teardown(session, "peer-left");
          } else if (message.t === "error") {
            teardown(session, `信令错误：${JSON.stringify(message.data)}`);
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
    ipcMain.removeListener("zcode-go-bridge-signal-out", signalOut);
    if (activeSession === session) teardown(session, "bridge-window-closed");
  });
  void webContentsId;
  logger.info("[zcode-go-mobile-bridge] 配对开始", { token, pairingUrl: session.pairingUrl });
  emit(session);
  return { ...session.status };
}

export function stopMobileBridgePairing(): void {
  if (activeSession) teardown(activeSession, "stopped");
}

export function getMobileBridgeStatus(): MobileBridgeStatus {
  return activeSession ? { ...activeSession.status } : { state: "idle" };
}
