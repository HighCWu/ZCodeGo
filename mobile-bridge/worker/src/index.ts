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
import { RateLimiter } from "./ratelimit.js";

export { SignalRoom, RateLimiter };

interface Env {
  SIGNAL_ROOM: DurableObjectNamespace<SignalRoom>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  ROOM_CREATE_LIMIT: RateLimit;
  SIGNAL_CONNECT_LIMIT: RateLimit;
  PAGE_LIMIT: RateLimit;
}

/**
 * 强一致限频（RateLimiter DO，按 bucket:ip 分片固定窗）。
 * 返回 true = 放行。原生 ratelimit binding 在生产实测 fail-open，
 * 这里是权威判定层（binding 留作外层第二道，若激活则更早拦截）。
 */
async function doRateLimit(
  env: Env,
  bucket: string,
  clientIp: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${bucket}:${clientIp}`));
  const res = await stub.fetch(
    `https://rl/check?bucket=${encodeURIComponent(bucket)}&limit=${limit}&window=${windowSec}`,
  );
  try {
    const data = (await res.json()) as { allowed?: boolean };
    return data.allowed === true;
  } catch {
    return true; // 限频器自身异常时放行（可用性优先；入口另有 binding 层）
  }
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
      if (!(await doRateLimit(env, "rooms", clientIp, 5, 60))) {
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
      // 信令 WS 限频（防绕过 /api/rooms 登记限频直达 DO）：/api/signal/:token
      // 经 idFromName 懒创建 Durable Object——没有这层，随机 token 洪泛连接
      // 即可制造海量 DO（请求/CPU/持久 storage 三重刷量）。30 次/分/IP 对真实
      // 多客户端（手机 + 浏览器多开 + 断线重连）足够宽。
      const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const limited = await env.SIGNAL_CONNECT_LIMIT.limit({ key: clientIp });
      if (!limited.success) {
        return jsonResponse({ ok: false, error: "rate_limited" }, 429);
      }
      if (!(await doRateLimit(env, "signal", clientIp, 30, 60))) {
        return jsonResponse({ ok: false, error: "rate_limited" }, 429);
      }
      const stub = env.SIGNAL_ROOM.get(env.SIGNAL_ROOM.idFromName(signalMatch[1]!));
      // WebSocket upgrade 请求必须原样转发给 DO（CF runtime 要求；重建 Request
      // 会破坏 upgrade 语义）。DO 端用 role 查询参数区分角色，ping 探活用
      // 独立方法标记。
      return stub.fetch(request);
    }

    // /app/* 是桌面版 UI 的虚拟路径：正常由已注册的 Service Worker 拦截并从
    // 桌面经 DataChannel 取资源；能落到这里说明 SW 未就绪（注册失败/被卸载）。
    if (path.startsWith("/app/")) {
      // 503 文案按 Accept-Language 就地国际化（此时还没有页面 JS 可用）。
      const zh = (request.headers.get("accept-language") ?? "").toLowerCase().includes("zh");
      const body = zh
        ? "界面资源代理未就绪，请返回配对页重新连接。"
        : "UI resource proxy not ready. Go back to the pairing page and reconnect.";
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
         <body style="font:15px system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#161616;color:#e5e5e5">
         <div>${body}</div></body>`,
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

    if (path === "/" || path === "/index.html" || path === "/sw.js") {
      // 容器页/SW 宽松限频：响应本身廉价（KB 级静态），防的是脚本猛刷
      // invocation 配额（免费档打光即全员拒服）。120 次/分/IP。
      const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const limited = await env.PAGE_LIMIT.limit({ key: clientIp });
      if (!limited.success) {
        return new Response("too many requests", { status: 429 });
      }
      if (!(await doRateLimit(env, "page", clientIp, 120, 60))) {
        return new Response("too many requests", { status: 429 });
      }
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
  /* 视觉对齐 zcode 应用 zai-dark 主题：#161616 底 / #202020 卡片 /
     白 5% surface / 白 10% 边框 / 品牌白。box-sizing 重置修掉手机端
     卡片左右溢出（padding+border 曾叠加在 calc 宽度之外）。 */
  :root { color-scheme: dark; }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif;
    display: flex; min-height: 100vh; min-height: 100dvh;
    align-items: center; justify-content: center;
    background: #161616; color: #e5e5e5;
    padding: 16px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    max-width: 420px; width: 100%;
    padding: 24px; border-radius: 12px;
    background: #202020; border: 1px solid rgba(255,255,255,.1);
    box-shadow: 0 8px 30px rgba(0,0,0,.35);
    transition: opacity .35s ease;
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .mark {
    width: 28px; height: 28px; flex: none;
    display: flex; align-items: center; justify-content: center;
  }
  .mark img { width: 28px; height: 28px; display: block; }
  h1 { font-size: 16px; font-weight: 600; margin: 0; color: #fff; }
  .sub { font-size: 12px; color: rgba(255,255,255,.45); margin-top: 1px; }
  p { margin: 6px 0; color: rgba(255,255,255,.55); font-size: 13px; }
  .status {
    margin-top: 14px; padding: 10px 12px; border-radius: 10px;
    background: rgba(255,255,255,.05); font-size: 13px;
    display: flex; align-items: center; gap: 8px; line-height: 1.5;
  }
  .status.ok { color: #5dd6a8; }
  .status.err { color: #ff8f8f; }
  .ring {
    width: 13px; height: 13px; border-radius: 50%; flex: none;
    border: 2px solid rgba(255,255,255,.15); border-top-color: rgba(255,255,255,.75);
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .progress { margin-top: 10px; font-size: 12px; color: rgba(255,255,255,.4); display: none; }
  .retry {
    margin-top: 14px; width: 100%; padding: 10px 14px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.08);
    color: #fff; font-size: 14px; cursor: pointer;
  }
  .retry:active { background: rgba(255,255,255,.14); }
  .meta { margin-top: 10px; font-size: 11px; color: rgba(255,255,255,.28); word-break: break-all; }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="brand">
    <div class="mark"><img alt="ZCode Go" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAALyElEQVR4nM2aeZDU1bXHP/e3dP+6p6d7VsZtEp+ILMY4yCIjJIEqIRETXxIFNTFoZahHSIUiRqUqCwp/xCeaYMLjsUgqUQykeCaiJohJUCQuCCjPQQYxhJgYYIZZnJmeXn/bfX/8uptZehusSt6p+nV133vuvWf53nPOvb8WFKH6hgtcQBTj+SeQ7DrboRTqzCtcfcMFEkBKiQBkhlHmGVxOWzHKCpBvjdzawuPqOtsxQt4RDXVjGuxMe0Gt/0XkAm5351l9cOMQBerqx1iAlusp15SFzFjo++DfhdYpxA92d1enPrgZgNr6MTaglinyv5qcnq5ODTIK1NWPcaWUkixs8lm0FFgL0fA55DD+Qv3F+MEVQojurk5FA3ClFEPY5IgB+dsK/c6nRKG5ivUX4gfFszeImrq6od3DrC2EAJHPxIVMOWxFCdL7QChZOw0fm48yPFJ64wuQJvP1ZdoEYFkW7iCmQugphjJd11GEwLJsXNfNu3/z7mkpUVQVTdOQeQUFrbD/Ba50qa6pwe/3n5ugwETDSQ4SoKuri7SZprq6GsMIIKWLKOEBiURRVNLpNH29vaiqmtcTWiH5VVWhry/KY5s2c8MNn8NxHBSl/NRg2zaBQIBVq1bz8MNraJo8mWefeYZIJAKcS055hZcS13WxbZvPf+EmOjs7CWgauHkUKIQvicSVkmAwSCgUKlvwrABCCF7fv58NGzcQCFawfv16GhsbRzXPypX3c+DAG9TV1WM7dl6egh5AAhlLALiuW5YHssL3R6MsWfINBqJRfvjgf3JdczO2baOqxVON4zhomsYf9+zhoYceorqmFtvOLzyU8ACA7dhYto1TxuLgKdrb28s9997H0XeOcP28eay4714cx0FV1aLQyRqpp6eHpUu/ie73ZSQpvO9EpKq6YK/rujQ0NBAMBjOWHTKU4eEwa/2+vj5Onz5NdXU1r732KleMG1eWB23bRtM0vrboTn755JPU1tUVtT4U8QCAoiicPnM6B6OySIJhGDiuw8Nr1nDFuHE56xejLHS2bt3KL5/cSk1dHZZtlVxOhCNVReOiEKKo24fILiW6rtPd3c3tt93G9u3bclYtRlnv/OXkSWZcO4O0aXphs4yQLSojEVksOeVry9cPnsfS6TQXNDRw8MBBamtrcu2FSA4KFHM/+1n2vfwykaqqktDJyqxlsvzQSfMtVKI/22Gm02zauJH6+rpRQeeHDz7I3hdfpKa2FssqLvxgGURlODyaA1RB0jSd3g97uOfee/nRI4+UBZ2sgvv372fOnDn4DSOXwcslEar86Aqoqko8FuPqpqt59ZVXvNpHUUpmWykl8XiCGc3NnDjxZ4LBChzHGdXaSiZjnfcjBDiOjc+n87MtWzAMAyheKgC50mTFihUcaztKRUUIx7FHvX7+anQUpKoq/X29rH30UZqamsqGjqZpPP30TjZt2kg4UoVllQ6Z+UhUhELnrYKmafT39XHD/Pk8v2sXju2gqMWh47ouQgjOnDnD1GnT6OvrQ9f10eWawTKcrwcURZBOpxkzpoHNmzZ5WVgpnjOyIVPTNJZ8Yykd7e2EI/lDZrl3CkXOA8VJCIVUMsnWJ56gsbFxVCHzp+vWset3vyUciWAXyLZlX4gEgxVDeEsd9iQedAai/bQsXszPtmwZVchsbT3Cddc1e6uI7JGx8Jq5eO+xjqjARCAYHJULVEUlmUoyduxYDh08SCgUKlluZPE9mKcU1ADa29tpa2tj5zPPsH37dsxMiTE41IpAYBQKCG9hM51m7969zJo1qyh0JCCHVaGptOkJX2zzCYGUEsPvyzW1trby8CM/YufOp1GEgitd76LACATKVkDTNGIDAzzwwCpWrXqgLOgA/ONMB28ffY8PTneQSpsoQhTFuADcjAKNFzVw9ZVX8PFLLgJg/fr13LdiRc4TIxUYcTXgkap52XbmrFm8vHcvQoiS2daybV546VXeePMdbMdBU1VUVQFEBtMy44h86gjvXJwZN/2aTzBvdjMBw8gpoWkawm8YJT2gCAXXdfH5dA4dOsT48eNLHlDSaZNNj+/gxF8/IFQRzO0Ty7KwbQcpJYqioOsaIgOZwbaQ8lwpL6UkFktw+WWNLL7jZkKhCm699Vaefe65YTfQBUpOr0xOsXbtWsaPH49t2wWFz27Y5154ida24/h9GslUkngiQVd3D6oiuOSiMVx26SXU1kRIpVLE4nFS6RTJZIpkKkU6ncY006RSSRKJBMlkEr9f48ix99j1x30ArFq9GsMw0IYfGsTg8lp6uI/HY9x8yy0sXry4KO5d17Pq+3//B8//YR8+v04sFseVEum6fOnzc5k961oqgoHcmOhAjDU/fYwzHV0Yfh+WZWNmygpd19E1zTOKAF1TeWHPK0xtupKJEyawcMFCRkgyWB1FUTDTaS6++GI2bthQxrnW20Av/ekA0YEBwlQgJcTjCRbd9kVunDebgYEYj2/7DWe7uqmtqaZ5WhO6ppFMJEnGE0QilYy9tBEhBO0dnfR82EsgYCClRFUVogNxXtz3Bpdd+jEWLFyAVjiceaHOtm02P/YY9fX1uWuRYkc907I40taGdB0PCpZFVTjM9bNn4rouj274Ba/sfxMhIJVO86tfP0d1VQTbcZg5fQotdy6kpiqS884T23/Di/teJxgwsCyBdB2Ovnscy7b5xJVXohUSRVW9UuHu73yHG+fPR0pZMmQKITCTKbq7e3FsGzMtiCeT/NvHLiEQMOjr7+fd904QMHzMnzeH+roaXNflzf99h79/cJpvLfkaAcPgv7c8iWmaLFtyJ0tbvkrr0Xc529mNz6fj2DY9Pb2YpsWFF16Y3wNZ6Fx11VV877vfpb+/v6wDSmVlJUiJZZqYpomULpZpkk6lMkbRsG2beCzGZ2ZOY+L4cQD0RweIxWIEDIO3j7TxP0//FsdxmT6liZkzpvDxxos4efJ9wuFKTNPCMvVcIszrAdeVCEWhvb2Da6ZM8RKGEPmvoDPfJZLDb71FdXUNhuHnbGcXhuFHSpeTf/0b3T0fUldbw4xpTfzqqWf5yteXsXTxIu66YwHRaJRkMgmA3+/Htiws2yZgeJk4kUiQzhglkUhSX1eDz+ejvb09vwckEoGgu7ub0VSrra2tzJ07l0kTLufY8ffQdQ2kpKvnQzb/fBvfv28Z9yz7D6ZO/iQnTr7Pp2dei0/XqQpX8k7bcU6f6WDi+MtZ/YN7sCyLa5quoqurh7ePtKFrKrZtEU/EmTThcnRd4+jRo4X3AHiYH274c70j25566inmzZvHTfPn8vzvX0JRFKSUVEXC7P7DXlKpFDf/+3yap1/DZ2bNoL2jk9/v2cfrB95C01S+t3oNS75+B59qno6iKBw63Mrmn28jFk8QyBxVg4EAN82fixCCHTt2eDKoqioLyDQqMgyDgwcPMWnSRP5r8+Ns27GT+nrvmkQIQTyeQFVVKisrEEKQSqWJJxL4dB3DMEilUriuJFzpVbjRgVhmXj+aqtLV3cNXb/0Sy5bcxbFj7zJp0sRANqhnFRjyWkpSGkCD+VKpFCvvXwnAotu/zPSpk+nti3oJSdeprq4iFKrAth1M00bXdWprqgmFKlAUhVAoRDhcie04WLZNZWWISKQSTdPo7Y8yfepkFt3+ZQDuv3+lFEKkchZXFOUjv2bVNC/K/PjHa/n2t5cTjyd4fPuv2fXCXkzLwufTM8UcZPNMXhIgENiOg2la+HSdGz83h7u+cgsVFUF+8pN18u67lytSSm0IZBRFOfei+zwpW+auXbuW5cuXA3Ds+An2vPwax/98kuhAzMvmJepp13UJV4aYcMVYrp89k0kTvJC7bt06d/ny5aqUUhVCjLxEEkJYQghHCCHP91FVVQoh5IIFC+Thw4flYBqIxWU8npCxIk88npADsfiQcYcPH5YLFy60AaSUxe/pP4rw2UfTNCmEkH6/X7a0tMjdu3fLU6dOSdd1peu6shhleU6dOiV3794tW1papN/vz9w6yiEwLxp1hBD/L/5uU8zi/wdeLF+PUFSfuwAAAABJRU5ErkJggg=="></div>
    <div>
      <h1>ZCode Go</h1>
      <div class="sub" id="subtitle">移动端连接</div>
    </div>
  </div>
  <p id="hint">正在建立与桌面的连接…</p>
  <div class="status" id="status"><span class="ring" id="status-ring"></span><span id="status-text">连接中…</span></div>
  <div class="progress" id="progress"></div>
  <div class="meta" id="meta"></div>
  <button class="retry" id="retry" style="display:none">重试</button>
</div>
<script>
(function () {
  var ICE_TIMEOUT_MS = 30000;
  var $ = function (id) { return document.getElementById(id); };
  function setStatus(text, cls) {
    var el = $("status");
    $("status-text").textContent = text;
    el.className = "status" + (cls ? " " + cls : "");
    $("status-ring").style.display = cls === "err" ? "none" : "inline-block";
  }

  var LOCALE = (navigator.language || "zh").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  var STRINGS = {
    zh: {
      docTitle: "ZCode Go · 移动端连接",
      subtitle: "移动端连接",
      noToken: "缺少配对码。请回到桌面端重新生成二维码。",
      connecting: "正在建立与桌面的连接…",
      waitingDesktop: "已连接信令，等待桌面端…",
      negotiating: "正在协商 P2P 通道…",
      connected: "已连接到桌面（P2P 已建立）。",
      fetching: "正在获取界面资源…",
      progress: "已获取 {n} 项 · {s}",
      p2pFailed: "无法建立 P2P 连接。当前网络可能限制了 WebRTC，请尝试切换 Wi-Fi / 蜂窝网络或关闭 VPN。",
      retryAttempt: "连接超时，自动重试（{n}/2）…蜂窝网络下协商可能较慢",
      stallSlow: "弱网加载中：已获取 {n} 项 · {s}，仍在继续，请稍候…",
      desktopOffline: "桌面端不在线（信令断开或已停止配对）。请确认电脑端配对窗口仍开着，或重新生成二维码。",
      tooManyClients: "该配对码的连接数已达上限，请关闭本配对码的其它页面后重试。",
      peerLeft: "桌面端已断开。请回到桌面端重新生成。",
      roomExpired: "配对码已过期。请回到桌面端重新生成。",
      conflict: "这个配对码已被其他页面使用，请关闭旧页面后重新扫码。",
      badSecret: "配对密钥不正确。请使用桌面端最新生成的链接或二维码。",
      noSw: "当前浏览器缺少所需能力（Service Worker）。请用系统浏览器（Safari / Chrome）打开本页。",
      appNotReady: "界面加载超时。请检查网络后重试；若持续失败，请回到桌面端重新生成二维码。",
      retry: "重试",
      stall: "界面加载停滞（诊断）：状态已送达 {a}，端口 {b}，控制触发 {c}，端口重取 {d}，重复端口 {e}",
      stage: { boot: "", "ws-creating": "连接信令", "ws-open": "信令已连接", "req-offer": "获取连接信息", "answer-wait": "等待确认", fetching: "获取资源" },
    },
    en: {
      docTitle: "ZCode Go · Mobile Connect",
      subtitle: "Mobile Connect",
      noToken: "Missing pairing token. Generate a new QR code on the desktop app.",
      connecting: "Connecting to your desktop…",
      waitingDesktop: "Signaling connected. Waiting for desktop…",
      negotiating: "Negotiating the P2P channel…",
      connected: "Connected to desktop (P2P established).",
      fetching: "Fetching UI resources…",
      progress: "{n} items · {s} received",
      p2pFailed: "Could not establish a P2P connection. Your network may restrict WebRTC — try switching Wi-Fi / cellular or disabling VPN.",
      retryAttempt: "Connection timed out, retrying ({n}/2)… negotiation can be slower on cellular",
      stallSlow: "Slow network: fetched {n} items · {s}, still loading…",
      desktopOffline: "Desktop is offline (signaling dropped or pairing stopped). Make sure the desktop pairing window is still open, or regenerate the QR code.",
      tooManyClients: "Too many connections for this pairing code. Close other pages using it and retry.",
      peerLeft: "Desktop disconnected. Generate a new QR code on desktop.",
      roomExpired: "Pairing code expired. Generate a new one on desktop.",
      conflict: "This pairing code is already used by another page. Close it and scan again.",
      badSecret: "Pairing secret mismatch. Use the latest link or QR from desktop.",
      noSw: "This browser lacks required capabilities (Service Worker). Please open this page in Safari / Chrome.",
      appNotReady: "UI loading timed out. Check your network and retry; if it keeps failing, regenerate the QR code on desktop.",
      retry: "Retry",
      stall: "UI load stalled (diag): states {a}, port {b}, control {c}, port-req {d}, dup {e}",
      stage: { boot: "", "ws-creating": "connecting signaling", "ws-open": "signaling connected", "req-offer": "fetching offer", "answer-wait": "awaiting confirm", fetching: "fetching" },
    },
  };
  var T = STRINGS[LOCALE];
  document.documentElement.lang = LOCALE === "zh" ? "zh-CN" : "en";
  document.title = T.docTitle;
  $("subtitle").textContent = T.subtitle;
  $("retry").textContent = T.retry;

  // ── URL 解析（hash/query 双取）──
  var params = new URLSearchParams(location.search);
  var hashRaw = (location.hash || "").replace(/^#/, "");
  var hashParams = new URLSearchParams(hashRaw);
  var get = function (k) { return hashParams.get(k) || params.get(k) || ""; };
  var TOKEN = get("t");
  var SECRET = get("p");
  var OFFER_B64 = get("o");
  var OFFER_COMPRESSED = get("oc");
  var OFFER_ID = get("i");
  var MODE = OFFER_B64 ? "direct" : (OFFER_COMPRESSED ? "direct-compressed" : (OFFER_ID ? "mailbox" : "legacy"));

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
    $("progress").style.display = "none";
    $("retry").style.display = "block";
  }

  var pc = null, ws = null, resourceDc = null, controlDc = null, rpcDc = null;
  var REQ_ID = "";
  var ACTIVE_OFFER_ID = "";
  var iceTimer = null, done = false;
  var resourceRequests = new Map();
  var resourceSeq = 0;
  var rpcCallbacks = [];
  var resFetched = 0, resBytes = 0;

  function fmtSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }
  function renderProgress() {
    var el = $("progress");
    if (!el) return;
    el.style.display = "block";
    el.textContent = T.progress.replace("{n}", String(resFetched)).replace("{s}", fmtSize(resBytes));
  }

  // rpc DataChannel → window.__zcodeGoRpc：iframe 里的 shim 经此透传
  // invoke/事件订阅到桌面（同源 window.parent 访问）。
  // 消费前缓冲：桌面侧在 rpc 打开瞬间冲刷出站缓冲（ServicePort 等），
  // 而 shim 要等 iframe 挂载后才注册回调——先到的消息排队等待消费者。
  var rpcBuffer = [];
  var rpcConsumer = null;
  function exposeRpc() {
    window.__zcodeGoRpc = {
      post: function (text) {
        if (rpcDc && rpcDc.readyState === "open") rpcDc.send(text);
      },
      onMessage: function (cb) {
        if (rpcConsumer) {
          rpcCallbacks.push(cb);
          return;
        }
        rpcConsumer = function (text) {
          for (var i = 0; i < rpcCallbacks.length; i += 1) rpcCallbacks[i](text);
          cb(text);
        };
        rpcDc.onmessage = function (e) {
          rpcConsumer(e.data);
        };
        if (rpcBuffer.length) {
          var queued = rpcBuffer;
          rpcBuffer = [];
          for (var j = 0; j < queued.length; j += 1) rpcConsumer(queued[j]);
        }
      },
    };
    rpcDc.onmessage = function (e) {
      if (rpcConsumer) rpcConsumer(e.data);
      else if (rpcBuffer.length < 2000) rpcBuffer.push(e.data);
    };
  }

  function cleanup() {
    if (iceTimer) clearTimeout(iceTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
    if (pc) { try { pc.close(); } catch (e) {} }
  }

  // ── 连接失败自动重试 ──
  // 5G/CGNAT 下 non-trickle 全量候选协商有运气成分（手机侧 STUN binding 慢时
  // answer 只带 host 候选，必然超时）。失败不立即判死：重连信令请求一个全新
  // offer（桌面按请求另配桥窗口重新 gathering，候选重抽），最多重试 2 次。
  var retryCount = 0;
  function retryOrFail() {
    if (done) return;
    if (retryCount >= 2) { cleanup(); fail(T.p2pFailed); return; }
    retryCount += 1;
    cleanup();
    setStatus(T.retryAttempt.replace("{n}", String(retryCount)));
    iceTimer = setTimeout(function () { retryOrFail(); }, ICE_TIMEOUT_MS);
    ws = connectSignaling();
    ws.addEventListener("open", function () {
      if (done) return;
      setStage("req-offer");
      var rid = "";
      try { rid = crypto.randomUUID(); } catch (e) { rid = String(Date.now()) + Math.random(); }
      REQ_ID = rid;
      try {
        ws.send(JSON.stringify({ t: "req-offer", p: SECRET, i: OFFER_ID || ACTIVE_OFFER_ID || "", r: rid }));
      } catch (e) {}
    }, { once: true });
  }

  // ── SW 注册 + /app 挂载 ──
  // 关键：本页持有 PC/DC，绝不能导航离场（location.href 会销毁连接）——
  // 一律全屏 iframe 挂载 /app/；SW 激活并 claim 本页后挂载可避免 /app/ 请求
  // 直落 Worker 503。无 SW 能力的内嵌浏览器（微信等）给出明确指引而非自杀。
  function goToApp() {
    setStage("fetching");
    if (!("serviceWorker" in navigator)) {
      fail(T.noSw);
      return;
    }
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(
        function () { return navigator.serviceWorker.ready; },
        function () { return null; }, // 注册失败也继续（/app/ 会显示 503 文案，连接保留可诊断）
      )
      .then(function () { return waitForController(); })
      .then(mountAppFrame, mountAppFrame);
  }
  function waitForController() {
    return new Promise(function (resolve) {
      if (navigator.serviceWorker.controller) return resolve();
      var t = setTimeout(resolve, 3000);
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        function () {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
  // 挂载 /app/ iframe：先全透明覆盖（配对卡片保持在视野中并显示资源进度），
  // 探到应用启动画面（root-startup-loading）或实际根内容后再淡入交接——
  // 避免「连接成功后黑屏等资源」的空窗。
  function mountAppFrame() {
    registerProxyPort();
    setStatus(T.fetching, "ok");
    renderProgress();
    var frame = document.createElement("iframe");
    // zcode-go「在新窗口打开会话」深链：容器 URL 的 #zg-task= 原样透传给
    // /app/，shim 解析后交给 App 启动领取（其它 hash 不透传）。
    var initialHash = "";
    try {
      if (window.location.hash.indexOf("#zg-task=") === 0) initialHash = window.location.hash;
    } catch (e) {}
    frame.src = "/app/" + initialHash;
    frame.title = "ZCode Go";
    frame.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;border:0;background:transparent;z-index:9999;opacity:0;transition:opacity .35s ease";
    document.body.appendChild(frame);
    waitForAppSurface(frame, function (ready) {
      if (!ready) {
        // 超时：应用未能就绪（资源链路异常）。移除透明 iframe、保留卡片并
        // 显示失败态——绝不让用户落在黑屏上（诊断横幅另行出现）。
        frame.remove();
        fail(T.appNotReady);
        return;
      }
      frame.style.background = "#161616";
      frame.style.opacity = "1";
      var card = $("card");
      if (card) {
        card.style.opacity = "0";
        setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 400);
      }
    });
    scheduleStallDiagnostics(frame);
  }
  function waitForAppSurface(frame, cb) {
    var tries = 0;
    var lastProgress = -1;
    var stallTries = 0;
    var timer = setInterval(function () {
      tries += 1;
      var ready = false;
      try {
        var d = frame.contentDocument;
        if (d) {
          if (d.querySelector("[data-testid=root-startup-loading]")) ready = true;
          else {
            var root = d.getElementById("root");
            if (root && root.childElementCount > 0) ready = true;
          }
        }
      } catch (e) {}
      // 弱网自适应：资源仍在到货（resFetched/resBytes 有变化）就不按固定
      // 预算判死——5G 高延迟链路整包拉取可超 90s 但一直在前进（实测被硬超时
      // 误杀）。连续 ~30s 无任何新字节才判停滞，总上限 5min 兜底。
      var progress = resFetched * 4294967296 + resBytes;
      if (progress !== lastProgress) {
        lastProgress = progress;
        stallTries = 0;
      } else {
        stallTries += 1;
      }
      if (ready || stallTries > 100 || tries > 1000) {
        clearInterval(timer);
        cb(ready);
      }
    }, 300);
  }
  // 停滞诊断（真机无控制台）：挂载 30s 后仍未过启动画面，把 shim 计数摘要
  // 显示到状态行——手机上可直接看到卡在哪个环节（状态/端口/控制触发）。
  function scheduleStallDiagnostics(frame) {
    setTimeout(function () {
      try {
        var w = frame.contentWindow;
        var d = frame.contentDocument;
        if (!w || !d) return;
        if (!d.querySelector("[data-testid=root-startup-loading]")) return;
        var dbg = w.__zcodeShimDebug || {};
        var banner = document.createElement("div");
        // 资源仍在到货 = 弱网慢而非停滞：中性色 + 进度提示，避免用户误判放弃。
        if (resFetched > 0) {
          banner.textContent = T.stallSlow
            .replace("{n}", String(resFetched))
            .replace("{s}", fmtSize(resBytes));
          banner.style.cssText =
            "position:fixed;left:0;right:0;bottom:0;z-index:10000;padding:10px 14px;background:#22251f;color:#cfe6b4;font:12px/1.5 system-ui;border-top:1px solid #3f4a30";
        } else {
          banner.textContent = T.stall
            .replace("{a}", String(dbg.statesDelivered || 0))
            .replace("{b}", String(dbg.portOpens || 0))
            .replace("{c}", String(dbg.controlSeen || 0))
            .replace("{d}", String(dbg.portRequests || 0))
            .replace("{e}", String(dbg.portDuplicates || 0));
          banner.style.cssText =
            "position:fixed;left:0;right:0;bottom:0;z-index:10000;padding:10px 14px;background:#2a1f1f;color:#ffb4b4;font:12px/1.5 system-ui;border-top:1px solid #5a3030";
        }
        document.body.appendChild(banner);
      } catch (e) {}
    }, 30000);
  }

  // 页面把专用端口交给 SW：/app/* 资源请求经此发来。避免 clients.matchAll
  // 在 iframe 场景（多个 window client）选错接收方。
  function registerProxyPort() {
    var sw = navigator.serviceWorker.controller;
    if (!sw) return;
    var channel = new MessageChannel();
    channel.port1.onmessage = function (event) {
      handleProxyRequest(event.data, event.ports[0]);
    };
    sw.postMessage({ kind: "resource-proxy-ready" }, [channel.port2]);
  }
  // SW 空闲被终止后其内存里的 proxyPort 丢失（fetch 兜底路径可用但较慢）——
  // 周期性重注册让 SW 冷重启后恢复快路径（幂等，旧端口上的在途请求不受影响）。
  setInterval(registerProxyPort, 30000);

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
      // 资源进度（卡片仍在视野时显示）。
      resFetched += 1;
      resBytes += array.length;
      renderProgress();
      entry.resolve({ body: array.buffer, mime: entry.mime, status: entry.status || 200 });
    } else if (msg.type === "error") {
      resourceRequests.delete(msg.id);
      entry.reject(msg.message || "error");
    }
  }

  // SW → 页面：/app/* 资源请求（代理端口主路径；旧 matchAll 直发路径兜底）。
  function handleProxyRequest(data, port) {
    if (!data || data.kind !== "app-resource") return;
    if (!resourceDc || resourceDc.readyState !== "open") {
      if (port) port.postMessage({ error: "proxy-not-ready" });
      return;
    }
    var id = ++resourceSeq;
    var entry = { chunks: [] };
    resourceRequests.set(id, entry);
    entry.resolve = function (payload) {
      if (port) port.postMessage(payload);
    };
    entry.reject = function (err) {
      if (port) port.postMessage({ error: String(err) });
    };
    resourceDc.send(JSON.stringify({ id: id, path: data.url }));
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (event) {
      handleProxyRequest(event.data, event.ports[0]);
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
      } else if (label === "zcode-go-rpc") {
        rpcDc = ev.channel;
        exposeRpc();
      } else if (label === "zcode-go-control") {
        controlDc = ev.channel;
        controlDc.onopen = onConnected;
      }
    };
    pc.onconnectionstatechange = function () {
      setStage("pc-" + pc.connectionState);
      if (pc.connectionState === "failed") { retryOrFail(); }
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
      // 蜂窝网络 STUN binding 可达数秒：6s 收工会发出仅 host 候选的 answer，
      // 桌面侧必然连不上（5G 重扫超时实测）。放宽到 10s。
      setTimeout(resolve, 10000);
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
        ws.send(JSON.stringify({ t: "answer", p: SECRET, i: ACTIVE_OFFER_ID || OFFER_ID || "", data: fullAnswer }));
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
        // mailbox 取回（QR 路径）。记住实际分配的 offer id——多客户端并发时
        // 它不同于 URL 里的 primary id，answer 必须据此路由回正确的桥窗口。
        if (typeof m.i === "string" && m.i) ACTIVE_OFFER_ID = m.i;
        try { await negotiate(m.data); } catch (e) { retryOrFail(); }
      } else if (m.t === "error") {
        var code = m.data && m.data.code;
        if (code === "session_conflict") fail(T.conflict);
        else if (code === "room_expired") fail(T.roomExpired);
        else if (code === "bad_secret") fail(T.badSecret);
        else if (code === "desktop_offline") fail(T.desktopOffline);
        else if (code === "too_many_clients") fail(T.tooManyClients);
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
    $("hint").textContent = T.connecting;
    iceTimer = setTimeout(function () { if (!done) retryOrFail(); }, ICE_TIMEOUT_MS);

    if (MODE === "direct" || MODE === "direct-compressed") {
      // 最快路径：URL 里的完整 offer，本地解出即刻协商；answer 走 mailbox。
      // oc= 为压缩形态（候选过滤 + deflate-raw + base64url，桌面端产出），
      // 二维码与复制链接同为 direct；DecompressionStream 为原生 API，无需库。
      void (async function () {
        try {
          var offer;
          if (MODE === "direct-compressed") {
            var bin = atob(OFFER_COMPRESSED.replace(/-/g, "+").replace(/_/g, "/"));
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
            var json = await new Response(stream).text();
            offer = JSON.parse(json);
          } else {
            offer = JSON.parse(atob(OFFER_B64.replace(/-/g, "+").replace(/_/g, "/")));
          }
          connectSignaling();
          await negotiate(offer);
        } catch (e) {
          retryOrFail();
        }
      })();
      return;
    }
    if (MODE === "mailbox") {
      // QR 路径：连信令 → 凭 secret 请求 offer → 协商。r 为请求标记，
      // 多客户端并发时 desktop 按 r 把 offer 路由回本页。
      connectSignaling();
      var waitOpen = function (cb) {
        if (ws.readyState === 1) cb();
        else ws.addEventListener("open", function () { cb(); }, { once: true });
      };
      waitOpen(function () {
        setStage("req-offer");
        var rid = "";
        try { rid = crypto.randomUUID(); } catch (e) { rid = String(Date.now()) + Math.random(); }
        REQ_ID = rid;
        ws.send(JSON.stringify({ t: "req-offer", p: SECRET, i: OFFER_ID, r: rid }));
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
 * 浏览器侧 preload shim（注入到 /app/ 文档，先于 UI bundle 执行）。
 * window.zcode = Proxy：任意方法调用经容器页的 rpc DataChannel 透传到桌面
 * 桥窗口（其隔离世界里求值了真实 preload，按方法名直调原生 ipcRenderer）。
 * 约定：onXxx 且首参为函数 = 事件订阅（回调本地分发，disposer 本地退订）。
 * String.raw 纪律同容器页：无反引号、无 "${"。
 */
const SHIM_JS = String.raw`
(function () {
  if (window.zcode) return;
  // Web 远程环境旗标：UI 据此隐藏窗口装饰（最小化/最大化/关闭按钮——
  // 浏览器有自己的窗控，语义也不通）。
  window.__ZCODE_WEB_REMOTE__ = true;
  // zcode-go「在新窗口打开会话」深链：容器页把 #zg-task= 透传进 /app/，
  // 这里解析成初始会话对象供 App 启动领取（与桌面 zcodeGoTakeSessionInitial
  // 同一条路径），随后清掉 hash——刷新页面不重复触发打开。
  (function () {
    var h = window.location.hash || "";
    if (h.indexOf("#zg-task=") === 0) {
      try {
        window.__ZCODE_GO_INITIAL_TASK__ = JSON.parse(decodeURIComponent(h.slice(9)));
      } catch (e) {}
      try { history.replaceState(null, "", window.location.pathname); } catch (e) {}
    }
  })();
  // 圆角外白边修复：应用根节点带圆角且圆角外透明（桌面 vibrancy 透窗背景），
  // 浏览器默认白底会露出白边。应用 styles.css 对 html/body 有
  // background:transparent!important，注入需同类名+!important 反超；颜色取
  // 主题背景变量（亮暗自动切换，加载前深色兜底）。
  document.documentElement.classList.add("__zcode_web_remote");
  var bgStyle = document.createElement("style");
  bgStyle.textContent =
    "html.__zcode_web_remote,html.__zcode_web_remote body{background:var(--color-background,#0b0e14)!important}";
  document.head.appendChild(bgStyle);
  window.__ZCODE_DEVICE_ID__ = "";
  var parentWindow = null;
  try { parentWindow = window.parent; } catch (e) {}
  var rpc = parentWindow && parentWindow.__zcodeGoRpc ? parentWindow.__zcodeGoRpc : null;

  var seq = 0;
  var subSeq = 0;
  var pending = new Map();
  var subs = new Map();
  var streams = new Map();
  var portMsgQueue = new Map();
  // 关键时序：rpc 缓冲回放发生在 shim 初始化（head 内联脚本，页面 parsing 中）
  // ——此时应用的模块脚本（含 window message 监听注册）尚未求值。端口/状态
  // 消息必须推迟投递：DOMContentLoaded（模块脚本先于其完成）兜底，且在看到
  // 应用发出 startup-control（模块求值完毕、监听器已注册的铁证）时立即补投。
  var deferredDelivery = [];
  var bootPortMessage = null;
  // 已开过的端口流（重取竞态去重：request-port 的补投与原始 port-open 可能
  // 先后到达，重复投递会给应用第二个仿真端口）。
  var openedPortStreams = new Map();
  window.__zcodeShimDebug = { portOpens: 0, portRequests: 0, deferred: 0, flushed: 0, controlSeen: 0, statesDelivered: 0, portDuplicates: 0 };
  // 窗口消息审计（诊断用）：应用视角收到的一切带 type 消息。
  window.__winMsgLog = [];
  window.addEventListener("message", function (event) {
    try {
      if (event.data && typeof event.data === "object" && event.data.type) {
        window.__winMsgLog.push({
          t: String(event.data.type).slice(0, 40),
          self: event.source === window,
          ports: event.ports ? event.ports.length : 0,
          dbId: typeof event.data.databaseStartupId === "string" ? event.data.databaseStartupId.slice(0, 12) : undefined,
          phase: event.data.state && event.data.state.phase,
          stId: event.data.state && event.data.state.startupId ? String(event.data.state.startupId).slice(0, 12) : undefined,
          seq: event.data.state && event.data.state.sequence,
        });
        if (window.__winMsgLog.length > 100) window.__winMsgLog.shift();
      }
    } catch (e) {}
  });
  // 应用监听器审计：移除（包装应用监听器有侵入性；winMsgLog 已够诊断）。
  function deliverToWindow(fn) {
    if (document.readyState === "loading") {
      window.__zcodeShimDebug.deferred += 1;
      deferredDelivery.push(fn);
      return;
    }
    fn();
  }
  function buildBootPortDelivery(msg) {
    return function () {
      var channelPair = new MessageChannel();
      streams.set(msg.streamId, channelPair.port2);
      channelPair.port2.onmessage = function (e) {
        rpcSend({ kind: "port-msg", streamId: msg.streamId, data: encodePortData(e.data) });
      };
      channelPair.port2.start();
      // 回放早到的桌面帧：host 的 Initialize 等消息先于端口投递到达时按流
      // 排队（否则双方互等握手，服务层死锁——应用门禁通过但 UI 永不绘制）。
      var queued = portMsgQueue.get(msg.streamId) || [];
      portMsgQueue.delete(msg.streamId);
      for (var k = 0; k < queued.length; k += 1) {
        try { channelPair.port2.postMessage(decodePortData(queued[k])); } catch (e) {}
      }
      var portMessage =
        msg.portType === "service"
          ? { type: WIN_CHANNELS.ServicePort, databaseStartupId: msg.payload.databaseStartupId }
          : {
              type: WIN_CHANNELS.ScopedServicePort,
              attachmentId: msg.payload.attachmentId,
              sessionId: msg.payload.sessionId,
              target: msg.payload.target,
            };
      window.postMessage(portMessage, "*", [channelPair.port1]);
    };
  }
  function deliverBootPort() {
    if (!bootPortMessage) return;
    var fn = buildBootPortDelivery(bootPortMessage);
    bootPortMessage = null;
    try { fn(); } catch (e) {}
  }
  document.addEventListener("DOMContentLoaded", function () {
    var queued = deferredDelivery;
    deferredDelivery = [];
    window.__zcodeShimDebug.flushed += queued.length;
    for (var i = 0; i < queued.length; i += 1) {
      try { queued[i](); } catch (e) {}
    }
  });

  // ── 启动自愈看门狗 ──
  // 早期 DC 消息丢失不只发生在 WebKit：高延迟链路（5G 实测）通道 open 而
  // port-open/启动状态双双丢失——应用停在启动门禁；旧补救依赖应用自己发出
  // startup-control（其前提恰是端口已到），构成死锁。这里不依赖应用行为：
  // 每 4s 自查——缺端口就重取（桌面幂等重发，本端 streamId 去重防双端口），
  // 缺状态就主动向桌面要快照（action=snapshot 触发 main 重放当前状态）。
  // 两者到齐即停；60s 仍缺则停手（诊断横幅已展示计数）。
  if (rpc) {
    var bootWatchdogTries = 0;
    var bootWatchdog = setInterval(function () {
      bootWatchdogTries += 1;
      var dbg = window.__zcodeShimDebug;
      var needPort = !dbg.portOpens;
      var needState = !dbg.statesDelivered;
      // 应用存活（发出过 startup-control）时周期性补投端口：不止 boot 端口——
      // 会话 scoped 端口也可能在通道初期丢失（弱网实测后果：模型列表不加载、
      // 无法发消息）。桌面按 registry 全量重发 port-open，本端 streamId 去重。
      var heal = needPort || needState || dbg.controlSeen;
      if (!heal || bootWatchdogTries > 15) {
        clearInterval(bootWatchdog);
        return;
      }
      try {
        if (needPort || dbg.controlSeen) {
          dbg.portRequests += 1;
          rpcSend({ kind: "request-port" });
        }
        if (needState) {
          rpcSend({ kind: "startup-control", control: { action: "snapshot" } });
        }
      } catch (e) {}
    }, 4000);
  }

  var WIN_CHANNELS = {
    DatabaseStartupState: "zcode:database-startup-state",
    DatabaseStartupControl: "zcode:database-startup-control",
    ServicePort: "zcode:service-port",
    ScopedServicePort: "zcode:scoped-service-port",
    ScopedServicePortReady: "zcode:scoped-service-port-ready",
  };

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

  function wire() {
    rpc.onMessage(function (raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      var entry = pending.get(msg.id !== undefined ? msg.id : msg.subId);
      if (msg.kind === "result" || msg.kind === "sub-ok" || msg.kind === "sub-error") {
        if (!entry) return;
        pending.delete(msg.id);
        if (msg.kind === "result" && msg.ok) entry.resolve(msg.value);
        else if (msg.kind === "sub-ok") entry.resolve();
        else entry.reject(new Error(msg.error || ("rpc-failed:" + msg.kind)));
      } else if (msg.kind === "event") {
        var list = subs.get(msg.subId);
        if (list) {
          for (var i = 0; i < list.length; i += 1) {
            try { list[i](msg.payload); } catch (e2) {}
          }
        }
      } else if (msg.kind === "win-msg" && msg.winType === "DatabaseStartupState") {
        deliverToWindow(function () {
          window.__zcodeShimDebug.statesDelivered += 1;
          window.postMessage({ type: WIN_CHANNELS.DatabaseStartupState, state: msg.data }, "*");
        });
      } else if (msg.kind === "port-open") {
        if (openedPortStreams.has(msg.streamId)) {
          window.__zcodeShimDebug.portDuplicates += 1;
          return;
        }
        openedPortStreams.set(msg.streamId, 1);
        window.__zcodeShimDebug.portOpens += 1;
        bootPortMessage = msg;
        deliverToWindow(deliverBootPort);
      } else if (msg.kind === "port-msg") {
        var streamPort = streams.get(msg.streamId);
        if (streamPort) {
          try { streamPort.postMessage(decodePortData(msg.data)); } catch (e3) {}
        } else {
          // 流尚未建立（boot 端口投递被延迟到 DOMContentLoaded）：按流排队，
          // 建立时回放——否则 host 的 Initialize 帧丢失，握手死锁。
          var q = portMsgQueue.get(msg.streamId) || [];
          if (q.length < 2000) q.push(msg.data);
          portMsgQueue.set(msg.streamId, q);
        }
      }
    });
  }

  function rpcSend(payload) {
    rpc.post(JSON.stringify(payload));
  }

  function invoke(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      rpcSend({ kind: "invoke", id: id, method: method, args: args || [] });
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("rpc-timeout:" + method));
        }
      }, 30000);
    });
  }

  function subscribe(method, rest, subId) {
    return new Promise(function (resolve, reject) {
      pending.set(subId, { resolve: resolve, reject: reject });
      rpcSend({ kind: "subscribe", id: subId, method: method, args: rest });
    });
  }

  if (rpc) {
    wire();
    invoke("__zcodeGoMeta", []).then(function (meta) {
      if (meta && typeof meta.deviceId === "string") window.__ZCODE_DEVICE_ID__ = meta.deviceId;
    }).catch(function () {});
  }

  // UI → main 方向的 window 消息截获（真桌面里由 preload 转发；这里经 rpc）：
  // 启动控制（snapshot/retry/exit）与 scoped port 就绪 ACK。startup-control
  // 的出现同时证明应用模块已求值、监听器已注册——补投 boot 端口。
  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || typeof event.data !== "object") return;
    if (!rpc) return;
    if (event.data.type === WIN_CHANNELS.DatabaseStartupControl) {
      window.__zcodeShimDebug.controlSeen += 1;
      deliverBootPort();
      // WebKit（iOS）会丢弃通道打开早期到达的 DC 消息——冲刷的 port-open
      // 可能整体丢失（真机实测：状态送达而端口为 0）。应用发出控制消息即
      // 证明存活，此时仍未见过端口则向桌面按需重取（此时通道必然畅通）。
      if (!window.__zcodeShimDebug.portOpens) {
        window.__zcodeShimDebug.portRequests += 1;
        rpcSend({ kind: "request-port" });
      }
      rpcSend({ kind: "startup-control", control: event.data.control });
    } else if (
      event.data.type === WIN_CHANNELS.ScopedServicePortReady &&
      typeof event.data.attachmentId === "string" &&
      typeof event.data.sessionId === "string"
    ) {
      rpcSend({
        kind: "scoped-ready",
        attachmentId: event.data.attachmentId,
        sessionId: event.data.sessionId,
      });
    }
  });

  window.zcode = new Proxy({}, {
    get: function (_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "then") return undefined;
      // 本地直答（不经桌面）：web 远程的多开语义。
      if (prop === "zcodeGoOpenSessionInNewWindow") {
        return function () {
          var payload = arguments[0] || {};
          // 新 tab 复用配对 URL（query 路由）+ 目标会话参数；新 tab 作为新
          // 客户端连入（多客户端并发），其 shim 凭 ot/ow/oi 领取会话。
          // 兼容旧 hash 路由的容器页：hash 参数并入 query 再追加。
          var parent = window.parent;
          var base = String(parent.location.origin) + String(parent.location.pathname);
          var merged = [];
          var search = parent.location.search || "";
          if (search.indexOf("?") === 0) merged.push(search.slice(1));
          var hash = parent.location.hash || "";
          if (hash.indexOf("#") === 0) merged.push(hash.slice(1));
          merged.push("ot=" + encodeURIComponent(payload.taskId || ""));
          merged.push("ow=" + encodeURIComponent(payload.workspacePath || ""));
          var url = base + "?" + merged.join("&");
          if (payload.workspaceIdentity) {
            url += "&oi=" + encodeURIComponent(payload.workspaceIdentity);
          }
          parent.open(url, "_blank");
          return Promise.resolve({ ok: true });
        };
      }
      if (prop === "zcodeGoTakeSessionInitial") {
        return function () {
          var q = new URLSearchParams(window.parent.location.search);
          var ot = q.get("ot");
          var ow = q.get("ow");
          var oi = q.get("oi") || undefined;
          if (!ot || !ow) return Promise.resolve(null);
          return Promise.resolve({ taskId: ot, workspacePath: ow, workspaceIdentity: oi });
        };
      }
      return function () {
        var args = Array.prototype.slice.call(arguments);
        if (/^on[A-Z]/.test(prop) && typeof args[0] === "function") {
          var cb = args[0];
          var rest = args.slice(1);
          var subId = ++subSeq;
          subs.set(subId, [cb]);
          if (rpc) {
            subscribe(prop, rest, subId).catch(function () {});
          }
          return function () {
            subs.delete(subId);
          };
        }
        if (!rpc) return Promise.reject(new Error("rpc-not-connected:" + prop));
        return invoke(prop, args);
      };
    },
  });

  // rpc 通道可能晚于 control 打开（或重连）：迟绑定重试。
  if (!rpc) {
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      var candidate = null;
      try { candidate = window.parent && window.parent.__zcodeGoRpc; } catch (e) {}
      if (candidate) {
        rpc = candidate;
        wire();
        invoke("__zcodeGoMeta", []).then(function (meta) {
          if (meta && typeof meta.deviceId === "string") window.__ZCODE_DEVICE_ID__ = meta.deviceId;
        }).catch(function () {});
        clearInterval(timer);
      } else if (attempts > 75) {
        clearInterval(timer);
      }
    }, 200);
  }
})();
`;

/**
 * Service Worker：桌面版 UI 资源的本地代理 + preload shim 注入。
 *
 * 拦截 /app/* 请求：Cache Storage 命中直接回（离线可用）；miss 时把请求经
 * MessageChannel 交给主页面（容器页——它持有 resource DataChannel），主页面
 * 从桌面拉回后经 port 回传并写缓存。资源带 content-hash，桌面升级后新 hash
 * 天然穿透缓存。
 */
function serviceWorkerScript(): string {
  return `
