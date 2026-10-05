/**
 * zcode-go 移动端桥 Worker：信令（DO 房间）+ 容器页。
 *
 * 阶段 1：容器页仅完成信令 + WebRTC DataChannel 连接验证（echo）。
 * 阶段 2 起：容器页注册 Service Worker，UI 静态资源经 DataChannel 从桌面
 * 拉取并写入 Cache Storage（本 Worker 不托管任何 UI 资源——版本由桌面端
 * 推送的产物天然对齐）。
 *
 * 路由：
 *   POST /api/rooms            { token }  桌面端登记房间（格式校验 + TTL 回执）
 *   GET  /api/signal/:token    ?role=desktop|mobile → DO WebSocket 升级
 *   GET  /  |  /#:token        容器页
 */
import { SignalRoom } from "./room.js";

export { SignalRoom };

interface Env {
  SIGNAL_ROOM: DurableObjectNamespace<SignalRoom>;
  ROOM_CREATE_LIMIT: RateLimit;
}

const TOKEN_PATTERN = /^[a-z2-9]{6,12}$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/rooms" && request.method === "POST") {
      // 每 IP 限频（CF 原生 rate limiting binding，免费额度内）：防陌生人刷配对
      // 把当天免费配额耗尽导致其他用户不可用（免费计划超额只限流不扣费）。
      const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const limited = await env.ROOM_CREATE_LIMIT.limit({ key: clientIp });
      if (!limited.success) {
        return jsonResponse({ ok: false, error: "rate_limited" }, 429);
      }
      let token = "";
      try {
        const body = (await request.json()) as { token?: unknown };
        if (typeof body.token === "string") token = body.token.trim().toLowerCase();
      } catch {
        return jsonResponse({ ok: false, error: "bad_json" }, 400);
      }
      if (!TOKEN_PATTERN.test(token)) {
        return jsonResponse({ ok: false, error: "bad_token" }, 400);
      }
      // 房间懒创建：DO idFromName(token) 确定性派生，登记端点只做校验回执。
      const stub = env.SIGNAL_ROOM.get(env.SIGNAL_ROOM.idFromName(token));
      await stub.fetch(`https://room/ping`, { method: "POST" });
      return jsonResponse({
        ok: true,
        token,
        signalUrl: `${url.origin}/api/signal/${token}`,
        // 与 DO 内 ROOM_TTL_MS 对齐（毫秒）。
        expiresAt: Date.now() + 5 * 60_000,
      });
    }

    const signalMatch = path.match(/^\/api\/signal\/([a-z2-9]{6,12})$/);
    if (signalMatch) {
      const stub = env.SIGNAL_ROOM.get(env.SIGNAL_ROOM.idFromName(signalMatch[1]!));
      // WebSocket upgrade 请求必须原样转发给 DO（CF runtime 要求；重建 Request
      // 会破坏 upgrade 语义）。DO 端用 role 查询参数区分角色，ping 探活用
      // 独立方法标记。
      return stub.fetch(request);
    }

    // /app/* 是桌面版 UI 的虚拟路径：正常由已注册的 Service Worker 拦截并从
    // 桌面经 DataChannel 取资源；能落到这里说明 SW 未就绪（注册失败/被卸载）。
    if (path.startsWith("/app/")) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
         <body style="font:15px system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0b0e14;color:#e6e9ef">
         <div>界面资源代理未就绪，请返回配对页重新连接。</div></body>`,
        { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (path === "/sw.js") {
      // Service Worker：拦截 /app/* 静态资源请求——cache-first，miss 时经
      // MessageChannel 请求主页面（其持有 resource DataChannel）向桌面取。
      return new Response(serviceWorkerScript(), {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (path === "/" || path === "/index.html") {
      return new Response(containerPage(url.origin), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // 容器页是引导壳，禁止缓存（迭代与热重载阶段尤其重要；体积 KB 级）。
          "cache-control": "no-store",
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** 容器页：极小引导壳（KB 级）。token 从 hash/query 取，连信令、建 PeerConnection、验证 DataChannel。 */
function containerPage(origin: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>ZCode Go</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.6 system-ui, sans-serif; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #0b0e14; color: #e6e9ef; }
  .card { max-width: 420px; width: calc(100% - 48px); padding: 28px; border-radius: 16px; background: #141925; border: 1px solid #232b3d; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
  h1 { font-size: 17px; margin: 0 0 6px; }
  p { margin: 6px 0; color: #9aa4b8; font-size: 13px; }
  .status { margin-top: 14px; padding: 10px 12px; border-radius: 10px; background: #1b2233; font-size: 13px; }
  .status.ok { color: #5dd6a8; }
  .status.err { color: #ff8f8f; }
  .spin { display: inline-block; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .retry { margin-top: 14px; width: 100%; padding: 10px 14px; border-radius: 10px; border: 1px solid #34405e; background: #1d2740; color: #e6e9ef; font-size: 14px; }
  .meta { margin-top: 10px; font-size: 11px; color: #5a6478; }
</style>
</head>
<body>
<div class="card">
  <h1 id="title">ZCode Go · 移动端连接</h1>
  <p id="hint">正在建立与桌面的连接…</p>
  <div class="status" id="status"><span class="spin">◐</span> 连接中…</div>
  <div class="meta" id="meta"></div>
  <button class="retry" id="retry" style="display:none">重试</button>
</div>
<script>
(function () {
  var ICE_TIMEOUT_MS = 30000;
  var $ = function (id) { return document.getElementById(id); };
  var setStatus = function (text, cls) { var el = $("status"); el.textContent = text; el.className = "status" + (cls ? " " + cls : ""); };

  var LOCALE = (navigator.language || "zh").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  var STRINGS = {
    zh: {
      noToken: "缺少配对码。请回到桌面端重新生成二维码。",
      connecting: "正在建立与桌面的连接…",
      waitingDesktop: "已连接信令，等待桌面端…",
      negotiating: "正在协商 P2P 通道…",
      connected: "已连接到桌面（P2P 已建立），正在加载界面…",
      loading: "正在加载桌面界面…",
      p2pFailed: "无法建立 P2P 连接。当前网络可能限制了 WebRTC，请尝试切换 Wi-Fi / 蜂窝网络或关闭 VPN。",
      peerLeft: "桌面端已断开。请回到桌面端重新生成。",
      roomExpired: "配对码已过期。请回到桌面端重新生成。",
      conflict: "这个配对码已被其他页面使用，请关闭旧页面后重新扫码。",
      badSecret: "配对密钥不正确。请使用桌面端最新生成的链接或二维码。",
      retry: "重试",
      stage: { boot: "", "ws-creating": "连接信令", "ws-open": "信令已连接", "req-offer": "获取连接信息", "answer-wait": "等待确认" },
    },
    en: {
      noToken: "Missing pairing token. Generate a new QR code on the desktop app.",
      connecting: "Connecting to your desktop…",
      waitingDesktop: "Signaling connected. Waiting for desktop…",
      negotiating: "Negotiating the P2P channel…",
      connected: "Connected to desktop (P2P established), loading UI…",
      loading: "Loading desktop UI…",
      p2pFailed: "Could not establish a P2P connection. Your network may restrict WebRTC — try switching Wi-Fi / cellular or disabling VPN.",
      peerLeft: "Desktop disconnected. Generate a new QR code on desktop.",
      roomExpired: "Pairing code expired. Generate a new one on desktop.",
      conflict: "This pairing code is already used by another page. Close it and scan again.",
      badSecret: "Pairing secret mismatch. Use the latest link or QR from desktop.",
      retry: "Retry",
      stage: { boot: "", "ws-creating": "connecting signaling", "ws-open": "signaling connected", "req-offer": "fetching offer", "answer-wait": "awaiting confirm" },
    },
  };
  var T = STRINGS[LOCALE];

  // ── URL 解析（hash/query 双取）──
  var params = new URLSearchParams(location.search);
  var hashRaw = (location.hash || "").replace(/^#/, "");
  var hashParams = new URLSearchParams(hashRaw);
  var get = function (k) { return hashParams.get(k) || params.get(k) || ""; };
  var TOKEN = get("t");
  var SECRET = get("p");
  var OFFER_B64 = get("o");
  var OFFER_ID = get("i");
  var MODE = OFFER_B64 ? "direct" : (OFFER_ID ? "mailbox" : "legacy");

  var STAGE = "boot";
  function setStage(x) { STAGE = x; $("meta").textContent = T.stage[x] || x; }

  window.addEventListener("error", function (e) {
    $("meta").textContent = "js-error: " + (e.message || "unknown") + " @ " + (e.filename || "") + ":" + (e.lineno || 0);
  });
  window.addEventListener("unhandledrejection", function (e) {
    $("meta").textContent = "promise-error: " + String((e.reason && e.reason.message) || e.reason || "unknown");
  });
  function fail(message) {
    setStatus(message, "err");
    $("hint").textContent = "";
    $("retry").style.display = "block";
  }

  var pc = null, ws = null, resourceDc = null, controlDc = null;
  var iceTimer = null, done = false;
  var resourceRequests = new Map();
  var resourceSeq = 0;

  function cleanup() {
    if (iceTimer) clearTimeout(iceTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
    if (pc) { try { pc.close(); } catch (e) {} }
  }

  // ── SW 注册 + /app 导航 ──
  function goToApp() {
    setStage("loading");
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(
        function () { location.href = "/app/"; },
        function () { location.href = "/app/"; },
      );
    } else {
      location.href = "/app/";
    }
  }

  // ── resource DataChannel：桌面产物拉取（SW miss 时经 message 到这里）──
  function handleResourceMessage(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.id !== "number") return;
    var entry = resourceRequests.get(msg.id);
    if (!entry) return;
    if (msg.type === "meta") {
      entry.mime = msg.mime;
      entry.status = msg.status;
      entry.chunks = [];
    } else if (msg.type === "chunk") {
      entry.chunks[msg.seq] = msg.b64;
    } else if (msg.type === "end") {
      resourceRequests.delete(msg.id);
      var binary = "";
      for (var i = 0; i < entry.chunks.length; i += 1) {
        binary += entry.chunks[i];
      }
      // atob → Uint8Array → 回给 SW（body 字符串经 postMessage 传输）。
      var bytes = atob(binary);
      var array = new Uint8Array(bytes.length);
      for (var j = 0; j < bytes.length; j += 1) array[j] = bytes.charCodeAt(j);
      entry.resolve({ body: array.buffer, mime: entry.mime, status: entry.status || 200 });
    } else if (msg.type === "error") {
      resourceRequests.delete(msg.id);
      entry.reject(msg.message || "error");
    }
  }

  // SW → 页面：/app/* 资源请求。
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.kind !== "app-resource" || !resourceDc || resourceDc.readyState !== "open") return;
      var port = event.ports[0];
      var id = ++resourceSeq;
      resourceRequests.set(id, { chunks: [] });
      var entry = resourceRequests.get(id);
      entry.resolve = function (payload) {
        if (port) port.postMessage(payload);
        else navigator.serviceWorker.controller.postMessage(payload);
      };
      entry.reject = function (err) {
        if (port) port.postMessage({ error: String(err) });
        else navigator.serviceWorker.controller.postMessage({ error: String(err) });
      };
      resourceDc.send(JSON.stringify({ id: id, path: data.url }));
    });
  }

  // ── 连接成功（DataChannel open）──
  function onConnected() {
    done = true;
    clearTimeout(iceTimer);
    setStatus(T.connected, "ok");
    $("hint").textContent = "";
    // SW 就绪后进入 /app（桌面版 UI，资源经 SW←这里←桌面）。
    setTimeout(goToApp, 400);
  }

  // ── WebRTC 协商（offer 已有：direct URL 或 mailbox 取回）──
  async function negotiate(offer) {
    setStage("negotiating" in T.stage ? "negotiating" : "answer-wait");
    setStatus(T.negotiating);
    pc = new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }],
    });
    pc.onicecandidate = function () { /* non-trickle：等 gathering complete 一次性发 */ };
    pc.ondatachannel = function (ev) {
      var label = ev.channel.label || "";
      if (label === "zcode-go-resource") {
        resourceDc = ev.channel;
        resourceDc.onmessage = function (e) { handleResourceMessage(e.data); };
      } else if (label === "zcode-go-control") {
        controlDc = ev.channel;
        controlDc.onopen = onConnected;
      }
    };
    pc.onconnectionstatechange = function () {
      setStage("pc-" + pc.connectionState);
      if (pc.connectionState === "failed") { cleanup(); fail(T.p2pFailed); }
    };
    await pc.setRemoteDescription(offer);
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    // 手机侧同样 non-trickle：等候选收齐再回（mailbox 单向，无 candidate 回传通道）。
    await new Promise(function (resolve) {
      if (pc.iceGatheringState === "complete") return resolve();
      var check = function () {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", check);
      setTimeout(resolve, 6000);
    });
    var fullAnswer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
    if (MODE === "direct" || MODE === "mailbox") {
      // 手机侧 host 候选可能秒级完成 gathering，此时信令 WS 尚在 CONNECTING——
      // 直接 send 会抛 InvalidStateError（e2e 实测）。等 open（或 3s 兜底）再发。
      await new Promise(function (resolve) {
        if (ws && ws.readyState === 1) return resolve();
        var t = setTimeout(resolve, 3000);
        ws.addEventListener("open", function () { clearTimeout(t); resolve(); }, { once: true });
      });
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: "answer", p: SECRET, i: OFFER_ID || "", data: fullAnswer }));
      }
    }
    setStage("answer-wait");
  }

  // ── 信令 ──
  function connectSignaling() {
    setStage("ws-creating");
    ws = new WebSocket(
      ORIGIN_WS + "/api/signal/" + TOKEN + "?role=mobile",
    );
    ws.onopen = function () { setStage("ws-open"); };
    ws.onmessage = async function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === "offer") {
        // mailbox 取回（QR 路径）。
        try { await negotiate(m.data); } catch (e) { cleanup(); fail(T.p2pFailed); }
      } else if (m.t === "error") {
        var code = m.data && m.data.code;
        if (code === "session_conflict") fail(T.conflict);
        else if (code === "room_expired") fail(T.roomExpired);
        else if (code === "bad_secret") fail(T.badSecret);
        else fail(T.p2pFailed);
        cleanup();
      } else if (m.t === "peer-left") {
        if (!done) { cleanup(); fail(T.peerLeft); }
      } else if (m.t === "answer-accepted") {
        setStatus(T.negotiating);
      }
    };
    ws.onclose = function () { if (!done) { cleanup(); fail(T.peerLeft); } };
    ws.onerror = function () { if (!done) { cleanup(); fail(T.p2pFailed); } };
    return ws;
  }

  function start() {
    $("retry").style.display = "none";
    if (!TOKEN) { setStage("no-token"); fail(T.noToken); return; }
    setStatus(T.connecting);
    iceTimer = setTimeout(function () { if (!done) { cleanup(); fail(T.p2pFailed); } }, ICE_TIMEOUT_MS);

    if (MODE === "direct") {
      // 最快路径：URL 里的完整 offer，本地解出即刻协商；answer 走 mailbox。
      try {
        var offerJson = atob(OFFER_B64.replace(/-/g, "+").replace(/_/g, "/"));
        var offer = JSON.parse(offerJson);
        connectSignaling();
        void negotiate(offer).catch(function () { cleanup(); fail(T.p2pFailed); });
      } catch (e) {
        fail(T.badSecret);
      }
      return;
    }
    if (MODE === "mailbox") {
      // QR 路径：连信令 → 凭 secret 请求 offer → 协商。
      connectSignaling();
      var waitOpen = function (cb) {
        if (ws.readyState === 1) cb();
        else ws.addEventListener("open", function () { cb(); }, { once: true });
      };
      waitOpen(function () {
        setStage("req-offer");
        ws.send(JSON.stringify({ t: "req-offer", p: SECRET, i: OFFER_ID }));
      });
      return;
    }
    // legacy trickle：等待 desktop 推 offer（旧协议，A/B 对照保留）。
    ws = connectSignaling();
    ws.addEventListener("message", async function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t !== "signal" || !m.data) return;
      var d = m.data;
      if (d.type === "offer") {
        pc = new RTCPeerConnection({
          iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }],
        });
        pc.onicecandidate = function (ev2) {
          if (ev2.candidate && ws.readyState === 1) {
            ws.send(JSON.stringify({ t: "signal", data: { candidate: ev2.candidate.candidate, sdpMid: ev2.candidate.sdpMid, sdpMLineIndex: ev2.candidate.sdpMLineIndex } }));
          }
        };
        pc.ondatachannel = function (ev3) {
          var label = ev3.channel.label || "";
          if (label === "zcode-go-resource") { resourceDc = ev3.channel; resourceDc.onmessage = function (e) { handleResourceMessage(e.data); }; }
          else if (label === "zcode-go-control") { controlDc = ev3.channel; controlDc.onopen = onConnected; }
        };
        pc.onconnectionstatechange = function () {
          if (pc.connectionState === "failed") { cleanup(); fail(T.p2pFailed); }
        };
        try {
          await pc.setRemoteDescription(d);
          var answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ t: "signal", data: { type: answer.type, sdp: answer.sdp } }));
          setStatus(T.negotiating);
        } catch (e) { cleanup(); fail(T.p2pFailed); }
      } else if (d.candidate && pc) {
        pc.addIceCandidate(d).catch(function () {});
      }
    });
  }

  var ORIGIN_WS = ${JSON.stringify(origin)}.replace(/^http/, "ws");
  $("retry").addEventListener("click", function () { location.reload(); });
  // 文档加载期间创建的 WebSocket 在部分嵌入浏览器（guest view）里事件会被挂起
  // （e2e 实测：升级成功但 onopen/onmessage 永不触发）——推迟到 load 后启动。
  if (document.readyState === "complete") {
    start();
  } else {
    window.addEventListener("load", function () { start(); }, { once: true });
  }
})();
</script>
</body>
</html>`;
}

