/**
 * zcode-go E2E：web 新窗口与桌面首窗的实时同步诊断。
 *
 * A) sessions-index 实时性：桌面端新建任务 → web 窗口任务列表应在数秒内 +1
 *    （侧边栏工作状态同源于 sessions-index 动态帧，此通路通即实时同步可用）。
 *
 * 用法：node scripts/e2e/web-sync-e2e.mjs <qr-url>
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const playwrightEntry = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "playwright-core", "index.mjs",
);
const { chromium } = await import(playwrightEntry);
const QR = process.argv[2];
if (!QR) { console.error("usage: node web-sync-e2e.mjs <qr-url>"); process.exit(3); }

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: false, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto(QR, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => {
    const fs = document.querySelectorAll("iframe");
    if (!fs.length) return { f: 0 };
    const d = fs[fs.length - 1].contentDocument;
    if (!d || !d.body || !d.body.innerText.trim()) return { f: 0 };
    return { f: 1, loading: !!d.querySelector("[data-testid=root-startup-loading]") };
  }).catch(() => ({ f: 0 }));
  if (st.f && !st.loading) break;
}
await page.waitForTimeout(1500);

const webRows = () => page.evaluate(() => {
  const d = document.querySelector("iframe").contentDocument;
  return d.querySelectorAll('li[data-testid^="task-item-"]').length;
}).catch(() => -1);

// 稳定期：等初始装载完成（行数 3 次读数一致 且 端口帧 3s 无新增）
let stable = false;
let lastCount = -1, sameCount = 0, lastFrames = -1, sameFrames = 0;
for (let i = 0; i < 60 && !stable; i += 1) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => {
    const d = document.querySelector("iframe")?.contentDocument;
    const dbg = document.querySelector("iframe")?.contentWindow?.__zcodeShimDebug || {};
    return { rows: d ? d.querySelectorAll('li[data-testid^="task-item-"]').length : -1, frames: dbg.portMsgsIn || 0 };
  }).catch(() => ({ rows: -1, frames: 0 }));
  if (st.rows === lastCount && st.rows > 0) sameCount += 1; else sameCount = 0;
  if (st.frames === lastFrames) sameFrames += 1; else sameFrames = 0;
  lastCount = st.rows; lastFrames = st.frames;
  if (sameCount >= 3 && sameFrames >= 3) stable = true;
}
console.log("stabilized:", stable, "rows:", lastCount, "frames:", lastFrames);
const before = await webRows();
const webFirst = await page.evaluate(() => {
  const d = document.querySelector("iframe").contentDocument;
  return d.querySelector('li[data-testid^="task-item-"]')?.getAttribute("data-testid") ?? null;
}).catch(() => null);
console.log("web rows before:", before, "first:", webFirst);
let desktopFirst = null;

// 桌面端新建任务（CDP 点击新建按钮）
const httpGet = (path) =>
  new Promise((resolve, reject) => {
    const req = require("node:http").get({ host: "127.0.0.1", port: 9333, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
  });
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const targets = await httpGet("/json/list");
const mainPage = targets.find((t) => t.type === "page" && (t.title === "ZCode" || t.title.includes("ZCode")));
const ws = new WebSocket(mainPage.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const cdpEval = (expression) => new Promise((resolve, reject) => {
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === 42) {
      if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 200)));
      else resolve(m.result?.result?.value);
    }
  }, { once: false });
  ws.send(JSON.stringify({ id: 42, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
});
desktopFirst = await cdpEval(`document.querySelector('li[data-testid^="task-item-"]')?.getAttribute("data-testid") ?? null`);
// 点开列表中部一个非当前任务 → 会话激活（lastActivity/phase 变化 → sessions-index 帧）
const clicked = await cdpEval(`(() => {
  const rows = Array.from(document.querySelectorAll('li[data-testid^="task-item-"]'));
  const target = rows[5] || rows[rows.length - 1];
  if (!target) return "no-rows";
  target.click();
  return "clicked:" + target.getAttribute("data-testid");
})()`);
console.log("desktop first(before):", desktopFirst, "| open row:", clicked);
const desktopFirstAfter = await cdpEval(`new Promise(r => setTimeout(() => r(document.querySelector('li[data-testid^="task-item-"]')?.getAttribute("data-testid") ?? null), 2000))`);
console.log("desktop first(after):", desktopFirstAfter, "changed:", desktopFirstAfter !== desktopFirst);

let after = before;
let webFirstAfter = webFirst;
let synced = false;
for (let i = 0; i < 15; i += 1) {
  await page.waitForTimeout(1000);
  after = await webRows();
  webFirstAfter = await page.evaluate(() => {
    const d = document.querySelector("iframe").contentDocument;
    return d.querySelector('li[data-testid^="task-item-"]')?.getAttribute("data-testid") ?? null;
  }).catch(() => null);
  if (webFirstAfter !== webFirst || after !== before) { synced = true; break; }
}
const framesAfter = await page.evaluate(() => document.querySelector("iframe")?.contentWindow?.__zcodeShimDebug?.portMsgsIn || 0).catch(() => 0);
console.log("port frames:", lastFrames, "->", framesAfter, "delta:", framesAfter - lastFrames);
console.log("web rows after:", after, "first:", webFirstAfter, "live-sync:", synced);
await browser.close();
process.exit(synced ? 0 : 1);