const APP_CACHE = "zcode-go-app-v1";
const SHIM_SOURCE = ${JSON.stringify(SHIM_JS)};

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // 浏览器侧 preload shim（桌面 UI bundle 启动即访问 window.zcode，缺失则
  // 启动即崩——白屏）。随 Worker 部署，不经 DataChannel。
  if (url.pathname === "/app/__zcode_shim.js") {
    event.respondWith(
      new Response(SHIM_SOURCE, {
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      }),
    );
    return;
  }
  if (!url.pathname.startsWith("/app/")) return;
  if (event.request.method !== "GET") return;
  event.respondWith(serveAppResource(event.request));
});

async function serveAppResource(request) {
  const url = new URL(request.url);
  // 文档请求（/app/ 导航、index.html）不读不写缓存：桌面产物迭代后缓存里
  // 的旧 index.html 会引用已不存在的 hash 资源。hash 资源才走 cache-first。
  const isDocument =
    request.mode === "navigate" || url.pathname === "/app/" || url.pathname.endsWith("/index.html");
  if (!isDocument) {
    const cached = await caches.open(APP_CACHE).then((cache) => cache.match(request));
    if (cached) return cached;
  }
  let response = await requestFromPage(request);
  if (!response) response = new Response("resource unavailable", { status: 502 });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.indexOf("text/html") >= 0) {
    // 在首个脚本之前注入 shim：head 内联经典脚本先于模块脚本（deferred）执行。
    const text = await response.text();
    const injected = text.replace(
      /<head[^>]*>/i,
      function (head) { return head + '<script src="/app/__zcode_shim.js"></script>'; },
    );
    response = new Response(injected, {
      status: response.status,
      headers: response.headers,
    });
  }
  if (response.ok && !isDocument) {
    const cache = await caches.open(APP_CACHE);
    // Response body 只能消费一次，clone 后入缓存。
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

// 容器页注册进来的资源代理端口（页面持有 resource DataChannel）。
let proxyPort = null;
self.addEventListener("message", (event) => {
  if (event.data && event.data.kind === "resource-proxy-ready" && event.ports && event.ports[0]) {
    proxyPort = event.ports[0];
  }
});

function requestFromPage(request) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => resolve(null), 10000);
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
    const url = new URL(request.url).pathname;
    if (proxyPort) {
      proxyPort.postMessage({ kind: "app-resource", url }, [channel.port2]);
      return;
    }
    // 兜底：容器页尚未注册代理端口（时序窗口 / Worker 部署后新 SW 接管）——
    // 直接 postMessage 到容器页（pathname 为 / 的 window client；iframe 场景
    // 不能把请求发给应用 iframe 自身）。
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      if (clients.length === 0) {
        clearTimeout(timeout);
        resolve(null);
        return;
      }
      const target =
        clients.find((c) => {
          try {
            return new URL(c.url).pathname === "/";
          } catch (e) {
            return false;
          }
        }) ?? clients[0];
      target.postMessage({ kind: "app-resource", url }, [channel.port2]);
    });
  });
}
`;
}
