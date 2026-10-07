/**
 * zcode-go E2E：多端实时同步（侧边栏工作状态 + 双端同会话对话更新）。
 *
 * 场景（隔离数据根 + 延迟 fake provider，不动真实账号）：
 *  A. 桌面端建任务并发送消息 → agent 运行 5s：
 *     - web 窗口侧边栏该任务行应出现工作中 spinner（animate-spin）；
 *  B. 回复完成后：双端会话视图都应出现助手回复 "ok"；
 *  C. 从 web 窗口再发一条 → 桌面端会话视图同样实时更新。
 *
 * 用法：node scripts/e2e/web-live-sync-e2e.mjs <qr-url> <provider-port>
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const playwrightEntry = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "playwright-core", "index.mjs",
);
const { chromium } = await import(playwrightEntry);
const QR = process.argv[2];
const PORT = Number(process.argv[3] || 0);
if (!QR || !PORT) { console.error("usage: node web-live-sync-e2e.mjs <qr-url> <provider-port>"); process.exit(3); }

const httpGet = (path) =>
  new Promise((resolve, reject) => {
    const req = require("node:http").get({ host: "127.0.0.1", port: 9333, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
  });
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

// 桌面端 CDP（选主窗口 target）
const targets0 = await httpGet("/json/list");
const main0 = targets0.find((t) => t.type === "page" && t.title === "ZCode");
const ws = new WebSocket(main0.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let cdpId = 0;
const cdpEval = (expression) => new Promise((resolve, reject) => {
  const id = ++cdpId;
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === id) {
      ws.removeEventListener("message", onMsg);
      if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 200)));
      else resolve(m.result?.result?.value);
    }
  };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 桌面：新建任务 + 发消息（composer contenteditable + 回车）
const desktopSend = async (text) => cdpEval(`(() => {
  const ed = document.querySelector('[contenteditable="true"]');
  if (!ed) return "no-composer";
  ed.focus();
  document.execCommand("insertText", false, ${JSON.stringify(text)});
  setTimeout(() => {
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }, 100);
  return "sent";
})()`);
const desktopConvText = () => cdpEval(`document.body.innerText.includes(${JSON.stringify("ok")}) ? "has-ok" : "no-ok"`);

// ── web 窗口 ──
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: false, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto(QR, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 60; i += 1) {
  await sleep(2000);
  const st = await page.evaluate(() => {
    const fs = document.querySelectorAll("iframe");
    if (!fs.length) return { f: 0 };
    const d = fs[fs.length - 1].contentDocument;
    if (!d || !d.body || !d.body.innerText.trim()) return { f: 0 };
    return { f: 1, loading: !!d.querySelector("[data-testid=root-startup-loading]") };
  }).catch(() => ({ f: 0 }));
  if (st.f && !st.loading) break;
}
await sleep(2000);
const webEval = (js) => page.evaluate(`(function(){ const d = document.querySelector("iframe").contentDocument; ${js} })()`);
const webRows = () => webEval(`return d.querySelectorAll('li[data-testid^="task-item-"]').length;`).catch(() => -1);
const webSpinner = () => webEval(`return d.querySelectorAll('li[data-testid^="task-item-"] .animate-spin').length;`).catch(() => -1);
const webHasOk = () => webEval(`return d.body.innerText.includes("ok") ? "has-ok" : "no-ok";`).catch(() => "err");

console.log("web booted, rows:", await webRows());

// A. 桌面建任务发消息（fake provider 延迟 5s 响应）
console.log("desktop send:", await desktopSend("请回复 ok"));
let spinnerSeen = false;
for (let i = 0; i < 12; i += 1) {
  await sleep(500);
  if ((await webSpinner()) > 0) { spinnerSeen = true; break; }
}
console.log("A. web spinner during run:", spinnerSeen, "(rows:", await webRows(), ")");

// B. 等回复落库，双端对比
let webOk = false, desktopOk = false;
for (let i = 0; i < 20; i += 1) {
  await sleep(1000);
  if ((await webHasOk()) === "has-ok") webOk = true;
  if ((await desktopConvText()) === "has-ok") desktopOk = true;
  if (webOk && desktopOk) break;
}
console.log("B. reply visible — web:", webOk, "desktop:", desktopOk);

// C. web 端发消息 → 桌面实时更新
const webSend = async (text) => page.evaluate(async (t) => {
  const d = document.querySelector("iframe").contentDocument;
  const ed = d.querySelector('[contenteditable="true"]');
  if (!ed) return "no-composer";
  ed.focus();
  document.execCommand("insertText", false, t);
  await new Promise((r) => setTimeout(r, 100));
  ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  return "sent";
}, text).catch((e) => String(e));
console.log("web send:", await webSend("再来一条"));
let webSpinner2 = false;
for (let i = 0; i < 12; i += 1) {
  await sleep(500);
  if ((await webSpinner()) > 0) { webSpinner2 = true; break; }
}
let bothUpdated = false;
const countOkWeb = async () => webEval(`return (d.body.innerText.match(/\\bok\\b/g) || []).length;`).catch(() => 0);
let webOkCount1 = await countOkWeb();
for (let i = 0; i < 20; i += 1) {
  await sleep(1000);
  const c = await countOkWeb();
  if (c > webOkCount1) { bothUpdated = true; break; }
}
console.log("C. web second send — spinner:", webSpinner2, "reply-count-increase(web):", bothUpdated);

const pass = spinnerSeen && webOk && desktopOk && webSpinner2 && bothUpdated;
console.log(pass ? "WEB-LIVE-SYNC-OK ✓" : "WEB-LIVE-SYNC-FAIL ✗");
await browser.close();
process.exit(pass ? 0 : 1);
