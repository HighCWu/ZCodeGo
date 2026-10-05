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
  button { margin-top: 14px; width: 100%; padding: 10px; border-radius: 10px; }
  .retry { margin-top: 14px; width: 100%; padding: 10px 14px; border-radius: 10px; border: 1px solid #34405e; background: #1d2740; color: #e6e9ef; font-size: 14px; }
  .echo { margin-top: 14px; display: none; }
  .echo input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid #2c3654; background: #10141f; color: #e6e9ef; font-size: 14px; }
  .echo .reply { margin-top: 8px; font-size: 13px; color: #5dd6a8; word-break: break-all; }
  code { background:#1b2233; padding:2px 6px; border-radius:6px; font-size:12px; }
</style>
</head>
<body>
<div class="card">
  <h1 id="title">ZCode Go · 移动端连接</h1>
  <p id="hint">正在建立与桌面的连接…</p>
  <div class="status" id="status"><span class="spin">◐</span> 连接中…</div>
  <div class="echo" id="echo">
    <input id="echoInput" placeholder="输入文字发送到桌面（回车）" />
    <div class="reply" id="echoReply"></div>
  </div>
  <button class="retry" id="retry" style="display:none">重试</button>
</div>
<script>
(function () {
  var ORIGIN = ${JSON.stringify(origin)};
  var ICE_TIMEOUT_MS = 30000;
  var params = new URLSearchParams(location.search);
  var token = (location.hash || "").replace(/^#/, "") || params.get("token") || "";
  var $ = function (id) { return document.getElementById(id); };
  var setStatus = function (text, cls) { var el = $("status"); el.textContent = text; el.className = "status" + (cls ? " " + cls : ""); };

  var LOCALE = (navigator.language || "zh").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  var STRINGS = {
    zh: {
      noToken: "缺少配对码。请回到桌面端重新生成二维码。",
      connecting: "正在建立与桌面的连接…",
      waitingDesktop: "已连接信令，等待桌面端…",
      negotiating: "正在协商 P2P 通道…",
      connected: "已连接到桌面（P2P 已建立）",
      p2pFailed: "无法建立 P2P 连接。当前网络可能限制了 WebRTC，请尝试切换 Wi-Fi / 蜂窝网络或关闭 VPN。",
      peerLeft: "桌面端已断开。请回到桌面端重新生成二维码。",
      roomExpired: "配对码已过期。请回到桌面端重新生成。",
      conflict: "这个配对码已被其他页面使用，请关闭旧页面后重新扫码。",
      retry: "重试",
    },
    en: {
      noToken: "Missing pairing token. Generate a new QR code on the desktop app.",
      connecting: "Connecting to your desktop…",
      waitingDesktop: "Signaling connected. Waiting for desktop…",
      negotiating: "Negotiating the P2P channel…",
      connected: "Connected to desktop (P2P established)",
      p2pFailed: "Could not establish a P2P connection. Your network may restrict WebRTC — try switching Wi-Fi / cellular or disabling VPN.",
      peerLeft: "Desktop disconnected. Generate a new QR code on desktop.",
      roomExpired: "Pairing code expired. Generate a new one on desktop.",
      conflict: "This pairing code is already used by another page. Close it and scan again.",
      retry: "Retry",
    },
  };
  var T = STRINGS[LOCALE];

  var STAGE = "boot";
  function setStage(x) { STAGE = x; try { console.log("[container] stage:", x); } catch (e) {} }
  function fail(message) {
    setStatus(message + " [" + STAGE + "]", "err");
    $("hint").textContent = "";
    $("retry").style.display = "block";
  }

  function start() {
    $("retry").style.display = "none";
    $("echo").style.display = "none";
    if (!token) { setStage("no-token"); fail(T.noToken); return; }
    setStage("ws-creating");
    setStatus(T.connecting);

    var pc = null, ws = null, dc = null, iceTimer = null, done = false;

    function cleanup() {
      if (iceTimer) clearTimeout(iceTimer);
      if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
      if (pc) { try { pc.close(); } catch (e) {} }
    }

    iceTimer = setTimeout(function () { if (!done) { cleanup(); fail(T.p2pFailed); } }, ICE_TIMEOUT_MS);

    ws = new WebSocket(ORIGIN.replace(/^http/, "ws") + "/api/signal/" + token + "?role=mobile");

    ws.onopen = function () { setStage("ws-open"); };
    ws.onerror = function () { setStage("ws-error"); };
    ws.onclose = function () { setStage("ws-close"); };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === "joined") {
        setStatus(m.data && m.data.desktopOnline ? T.negotiating : T.waitingDesktop);
      } else if (m.t === "peer-joined") {
        setStatus(T.negotiating);
      } else if (m.t === "signal" && pc) {
        var d = m.data || {};
        if (d.type === "offer") {
          pc.setRemoteDescription(d).then(function () {
            return pc.createAnswer();
          }).then(function (answer) {
            return pc.setLocalDescription(answer);
          }).then(function () {
            ws.send(JSON.stringify({ t: "signal", data: pc.localDescription }));
          }).catch(function () { cleanup(); fail(T.p2pFailed); });
        } else if (d.candidate) {
          pc.addIceCandidate(d).catch(function () {});
        }
      } else if (m.t === "peer-left") {
        if (!done) { cleanup(); fail(T.peerLeft); }
      } else if (m.t === "error") {
        var code = m.data && m.data.code;
        if (code === "session_conflict") fail(T.conflict);
        else if (code === "room_expired") fail(T.roomExpired);
        else fail(T.p2pFailed);
        cleanup();
      }
    };
    ws.onclose = function () { if (!done) { cleanup(); fail(T.peerLeft); } };
    ws.onerror = function () { if (!done) { cleanup(); fail(T.p2pFailed); } };

    setStage("pc-creating");
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
      ],
    });
    pc.onicecandidate = function (ev) {
      if (ev.candidate && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: "signal", data: ev.candidate }));
      }
    };
    pc.onconnectionstatechange = function () {
      setStage("pc-" + pc.connectionState);
      if (pc.connectionState === "failed") { cleanup(); fail(T.p2pFailed); }
    };
    pc.ondatachannel = function (ev) {
      dc = ev.channel;
      dc.onopen = function () {
        setStage("dc-open");
        done = true;
        clearTimeout(iceTimer);
        setStatus(T.connected, "ok");
        $("hint").textContent = "";
        $("echo").style.display = "block";
        $("echoInput").focus();
      };
      dc.onmessage = function (ev) {
        $("echoReply").textContent = "← " + ev.data;
      };
    };

    $("echoInput").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && dc && dc.readyState === "open") {
        dc.send($("echoInput").value);
        $("echoInput").value = "";
        $("echoReply").textContent = "";
      }
    });
  }

  $("retry").addEventListener("click", function () { location.reload(); });
  start();
})();
</script>
</body>
</html>`;
}