/**
 * Service Worker：桌面版 UI 资源的本地代理。
 *
 * 拦截 /app/* 请求：Cache Storage 命中直接回（离线可用）；miss 时把请求经
 * MessageChannel 交给主页面（容器页——它持有 resource DataChannel），主页面
 * 从桌面拉回后经 port 回传并写缓存。资源带 content-hash，桌面升级后新 hash
 * 天然穿透缓存。
 */
function serviceWorkerScript(): string {
  return `
const APP_CACHE = "zcode-go-app-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/app/")) return;
  if (event.request.method !== "GET") return;
  event.respondWith(serveAppResource(event.request));
});

async function serveAppResource(request) {
  const cached = await caches.open(APP_CACHE).then((cache) => cache.match(request));
  if (cached) return cached;
  // miss：向主页面要（主页面经 resource DataChannel 向桌面取）。
  const response = await requestFromPage(request);
  if (response && response.ok !== false) {
    const cache = await caches.open(APP_CACHE);
    // Response body 只能消费一次，clone 后入缓存。
    cache.put(request, response.clone()).catch(() => {});
  }
  return response ?? new Response("resource unavailable", { status: 502 });
}

function requestFromPage(request) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => resolve(null), 30000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      const payload = event.data || {};
      if (payload.error) {
        resolve(new Response(payload.error, { status: 502 }));
        return;
      }
      resolve(new Response(payload.body, {
        status: payload.status ?? 200,
        headers: payload.mime ? { "content-type": payload.mime } : {},
      }));
    };
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      if (clients.length === 0) {
        clearTimeout(timeout);
        resolve(null);
        return;
      }
      clients[0].postMessage(
        { kind: "app-resource", url: new URL(request.url).pathname },
        [channel.port2],
      );
    });
  });
}
`;
}
