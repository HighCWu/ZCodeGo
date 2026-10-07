// 对照诊断：桌面发消息 → 同时采样两端任务行 spinner 与会话 phase
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
let cdpId = 0;
const cdpEval = (expression) => new Promise((resolve, reject) => {
  const id = ++cdpId;
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === id) {
      ws.removeEventListener("message", onMsg);
      if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 150)));
      else resolve(m.result?.result?.value);
    }
  };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const desktopSpin = () => cdpEval(`document.querySelectorAll('li[data-testid^="task-item-"] .animate-spin').length`);
const desktopSend = (text) => cdpEval(`(() => {
  const ed = document.querySelector('[contenteditable="true"]');
  if (!ed) return "no-composer";
  ed.focus();
  document.execCommand("insertText", false, ${JSON.stringify(text)});
  setTimeout(() => ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })), 120);
  return "sent";
})()`);

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
const webSpin = () => page.evaluate(() => {
  const d = document.querySelector("iframe")?.contentDocument;
  return d ? d.querySelectorAll('li[data-testid^="task-item-"] .animate-spin').length : -1;
}).catch(() => -1);

console.log("baseline — desktop spin:", await desktopSpin(), "web spin:", await webSpin());
console.log("send:", await desktopSend("spinner 对照测试"));
const samples = [];
for (let i = 0; i < 10; i += 1) {
  await sleep(600);
  samples.push(`d${await desktopSpin()}/w${await webSpin()}`);
}
console.log("during run:", samples.join(" "));
await browser.close();
process.exit(0);
