// C 项定向验证：web 端发消息 → 桌面端同会话视图实时出现新回复（双向同步）
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const playwrightEntry = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "playwright-core", "index.mjs",
);
const { chromium } = await import(playwrightEntry);
const QR = process.argv[2];

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
const main = targets.find((t) => t.type === "page" && t.title === "ZCode");
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let cid = 0;
const cdpEval = (expression) => new Promise((resolve, reject) => {
  const id = ++cid;
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === id) {
      ws.removeEventListener("message", onMsg);
      if (m.result?.exceptionDetails) reject(new Error("exc"));
      else resolve(m.result?.result?.value);
    }
  };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const desktopOkCount = () => cdpEval(`(document.body.innerText.match(/\\bok\\b/g) || []).length`);

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

const before = await desktopOkCount();
console.log("desktop ok-count before:", before);

// web 端发送：playwright 原生 frame 定位器（聚焦/输入事件链由真实交互产生）
const composer = page.frameLocator("iframe").locator('[contenteditable="true"]').first();
await composer.click();
await composer.type("web 端发起的第二轮");
await page.waitForTimeout(300);
await composer.press("Enter");
console.log("web send: typed+enter");

const webOkCount = () => page.evaluate(() => {
  const d = document.querySelector("iframe")?.contentDocument;
  return d ? (d.body.innerText.match(/\bok\b/g) || []).length : -1;
}).catch(() => -1);
const webHasMyMsg = () => page.evaluate(() => {
  const d = document.querySelector("iframe")?.contentDocument;
  return d ? d.body.innerText.includes("web 端发起的第二轮") : false;
}).catch(() => false);
const webComposerEmpty = () => page.evaluate(() => {
  const d = document.querySelector("iframe")?.contentDocument;
  const ed = d?.querySelector('[contenteditable="true"]');
  return ed ? (ed.textContent || "").trim() === "" : null;
}).catch(() => null);
let ok = false;
const webBefore = await webOkCount();
for (let i = 0; i < 25; i += 1) {
  await sleep(1000);
  if ((await desktopOkCount()) > before) { ok = true; break; }
}
console.log("desktop ok-count increase:", ok);
console.log("web: my-msg-visible:", await webHasMyMsg(), "composer-empty:", await webComposerEmpty(),
  "ok-count:", webBefore, "->", await webOkCount());
await browser.close();
console.log(ok ? "WEB-SEND-SYNC-OK ✓" : "WEB-SEND-SYNC-FAIL ✗");
process.exit(ok ? 0 : 1);
