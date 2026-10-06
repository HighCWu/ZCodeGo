/**
 * zcode-go 移动端远程控制桥（阶段 2/3：out-of-band offer + mailbox + 资源通道
 * + preload API 透传 + 多客户端并发）。
 *
 * 架构：每个远端客户端（手机/浏览器 tab）↔ 桌面一个隐藏桥窗口 P2P。Worker
 * 仅是 answer mailbox（+ QR 路径的 offer 取回，按请求方路由）。配对两级：
 *   - 复制链接/二维码：?v=1&t=<token>&p=<secret>&i=<offer_id>——query 路由
 *     态，经 mailbox 取回 offer（每连接多一次信令往返，换取 URL 简洁与
 *     QR/链接同路径；容器页保留 o=/oc= direct 通道作兼容）
 *   - 二维码：?v=1&t=<token>&p=<secret>&i=<offer_id>——短码经 mailbox 取回
 * 首个（primary）桥窗口随配对启动预生成 offer（扫码秒连）；后续客户端的
 * req-offer 到达时按需追加桥窗口（offer 预生成 ~1-8s 后应答）。
 *
 * 桥窗口（contextIsolation:true + sandbox:false + 自定义 preload，全部逻辑在
 * preload 隔离世界——node/DOM 俱全）职责：
 *   1. 持有 RTCPeerConnection（offer 侧预生成：等 ICE gathering complete）
 *      与三条 DataChannel（control/rpc/resource）；
 *   2. resource 通道 fs 直读桌面 renderer 产物分片回传（版本天然对齐）；
 *   3. 求值真实 preload bundle（伪造 contextBridge 捕获 window.zcode 原生
 *      API——映射表零维护），rpc 通道按方法名透传 invoke/订阅给远端 shim；
 *   4. MessagePort 仿真：真 preload 转发到本 window 的 ServicePort/启动状态
 *      消息被截获，端口本地收养、消息经 rpc 双向转发（二进制帧 base64 标签）。
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
/** 官方桌面 preload bundle（桥窗口求值它以捕获原生 zcode API）。 */
const PRELOAD_BUNDLE_PATH = join(
  homedir(),
  ".zcode-go",
  "electron",
  "resources",
  "app",
  "out",
  "preload",
  "index.cjs",
);

export interface MobileBridgeStatus {
  state: "idle" | "signaling" | "waiting-mobile" | "connecting" | "connected" | "error";
  /** 复制链接（与二维码同形的 offer_id 短码，经 mailbox 取回）。 */
  pairingUrl?: string;
  /** 二维码内容（offer_id 短码，经 mailbox 取回；相机可靠扫描优先）。 */
  qrUrl?: string;
  token?: string;
  error?: string;
}

interface MobileBridgeLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** 一个远端客户端 ↔ 一个桥窗口。 */
interface BridgeWindowEntry {
  offerId: string;
  win: BrowserWindow;
  isPrimary: boolean;
  offer: { type: string; sdp: string } | null;
  offerUsed: boolean;
  connected: boolean;
  /** 粘性：该窗口的 PC 曾成功连接过（断开后不复位——primary 失败分类用，
   * 区分「从未建起来」（网络禁 WebRTC）与「连上过后正常结束」（远端关页）。 */
  everConnected: boolean;
  attachTimer: NodeJS.Timeout | null;
  /** 挂起的 req-offer 请求标记（该窗口 offer 就绪后应答）。 */
  pendingRequestIds: string[];
}

interface Session {
  token: string;
  secret: string;
  /** primary 窗口的 offerId（QR/链接指向它）。 */
  offerId: string;
  pairingUrl: string;
  qrUrl: string;
  ws: WebSocket | null;
  windows: BridgeWindowEntry[];
  status: MobileBridgeStatus;
  onStatus: (status: MobileBridgeStatus) => void;
  /** 房间心跳（滑动续期）定时器；teardown/stop 清理。 */
  roomHeartbeat: NodeJS.Timeout | null;
  /** primary PC 失败的时间戳（10 分钟滑窗内 ≥5 次才判定网络禁 WebRTC）。 */
  primaryFailureTimestamps: number[];
}

let activeSession: Session | null = null;
/** teardown 用：startMobileBridgePairing 时注入的 logger（teardown 需留痕）。 */
let sessionLogger: MobileBridgeLogger | null = null;
/** 全部桥窗口（含 detached 保活的）：无 UI 的无头传输窗口，绝不能被当成
 * 「应用窗口」展示/聚焦——曾因 second-instance 聚焦到隐藏桥窗口，用户看到
 * 一个空白画布（标题 zcode go）而非主界面。 */
const bridgeWindows = new WeakSet<BrowserWindow>();

/** 该窗口是否为移动端桥的无头传输窗口（调用方应将其排除出应用窗口枚举）。 */
export function isMobileBridgeWindow(win: BrowserWindow): boolean {
  return bridgeWindows.has(win);
}
/** 刷新二维码后保留的 detached 窗口（连接自持）；超限回收最旧，防泄漏。 */
const detachedEntries: BridgeWindowEntry[] = [];
const MAX_DETACHED_ENTRIES = 8;

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

