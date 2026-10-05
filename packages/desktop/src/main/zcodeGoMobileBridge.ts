/**
 * zcode-go 移动端远程控制桥（阶段 2/3：out-of-band offer + mailbox + 资源通道
 * + preload API 透传）。
 *
 * 架构：手机（CF Worker 容器页）↔ 桌面隐藏桥窗口 P2P。Worker 仅是 answer
 * mailbox（+ QR 路径的 offer 取回）。配对两级：
 *   - 复制链接：#v=1&t=<token>&p=<secret>&o=<完整 offer（non-trickle，base64url）>
 *     ——手机本地解 offer 即刻协商，全程仅 answer 一条信令
 *   - 二维码：#v=1&t=<token>&p=<secret>&i=<offer_id>——短码经 mailbox 取回
 *     （压缩 offer 进 QR 实测过密相机扫不出；oc= 通道容器页保留）
 * 旧 trickle 路径保留（容器页 URL 无 v= 参数时走 legacy），A/B 实测后移除。
 *
 * 桥窗口（contextIsolation:true + sandbox:false + 自定义 preload，全部逻辑在
 * preload 隔离世界——node/DOM 俱全）职责：
 *   1. 持有 RTCPeerConnection（offer 侧预生成：等 ICE gathering complete）
 *      与三条 DataChannel（control/rpc/resource）；
 *   2. resource 通道 fs 直读桌面 renderer 产物分片回传（版本天然对齐）；
 *   3. 求值真实 preload bundle（伪造 contextBridge 捕获 window.zcode 原生
 *      API——映射表零维护），rpc 通道按方法名透传 invoke/订阅给远端 shim。
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
  /** 复制链接（携带完整 offer，direct 最快路径）。 */
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
  /** host 挂接（ServicePort + startup relay）是否完成。 */
  hostAttached: boolean;
  hostAttachTimer: NodeJS.Timeout | null;
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
  if (session.hostAttachTimer) clearTimeout(session.hostAttachTimer);
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
      // 早于手机连接——那时的 rpcReply 会因通道未开而入队等待。
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