function destroyEntry(session: Session, entry: BridgeWindowEntry): void {
  if (session.windows.includes(entry)) {
    session.windows = session.windows.filter((w) => w !== entry);
  }
  const detachedIndex = detachedEntries.indexOf(entry);
  if (detachedIndex >= 0) detachedEntries.splice(detachedIndex, 1);
  if (entry.attachTimer) clearTimeout(entry.attachTimer);
  try {
    if (!entry.win.isDestroyed()) entry.win.destroy();
  } catch {
    /* 尽力而为 */
  }
}

function anyConnected(session: Session): boolean {
  return session.windows.some((w) => w.connected);
}

function teardown(session: Session, reason: string): void {
  if (activeSession !== session) return;
  activeSession = null;
  // 所有 teardown 路径都要留痕：会话静默死亡（UI 只见 idle）时靠这条定位原因。
  sessionLogger?.warn("[zcode-go-mobile-bridge] 会话 teardown", {
    token: session.token,
    reason,
    windows: session.windows.length,
    anyConnected: anyConnected(session),
  });
  if (session.roomHeartbeat) clearInterval(session.roomHeartbeat);
  for (const entry of [...session.windows]) destroyEntry(session, entry);
  try {
    session.ws?.close();
  } catch {
    /* 尽力而为 */
  }
  // 用户主动停止 → idle；其余 teardown 原因都值得在对话框里露出。
  const stopped = reason === "stopped";
  session.status = { state: stopped ? "idle" : "error", error: stopped ? undefined : reason };
  session.onStatus({ ...session.status });
}

/**
 * 桥窗口 preload 源码（运行在隔离世界，node/DOM 俱全）。
 * 硬约束（破坏任一条 = 隐藏窗口里静默死亡）：
 * 1) 不得出现反引号与 "${"——外层是模板字符串，String.raw 只保护反斜杠
 *    转义序列，不保护这两者；
 * 2) 不得引用本字符串之外的任何标识符——rendererRoot/iceServers/realPreload
 *    由发射时拼进的头部 const 提供；
 * 3) 改动后必须过 /tmp/zgbridge 的隔离加载 e2e。
 * 用 String.raw 而非函数 toString() 发射：esbuild 会注入 keepNames/require
 * 互操作 helper，toString() 的代码不可独立执行；字符串常量原样穿过 bundler。
 */
const PRELOAD_SCRIPT_SOURCE = String.raw`
var ipcRenderer = require("electron").ipcRenderer;
var fs = require("node:fs");
var path = require("node:path");

var pc = null;
var channels = {};
var capturedGlobals = {};
var capturedApi = null;

function makePeer(iceServers) {
  var peer = new RTCPeerConnection({ iceServers: iceServers });
  ["control", "rpc", "resource"].forEach(function (label) {
    var dc = peer.createDataChannel("zcode-go-" + label, { ordered: true });
    channels[label] = dc;
    dc.onopen = function () {
      // rpc 打开时冲刷缓冲：host 挂接（ServicePort/启动状态）发生在配对开始，
      // 早于远端连接——那时的 rpcReply 会因通道未开而入队等待。
      if (label === "rpc") flushRpcOutbox();
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
  channels.rpc.onmessage = function (event) {
    handleRpcMessage(event.data);
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
        return false; // 链路本地 IPv6：远端不可达
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
      compressed = null;
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

// ── 真实 preload API 捕获 ──
// 真 preload 的 contextBridge 需要隔离环境；本 preload 本身就在隔离世界里，
// 伪造 contextBridge.exposeInMainWorld 后求值 bundle，捕获其构造的 API 对象
// （闭包内即真 ipcRenderer.invoke 直连——方法名→通道映射零维护）。
try {
  var electronModule = require("electron");
  var fakeElectron = {};
  for (var moduleName in electronModule) fakeElectron[moduleName] = electronModule[moduleName];
  fakeElectron.contextBridge = {
    exposeInMainWorld: function (key, value) {
      capturedGlobals[key] = value;
    },
  };
  var preloadSourceText = fs.readFileSync(realPreload, "utf8");
  var wrappedPreload = new Function("require", "module", "exports", preloadSourceText);
  var preloadModule = { exports: {} };
  // bundle 可能在暴露 zcode 之后、注册尾部 ipcRenderer 监听（ServicePort/
  // 启动状态等）之前抛错——部分失败必须上报，否则远端 boot 门禁静默卡死。
  var preloadEvalError = null;
  try {
    wrappedPreload(
      function (id) {
        return id === "electron" ? fakeElectron : require(id);
      },
      preloadModule,
      preloadModule.exports,
    );
  } catch (evalError) {
    preloadEvalError = String((evalError && evalError.stack) || evalError);
  }
  capturedApi = capturedGlobals.zcode || null;
  if (preloadEvalError) {
    ipcRenderer.send("zcode-go-bridge-event", {
      kind: "preload-eval-warning",
      error: preloadEvalError.slice(0, 600),
    });
  }
  if (!capturedApi) {
    throw new Error("preload 未暴露 zcode API: " + (preloadEvalError || "unknown"));
  }
} catch (error) {
  ipcRenderer.send("zcode-go-bridge-event", {
    kind: "preload-capture-failed",
    error: String(error),
  });
}

// ── MessagePort 仿真：ServicePort/ScopedServicePort 端到端桥接 ──
// 远端 UI 的服务层跑在 MessagePort 上（VSBuffer 二进制帧 + 流控对象，均不可
// JSON 化）。真 preload 已把 main 的 ipcRenderer 端口事件转为本 window 的
// postMessage——在 preload 世界截获，端口留在本地，消息经 rpc 通道转发，
// 远端 shim 用自建 MessageChannel 仿出同形端口交给 UI。
var WIN_CHANNELS = {
  DatabaseStartupState: "zcode:database-startup-state",
  DatabaseStartupControl: "zcode:database-startup-control",
  ServicePort: "zcode:service-port",
  ScopedServicePort: "zcode:scoped-service-port",
  ScopedServicePortReady: "zcode:scoped-service-port-ready",
};
var portStreams = new Map();
var rpcOutbox = [];
var portSeq = 0;
var adoptedPorts = typeof WeakSet === "function" ? new WeakSet() : null;
// 已收养的 service 端口信息：WebKit（iOS）会丢弃通道打开早期（监听器未就绪
// 时）到达的 DataChannel 消息——冲刷的 port-open 可能整体丢失。远端 shim
// 凭 request-port 按需重取（同 streamId 重发，端口本体仍在 portStreams）。
var bootPortInfo = null;

function bytesToB64(u8) {
  var out = "";
  var CHUNK = 0x8000;
  for (var i = 0; i < u8.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(out);
}
function b64ToBytes(b64) {
  var s = atob(b64);
  var u8 = new Uint8Array(s.length);
  for (var j = 0; j < s.length; j += 1) u8[j] = s.charCodeAt(j);
  return u8;
}
function encodePortData(data) {
  try {
    if (data instanceof Uint8Array) return { bin: 1, b64: bytesToB64(data) };
    if (data instanceof ArrayBuffer) return { bin: 1, b64: bytesToB64(new Uint8Array(data)) };
  } catch (e) {
    return { bin: 0, value: null };
  }
  return { bin: 0, value: data };
}
function decodePortData(envelope) {
  if (!envelope || typeof envelope !== "object") return undefined;
  if (envelope.bin === 1 && typeof envelope.b64 === "string") return b64ToBytes(envelope.b64);
  return envelope.value;
}

function adoptPort(port, payload, portType, info) {
  if (adoptedPorts) {
    if (adoptedPorts.has(port)) return;
    adoptedPorts.add(port);
  }
  var streamId = ++portSeq;
  portStreams.set(streamId, port);
  if (info) info.streamId = streamId;
  port.onmessage = function (e) {
    rpcReply({ kind: "port-msg", streamId: streamId, data: encodePortData(e.data) });
  };
  port.start();
  rpcReply({ kind: "port-open", streamId: streamId, portType: portType, payload: payload });
}

window.addEventListener("message", function (event) {
  if (event.source !== window || !event.data || typeof event.data !== "object") return;
  var type = event.data.type;
  if (type === WIN_CHANNELS.DatabaseStartupState) {
    rpcReply({ kind: "win-msg", winType: "DatabaseStartupState", data: event.data.state });
    return;
  }
  if (type === WIN_CHANNELS.ServicePort || type === WIN_CHANNELS.ScopedServicePort) {
    var port = event.ports && event.ports[0];
    if (!port) return;
    if (type === WIN_CHANNELS.ServicePort) {
      bootPortInfo = { streamId: null, payload: { databaseStartupId: event.data.databaseStartupId } };
      adoptPort(port, bootPortInfo.payload, "service", bootPortInfo);
    } else {
      adoptPort(
        port,
        {
          attachmentId: event.data.attachmentId,
          sessionId: event.data.sessionId,
          target: event.data.target,
        },
        "scoped",
      );
    }
  }
});
// 注意：不直接 ipcRenderer.on 订阅 ServicePort/启动状态——真 preload 的尾部
// 监听会把两者转成本 window 的 postMessage（上方截获已覆盖）；双路订阅会对
// 同一端口双重收养（transfer 后对象不同，WeakSet 去重失效）。

function rpcReply(payload) {
  var text;
  try {
    text = JSON.stringify(payload);
  } catch (e) {
    return;
  }
  var dc = channels.rpc;
  if (!dc || dc.readyState !== "open") {
    // 远端尚未连接：缓冲（上限防泄漏），rpc 通道 open 时冲刷。
    if (rpcOutbox.length < 2000) rpcOutbox.push(text);
    return;
  }
  dc.send(text);
}

function flushRpcOutbox() {
  var dc = channels.rpc;
  if (!dc || dc.readyState !== "open" || rpcOutbox.length === 0) return;
  var queued = rpcOutbox;
  rpcOutbox = [];
  for (var i = 0; i < queued.length; i += 1) {
    try {
      dc.send(queued[i]);
    } catch (e) {
      /* 单条失败不阻断后续 */
    }
  }
}

// ── rpc 通道：远端 shim 按方法名透传 invoke/事件订阅 ──
async function handleRpcMessage(raw) {
  var msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (msg.kind === "invoke") {
    if (msg.method === "__zcodeGoMeta") {
      rpcReply({
        kind: "result",
        id: msg.id,
        ok: true,
        value: {
          deviceId:
            typeof capturedGlobals.__ZCODE_DEVICE_ID__ === "string"
              ? capturedGlobals.__ZCODE_DEVICE_ID__
              : "",
        },
      });
      return;
    }
    var fn = capturedApi ? capturedApi[msg.method] : undefined;
    if (typeof fn !== "function") {
      rpcReply({ kind: "result", id: msg.id, error: "no-method:" + String(msg.method) });
      return;
    }
    try {
      var value = await fn.apply(null, msg.args || []);
      rpcReply({ kind: "result", id: msg.id, ok: true, value: value === undefined ? null : value });
    } catch (error) {
      rpcReply({ kind: "result", id: msg.id, error: String((error && error.message) || error) });
    }
    return;
  }
  if (msg.kind === "subscribe") {
    var sub = capturedApi ? capturedApi[msg.method] : undefined;
    if (typeof sub !== "function") {
      rpcReply({ kind: "sub-error", id: msg.id, error: "no-method:" + String(msg.method) });
      return;
    }
    try {
      var rest = (msg.args || []).slice();
      sub.apply(
        null,
        [
          function (payload) {
            rpcReply({ kind: "event", subId: msg.id, payload: payload === undefined ? null : payload });
          },
        ].concat(rest),
      );
      rpcReply({ kind: "sub-ok", id: msg.id });
    } catch (error2) {
      rpcReply({ kind: "sub-error", id: msg.id, error: String((error2 && error2.message) || error2) });
    }
    return;
  }
  if (msg.kind === "request-port") {
    // 远端 shim 报告从未收到 port-open（WebKit 丢弃早期 DC 消息）——重发。
    // 同 streamId：端口本体一直在 portStreams，重发只影响远端建仿真端口。
    if (bootPortInfo && bootPortInfo.streamId) {
      rpcReply({
        kind: "port-open",
        streamId: bootPortInfo.streamId,
        portType: "service",
        payload: bootPortInfo.payload,
      });
    } else {
      rpcReply({ kind: "no-port", reason: bootPortInfo ? "adopting" : "not-attached" });
    }
    return;
  }
  if (msg.kind === "port-msg") {
    var stream = portStreams.get(msg.streamId);
    if (stream) {
      try {
        stream.postMessage(decodePortData(msg.data));
      } catch (e) {
        /* 端口已关闭等，忽略 */
      }
    }
    return;
  }
  if (msg.kind === "startup-control") {
    ipcRenderer.send(WIN_CHANNELS.DatabaseStartupControl, msg.control);
    return;
  }
  if (msg.kind === "scoped-ready") {
    ipcRenderer.send(WIN_CHANNELS.ScopedServicePortReady, {
      attachmentId: msg.attachmentId,
      sessionId: msg.sessionId,
    });
    return;
  }
}

// ── resource 通道：远端请求桌面 renderer 产物（白名单在 rendererRoot 内）──
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
  if (!rel) rel = "index.html"; // /app/ 目录请求映射到入口文档
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
 * 桥窗口双文件：stub HTML（主世界无逻辑）+ 自定义 preload（隔离世界承载
 * 全部桥逻辑与真实 preload API 捕获）。发射前 new Function 纯解析自检——
 * 拼装错误在写文件前抛出（历史事故见 PRELOAD_SCRIPT_SOURCE 注释）。
 */
function writeBridgeWindowFiles(): { htmlPath: string; preloadPath: string } {
  new Function("rendererRoot", "iceServers", "realPreload", PRELOAD_SCRIPT_SOURCE);
  const preloadSource =
    "const rendererRoot = " +
    JSON.stringify(RENDERER_ROOT) +
    ";\n" +
    "const iceServers = " +
    JSON.stringify(ICE_SERVERS) +
    ";\n" +
    "const realPreload = " +
    JSON.stringify(PRELOAD_BUNDLE_PATH) +
    ";\n" +
    PRELOAD_SCRIPT_SOURCE;
  mkdirSync(STATE_DIR, { recursive: true });
  const preloadPath = join(STATE_DIR, "mobile-bridge-window-preload.cjs");
  writeFileSync(preloadPath, preloadSource, "utf8");
  const htmlPath = join(STATE_DIR, "mobile-bridge-window.html");
  writeFileSync(htmlPath, "<!doctype html><html><body></body></html>", "utf8");
  return { htmlPath, preloadPath };
}

export interface MobileBridgeHostAttach {
  /** 挂接现有 host（ServicePort + startup relay）到桥窗口，由 app 侧提供。 */
  attach: (win: BrowserWindow) => boolean;
  /** 设备标识（additionalArguments 透传给 preload 的 --device-id）。 */
  deviceMid: string;
}

export function startMobileBridgePairing(
  logger: MobileBridgeLogger,
  onStatus: (status: MobileBridgeStatus) => void,
  host?: MobileBridgeHostAttach,
): MobileBridgeStatus {
  if (activeSession) {
    return { ...activeSession.status };
  }
  sessionLogger = logger;
  const origin = resolveSignalingOrigin();
  const token = generateToken();
  const secret = randomBytes(16).toString("hex");
  const offerId = randomBytes(6).toString("hex");
  // 短码 URL 在配对开始即可定（token/secret/offerId 均本地生成）——链接与
  // 二维码同时可用；早到的 req-offer 在 primary 窗口排队，offer 预生成完成
  //（≤8s）后即应答。
  const shortUrl = `${origin}/?v=1&t=${token}&p=${secret}&i=${offerId}`;
  const session: Session = {
    token,
    secret,
    offerId,
    pairingUrl: shortUrl,
    qrUrl: shortUrl,
    ws: null,
    windows: [],
    roomHeartbeat: null,
    primaryFailureTimestamps: [],
    status: { state: "signaling", token, pairingUrl: shortUrl, qrUrl: shortUrl },
    onStatus,
  };
  activeSession = session;

  /** 用窗口应答一个挂起的 req-offer（offer 就绪时调用）。 */
  const answerPendingRequest = (entry: BridgeWindowEntry, ws: WebSocket): void => {
    if (!entry.offer || entry.offerUsed) return;
    const requestId = entry.pendingRequestIds.shift();
    if (!requestId) return;
    entry.offerUsed = true;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "offer", r: requestId, i: entry.offerId, data: entry.offer }));
    }
    logger.info("[zcode-go-mobile-bridge] offer 已分配", { token, offerId: entry.offerId });
  };

  const createBridgeWindow = (isPrimary: boolean): BridgeWindowEntry => {
    const offerId = isPrimary ? session.offerId : randomBytes(6).toString("hex");
    const { htmlPath, preloadPath } = writeBridgeWindowFiles();
    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: {
        // 全部桥逻辑在 preload 隔离世界（node/DOM 俱全）；真实 preload 的
        // contextBridge 也只有在此形态下才能被求值捕获。
        preload: preloadPath,
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        // 真实 preload 从命令行参数解析 --device-id（渲染前同步读取）。
        additionalArguments: ["--device-id=" + (host?.deviceMid ?? "")],
        // 隐藏窗口会被节流（计时器暂停会拖慢 8s gathering 兜底），关掉。
        backgroundThrottling: false,
      },
    });
    bridgeWindows.add(win);
    const entry: BridgeWindowEntry = {
      offerId,
      win,
      isPrimary,
      offer: null,
      offerUsed: false,
      connected: false,
      everConnected: false,
      attachTimer: null,
      pendingRequestIds: [],
    };
    session.windows.push(entry);
    // 桥窗口 preload 的 console/异常唯一可见出口（隐藏窗口，否则静默）。
    win.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) {
        logger.warn("[zcode-go-bridge-page]", { token, level, message: message.slice(0, 300) });
      }
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      logger.warn("[zcode-go-mobile-bridge] 桥渲染进程异常退出", { token, reason: details.reason });
      if (activeSession === session) destroyEntry(session, entry);
    });

    const onBridgeEvent = (_event: unknown, payload: { kind: string; [key: string]: unknown }) => {
      // 会话被刷新（stop 保留活连接）后窗口成为" detached"：仅处理 pc-state
      // （failed → 回收窗口），其余事件随旧会话失效。
      const detached = activeSession !== session;
      if (!session.windows.includes(entry)) return;
      if (detached && payload.kind !== "pc-state") return;
      if (payload.kind === "offer-ready") {
        const offer = payload.offer as { type: string; sdp: string };
        const compressed = typeof payload.compressed === "string" ? payload.compressed : null;
        entry.offer = offer;
        if (isPrimary) {
          // 链接与二维码统一短码（offer_id 经 mailbox 取回）：URL 简洁、两条
          // 路径完全一致；direct 通道（o=/oc=）容器页保留兼容但不再产出。
          session.pairingUrl = `${origin}/?v=1&t=${token}&p=${secret}&i=${entry.offerId}`;
          session.qrUrl = session.pairingUrl;
          session.status = {
            ...session.status,
            state: "waiting-mobile",
            pairingUrl: session.pairingUrl,
            qrUrl: session.qrUrl,
          };
          emit(session);
        }
        logger.info("[zcode-go-mobile-bridge] offer 预生成完成", {
          token,
          offerId: entry.offerId,
          primary: isPrimary,
          sdpBytes: offer.sdp.length,
          compressedBytes: compressed ? compressed.length : null,
        });
        // 有挂起的客户端请求则立刻应答。
        if (session.ws?.readyState === WebSocket.OPEN) {
          answerPendingRequest(entry, session.ws);
        }
      } else if (payload.kind === "preload-eval-warning") {
        logger.warn("[zcode-go-mobile-bridge] preload 求值部分失败（尾部监听器可能缺失）", {
          token,
          error: String(payload.error),
        });
      } else if (payload.kind === "preload-capture-failed") {
        logger.warn("[zcode-go-mobile-bridge] preload API 捕获失败（rpc 通道不可用）", {
          token,
          error: String(payload.error),
        });
      } else if (payload.kind === "offer-failed") {
        logger.warn("[zcode-go-mobile-bridge] offer 预生成失败", {
          token,
          offerId: entry.offerId,
          error: String(payload.error),
        });
      } else if (payload.kind === "req-offer-received") {
        // mailbox req-offer 的应答由 main 直接推（offer 已在手中）。
        if (session.ws?.readyState === WebSocket.OPEN) {
          answerPendingRequest(entry, session.ws);
        }
      } else if (payload.kind === "pc-state") {
        const state = payload.state as string;
        if (state === "connected" && !entry.connected) {
          entry.connected = true;
          entry.everConnected = true;
          if (!detached && session.status.state !== "connected") {
            session.status = { ...session.status, state: "connected" };
            emit(session);
          }
        } else if (state === "failed") {
          // 远端关页/锁屏/断网都会把该窗口的 PC 推到 failed。绝不因 primary
          // 失败拆整个会话（否则任一手机关页 = 二维码作废，其余客户端陪葬）：
          // 回收失败窗口；primary 被回收时补开新 primary。URL/QR 只含
          // token+secret（一次性 offer 走 mailbox 按请求分配），补开后依旧
          // 可扫。10 分钟滑窗内 primary 连败 ≥5 次才判定网络禁 WebRTC。
          logger.info("[zcode-go-mobile-bridge] 桥窗口连接失败，回收", {
            token,
            offerId: entry.offerId,
            isPrimary,
          });
          // 该窗口上排队的 offer 请求重新派发（挂到别的窗口/新开窗口），
          // 不随窗口陪葬。
          const orphanedRequests = entry.pendingRequestIds.splice(0);
          destroyEntry(session, entry);
          if (orphanedRequests.length > 0) {
            logger.info("[zcode-go-mobile-bridge] 回收窗口的待答请求重新派发", {
              token,
              offerId: entry.offerId,
              count: orphanedRequests.length,
            });
            for (const requestId of orphanedRequests) {
              allocateOfferForRequest(requestId, session.ws);
            }
          }
          if (isPrimary && !detached) {
            // 只有「从未连上过」的 primary 失败才算连接失败（offer 被接受但
            // ICE 建不起来 = 网络禁 WebRTC 的特征）。连上过后再 failed 是远端
            // 关页/断网的正常生命周期结束，不计入——否则用户 10 分钟内开关
            // 远程 5 次会误杀整个配对会话（E2E 实测踩中）。
            const neverConnected = !entry.everConnected;
            const now = Date.now();
            session.primaryFailureTimestamps = session.primaryFailureTimestamps.filter(
              (ts) => now - ts < 600_000,
            );
            if (neverConnected) session.primaryFailureTimestamps.push(now);
            if (session.primaryFailureTimestamps.length >= 5) {
              teardown(
                session,
                "无法建立 P2P 连接。当前网络可能限制了 WebRTC，请尝试切换 Wi-Fi / 蜂窝网络或关闭 VPN。",
              );
            } else {
              createBridgeWindow(true);
              if (!anyConnected(session) && session.status.state !== "waiting-mobile") {
                session.status = { ...session.status, state: "waiting-mobile", qrUrl: session.qrUrl };
                emit(session);
              }
            }
          }
        }
      } else if (payload.kind === "channel-open" && payload.label === "zcode-go-control") {
        entry.connected = true;
        entry.everConnected = true;
        if (!detached && session.status.state !== "connected") {
          session.status = { ...session.status, state: "connected" };
          emit(session);
        }
      } else if (payload.kind === "channel-closed") {
        entry.connected = false;
      } else {
        logger.info("[zcode-go-mobile-bridge] 桥事件", {
          token,
          offerId: entry.offerId,
          kind: payload.kind,
          detail: JSON.stringify(payload).slice(0, 200),
        });
      }
    };
    ipcMain.on("zcode-go-bridge-event", onBridgeEvent);

    // 挂接现有 host：远端 UI 的 boot 门禁需要 ServicePort（服务层数据通道）
    // 与 DatabaseStartupState 事件——两者都只投递给走 createWindow 生命周期
    // 的窗口，桥窗口须手动补挂（preload 的监听器已随页面加载就位）。
    const attachHost = host?.attach;
    win.webContents.once("did-finish-load", () => {
      if (attachHost) {
        let attempts = 0;
        const tryAttach = (): void => {
          if (activeSession !== session || !session.windows.includes(entry)) return;
          attempts += 1;
          let attached = false;
          try {
            attached = attachHost(win);
          } catch (error) {
            logger.warn("[zcode-go-mobile-bridge] host 挂接异常", {
              token,
              error: String(error),
            });
          }
          if (attached) {
            logger.info("[zcode-go-mobile-bridge] host 已挂接桥窗口", {
              token,
              offerId: entry.offerId,
            });
            return;
          }
          if (attempts >= 30) {
            logger.warn("[zcode-go-mobile-bridge] host 未就绪，该窗口的远端将卡在启动门禁", {
              token,
              offerId: entry.offerId,
            });
            return;
          }
          entry.attachTimer = setTimeout(tryAttach, 1000);
        };
        tryAttach();
      }
    });

    win.webContents.once("did-fail-load", (_event, code, desc) => {
      logger.warn("[zcode-go-mobile-bridge] 桥窗口加载失败", {
        token,
        offerId: entry.offerId,
        code,
        desc,
      });
      if (activeSession === session) destroyEntry(session, entry);
    });

    win.once("closed", () => {
      ipcMain.removeListener("zcode-go-bridge-event", onBridgeEvent);
      if (session.windows.includes(entry)) destroyEntry(session, entry);
    });

    void win.loadFile(htmlPath).catch((error: unknown) => {
      logger.warn("[zcode-go-mobile-bridge] 桥窗口导航失败", {
        token,
        offerId: entry.offerId,
        error: String(error),
      });
      if (activeSession === session) destroyEntry(session, entry);
    });

    return entry;
  };

  /**
   * 客户端凭 secret 请求 offer 的分配：优先用未用 offer 的窗口；没有则挂到
   * 预生成中的窗口（含按需新开的辅助窗口，offer-ready 后应答）。窗口回收时
   * 其 pendingRequestIds 重新经此派发——请求不随窗口陪葬（否则客户端永远
   * 等不到 offer，卡在「正在建立与桌面的连接」）。
   */
  const allocateOfferForRequest = (requestId: string, ws: WebSocket | null): void => {
    const ready = session.windows.find((w) => w.offer && !w.offerUsed);
    if (ready) {
      ready.pendingRequestIds.push(requestId);
      if (ws) answerPendingRequest(ready, ws);
      return;
    }
    let pending = session.windows.find((w) => !w.offer && w.pendingRequestIds.length === 0);
    if (!pending && session.windows.length < 5) {
      pending = createBridgeWindow(false);
      logger.info("[zcode-go-mobile-bridge] 追加辅助桥窗口", {
        token,
        offerId: pending.offerId,
        total: session.windows.length,
      });
    }
    pending?.pendingRequestIds.push(requestId);
  };

  // primary 窗口：随配对启动，offer 预生成供 QR/链接。
  createBridgeWindow(true);

  // 就绪看门狗：15s 内 primary 仍未产出 offer 就显式报错（不无限「启动中」）。
  const readinessWatchdog = setTimeout(() => {
    if (activeSession !== session) return;
    const primary = session.windows.find((w) => w.isPrimary);
    if (!primary?.offer) {
      teardown(session, "桥就绪超时（15s 内未生成 offer）");
    }
  }, 15000);

  // 房间登记/心跳共用的容错请求：瞬时网络错误（undici 抛 "fetch failed"，
  // 请求未达服务端）与 5xx/429 按退避重试；明确 4xx 视为终态由调用方处理。
  let lastRoomPingFailureStatus = 0;
  const postRoomPing = async (attempts: number): Promise<Response | null> => {
    lastRoomPingFailureStatus = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (activeSession !== session) return null;
      try {
        const response = await fetch(`${origin}/api/rooms`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (response.status >= 500 || response.status === 429) {
          lastRoomPingFailureStatus = response.status;
          throw new Error(String(response.status));
        }
        return response;
      } catch {
        if (attempt === attempts - 1) return null;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)));
      }
    }
    return null;
  };

  void (async () => {
    try {
      const registerResponse = await postRoomPing(6);
      if (activeSession !== session) return;
      if (!registerResponse) {
        teardown(
          session,
          lastRoomPingFailureStatus > 0
            ? `配对服务暂时不可用（${lastRoomPingFailureStatus}），请稍后重试`
            : "无法连接配对服务：请检查本机网络（或代理）后重试",
        );
        return;
      }
      if (!registerResponse.ok) {
        teardown(session, `房间登记失败（${registerResponse.status}）`);
        return;
      }
      let signalingReconnectAttempts = 0;
      /**
       * 信令连接（可重入）：Worker 部署/DO 重启断开后自动重连。
       * 30s 应用层 ping + pong 超时检测：家庭路由/NAT 会静默回收空闲 TCP，
       * undici WebSocket 无自动心跳，半开连接本地毫无感知（表现为新客户端
       * req-offer 永远无回应）——pong 连续缺席即主动废弃并重建连接。
       */
      const connectSignaling = (): void => {
        if (activeSession !== session) return;
        const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/api/signal/${token}?role=desktop`);
        session.ws = ws;
        let lastPongAt = Date.now();
        let signalingPing: ReturnType<typeof setInterval> | null = null;
        ws.onopen = () => {
          if (activeSession !== session) return;
          signalingReconnectAttempts = 0;
          lastPongAt = Date.now();
          // mailbox 注册 capability secret。
          ws.send(JSON.stringify({ t: "register", p: session.secret }));
          if (session.status.state !== "connected") {
            session.status = { ...session.status, state: "waiting-mobile", qrUrl: session.qrUrl };
            emit(session);
          }
          // 信令保活：30s ping；75s 无 pong 判定半开，废弃重建。
          if (!signalingPing) {
            signalingPing = setInterval(() => {
              if (activeSession !== session || session.ws !== ws) {
                if (signalingPing) clearInterval(signalingPing);
                signalingPing = null;
                return;
              }
              if (Date.now() - lastPongAt > 75_000) {
                logger.warn("[zcode-go-mobile-bridge] 信令 pong 超时，判定半开连接，重建", { token });
                if (signalingPing) clearInterval(signalingPing);
                signalingPing = null;
                session.ws = null;
                try {
                  ws.close();
                } catch {
                  /* 尽力而为 */
                }
                signalingReconnectAttempts = 0;
                setTimeout(connectSignaling, 1000);
                return;
              }
              try {
                ws.send(JSON.stringify({ t: "ping" }));
              } catch {
                /* onclose 会接管重连 */
              }
            }, 30_000);
          }
          // 房间滑动续期：会话存续期间每 2 分钟探活，二维码长期可扫。
          // 单次失败不中断会话（既有连接不依赖信令）；连续重试仍失败只记
          // 日志——房间 TTL 5 分钟 > 心跳周期，恢复后首跳即续上。
          if (!session.roomHeartbeat) {
            session.roomHeartbeat = setInterval(() => {
              void postRoomPing(3).then((response) => {
                if (!response && activeSession === session) {
                  logger.warn("[zcode-go-mobile-bridge] 房间心跳失败（重试后仍失败）", { token });
                }
              });
            }, 120_000);
          }
        };
        ws.onmessage = (event) => {
          if (activeSession !== session) return;
          let message: { t?: string; r?: unknown; i?: unknown; data?: unknown };
          try {
            message = JSON.parse(String(event.data)) as {
              t?: string;
              r?: unknown;
              i?: unknown;
              data?: unknown;
            };
          } catch {
            return;
          }
          if (message.t === "pong") {
            lastPongAt = Date.now();
            return;
          }
          const requestId = typeof message.r === "string" ? message.r : "";
          if (message.t === "req-offer" && requestId) {
            allocateOfferForRequest(requestId, ws);
          } else if (message.t === "answer") {
            const offerId = typeof message.i === "string" ? message.i : "";
            // 多客户端：offer 按请求分配（i 为实际窗口的 offerId）；direct 链接
            //（o=）的 answer 无 i——落到 primary 窗口。
            const entry =
              session.windows.find((w) => offerId && w.offerId === offerId) ??
              session.windows.find((w) => w.isPrimary);
            if (!entry || entry.win.isDestroyed()) return;
            session.status = { ...session.status, state: "connecting" };
            emit(session);
            entry.win.webContents.send("zcode-go-bridge-answer", message.data);
          }
        };
        ws.onclose = () => {
          if (activeSession !== session) return;
          // 该 socket 已被 pong 超时路径废弃（session.ws 指向新连接/为空），
          // 重连已另行调度——避免双重连接。
          if (session.ws !== ws) return;
          // Worker 部署/DO 重启、本机网络瞬断都会断信令；已建立的 P2P 连接
          // 不依赖信令——保留既有连接并按退避重连信令（新客户端可继续加入）。
          // 尚无 P2P 连接时同样退避重连若干次（配对初期网络抖动不该杀死会话），
          // 连续失败才放弃。
          const delay = Math.min(3000 * 2 ** signalingReconnectAttempts, 30000);
          signalingReconnectAttempts += 1;
          if (anyConnected(session) || signalingReconnectAttempts <= 5) {
            logger.warn("[zcode-go-mobile-bridge] 信令断开，退避重连", {
              token,
              retryInMs: delay,
              hasConnection: anyConnected(session),
              attempt: signalingReconnectAttempts,
            });
            session.ws = null;
            setTimeout(connectSignaling, delay);
            return;
          }
          teardown(session, "信令连接不可用：请检查本机网络后重试");
        };
        ws.onerror = () => {
          if (activeSession !== session) return;
          // undici WebSocket 出错后必触发 close，重试/放弃决策统一在 onclose。
          logger.warn("[zcode-go-mobile-bridge] 信令错误", { token });
        };
      };
      connectSignaling();
    } catch (error) {
      teardown(session, error instanceof Error ? error.message : String(error));
    }
  })();

  logger.info("[zcode-go-mobile-bridge] 配对开始", { token });
  emit(session);
  return { ...session.status };
}

export function stopMobileBridgePairing(): void {
  if (!activeSession) return;
  const session = activeSession;
  activeSession = null;
  sessionLogger?.info("[zcode-go-mobile-bridge] 配对停止（保留已连接窗口）", { token: session.token });
  if (session.roomHeartbeat) clearInterval(session.roomHeartbeat);
  // 刷新二维码：已连接客户端的桥窗口保留——preload 侧 rpc/resource 自持
  // （不依赖 main 会话状态），远端连接继续可用；仅回收未连接窗口与信令。
  for (const entry of [...session.windows]) {
    if (!entry.connected) {
      destroyEntry(session, entry);
      continue;
    }
    detachedEntries.push(entry);
  }
  while (detachedEntries.length > MAX_DETACHED_ENTRIES) {
    const oldest = detachedEntries.shift();
    if (oldest) destroyEntry(session, oldest);
  }
  try {
    session.ws?.close();
  } catch {
    /* 尽力而为 */
  }
  session.status = { state: "idle" };
  session.onStatus({ ...session.status });
}

export function getMobileBridgeStatus(): MobileBridgeStatus {
  return activeSession ? { ...activeSession.status } : { state: "idle" };
}