var adoptedPorts = typeof WeakSet === "function" ? new WeakSet() : null;
function adoptPort(port, payload, portType) {
  // 直连 ipcRenderer 与 window 消息两条路可能对同一物理端口各触发一次：
  // 首个收养者独占（onmessage 覆盖会撕裂数据流）。
  if (adoptedPorts) {
    if (adoptedPorts.has(port)) return;
    adoptedPorts.add(port);
  }
  var streamId = ++portSeq;
  portStreams.set(streamId, port);
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
      adoptPort(port, { databaseStartupId: event.data.databaseStartupId }, "service");
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

// 直接订阅启动面（不经求值 bundle 的尾部注册——实测其 ipcRenderer 监听
// 在本桥窗口不可靠，改为双保险直连）：main 经 webContents.send/postMessage
// 投递的 DatabaseStartupState 与 ServicePort 端口在此直接接收。
ipcRenderer.on(WIN_CHANNELS.DatabaseStartupState, function (_event, raw) {
  rpcReply({ kind: "win-msg", winType: "DatabaseStartupState", data: raw });
});
ipcRenderer.on(WIN_CHANNELS.ServicePort, function (event, payload) {
  var port = event.ports && event.ports[0];
  if (!port) return;
  var parsed = payload && typeof payload === "object" ? payload : {};
  adoptPort(port, { databaseStartupId: parsed.databaseStartupId }, "service");
});
ipcRenderer.on(WIN_CHANNELS.ScopedServicePort, function (event, payload) {
  var scopedPort = event.ports && event.ports[0];
  if (!scopedPort) return;
  var scopedPayload = payload && typeof payload === "object" ? payload : {};
  adoptPort(
    scopedPort,
    {
      attachmentId: scopedPayload.attachmentId,
      sessionId: scopedPayload.sessionId,
      target: scopedPayload.target,
    },
    "scoped",
  );
});

// ── rpc 通道：远端 shim 按方法名透传 invoke/事件订阅 ──
function rpcReply(payload) {
  var text;
  try {
    text = JSON.stringify(payload);
  } catch (e) {
    return;
  }
  var dc = channels.rpc;
  if (!dc || dc.readyState !== "open") {
    // 手机尚未连接：缓冲（上限防泄漏），rpc 通道 open 时冲刷。
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

export function startMobileBridgePairing(
  logger: MobileBridgeLogger,
  onStatus: (status: MobileBridgeStatus) => void,
  /** 挂接现有 host（ServicePort + startup relay）到桥窗口，由 app 侧提供。 */
  attachHost?: (win: BrowserWindow) => boolean,
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
    hostAttached: false,
    hostAttachTimer: null,
  };
  activeSession = session;

  const { htmlPath, preloadPath } = writeBridgeWindowFiles();
  session.bridgeWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      // 全部桥逻辑在 preload 隔离世界（node/DOM 俱全）；真实 preload 的
      // contextBridge 也只有在此形态下才能被求值捕获。
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      // 隐藏窗口会被节流（计时器暂停会拖慢 8s gathering 兜底），关掉。
      backgroundThrottling: false,
    },
  });
  const bridgeWindow = session.bridgeWindow;
  // 桥窗口 preload 的 console/异常唯一可见出口（隐藏窗口，否则静默）。
  bridgeWindow.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) logger.warn("[zcode-go-bridge-page]", { level, message: message.slice(0, 300) });
  });
  bridgeWindow.webContents.on("render-process-gone", (_event, details) => {
    logger.warn("[zcode-go-mobile-bridge] 桥渲染进程异常退出", { token, reason: details.reason });
  });

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
      // 二维码：短码形态（offer_id 经 mailbox 取回）。压缩 offer 进二维码
      // （oc=，~1.0KB）虽低于 QR 字节上限，但 ~117 模块在对话框尺寸下过密、
      // 相机扫不出（真机实测）——短码 ~95B（5px+/模块）可靠秒扫，代价仅
      // 一次信令往返（desktop WS 在线，DO 即时转发）。复制链接仍为 o= direct。
      session.qrUrl = `${origin}/#v=1&t=${token}&p=${secret}&i=${session.offerId}`;
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
    } else {
      // 未知桥事件统一记录（诊断透传：TEST 探针/未来新增事件不静默）。
      logger.info("[zcode-go-mobile-bridge] 桥事件", {
        token,
        kind: payload.kind,
        detail: JSON.stringify(payload).slice(0, 200),
      });
    }
  };
  ipcMain.on("zcode-go-bridge-event", onBridgeEvent);

  const sendToBridge = (channel: string, data: unknown): void => {
    if (activeSession !== session || !bridgeWindow || bridgeWindow.isDestroyed()) return;
    bridgeWindow.webContents.send(channel, data);
  };

  bridgeWindow.webContents.once("did-finish-load", () => {
    // 挂接现有 host：远端 UI 的 boot 门禁需要 ServicePort（服务层数据通道）
    // 与 DatabaseStartupState 事件——两者都只投递给走 createWindow 生命周期
    // 的窗口，桥窗口须手动补挂（preload 的监听器已随页面加载就位）。
    if (attachHost) {
      let attempts = 0;
      const tryAttach = (): void => {
        if (activeSession !== session || session.hostAttached) return;
        attempts += 1;
        let attached = false;
        try {
          attached = attachHost(bridgeWindow);
        } catch (error) {
          logger.warn("[zcode-go-mobile-bridge] host 挂接异常", {
            token,
            error: String(error),
          });
        }
        if (attached) {
          session.hostAttached = true;
          logger.info("[zcode-go-mobile-bridge] host 已挂接桥窗口", { token });
          return;
        }
        if (attempts >= 30) {
          logger.warn("[zcode-go-mobile-bridge] host 未就绪，远端界面将卡在启动门禁", {
            token,
          });
          return;
        }
        session.hostAttachTimer = setTimeout(tryAttach, 1000);
      };
      tryAttach();
    }
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
