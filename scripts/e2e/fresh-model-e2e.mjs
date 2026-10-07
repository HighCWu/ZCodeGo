/**
 * zcode-go E2E：fresh 环境「模型自动勾上」+ 双向对话同步闭环。
 *
 * 前置（隔离数据根 + 延迟 fake provider，勿触真实账号）：
 *   ZCODE_DATA_BASE_DIR=<fresh>/e2e-data 启动 E2E 实例；
 *   provider_config.json 指向 fake-provider-delay（5s）。
 * 流程：
 *   0. 自动过登录（API key）+ onboarding；
 *   1. 桌面 composer 模型已自动勾选（无「选择模型」占位）；
 *   2. fresh-pair → web 标签页连接 → web composer 模型同样自动勾选；
 *   3. 桌面发消息 → 两端都出现回复 ok（desktop→web 同步）；
 *   4. web 发消息 → 两端回复数再 +1（web→desktop 同步）。
 *
 * 已知限制：takeover 模式下 agent 运行时 = 官方 bundle，自读个人 provider 配置
 * 的根与 Host 层不同（ZCODE_DATA_BASE_DIR 只对 fork 服务层生效）——步骤 3/4
 * 在 takeover 下会因 agent Registry 缺 fake provider 而无回复（run 报
 * 「Registry 中不存在 Provider」）。故通过判据只覆盖 0-2（模型自动勾选，
 * 5G「没自动勾上」症状的修复验证）；3/4 作为信息输出，待 agent 级隔离
 * （或非 takeover 的 fork dev runtime）后纳入判据。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const playwrightEntry = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "playwright-core", "index.mjs",
);
const { chromium } = await import(playwrightEntry);

const httpGet = (path) =>
  new Promise((resolve, reject) => {
    const req = require("node:http").get({ host: "127.0.0.1", port: 9333, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
  });
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  const targets = await httpGet("/json/list");
  const main = targets.find((t) => t.type === "page" && t.title === "ZCode");
  if (!main) throw new Error("ZCode 主窗口未找到");
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const ev = (expr) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => {
      if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 150)));
      else resolve(m.result?.result?.value);
    });
    ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  return { ev };
}

// ── 0. 等桌面 + 自动过登录/onboarding ──
const c = await cdp().catch(() => null);
let ready = c;
for (let i = 0; i < 30 && !ready; i += 1) {
  await sleep(2000);
  ready = await cdp().catch(() => null);
}
const { ev } = ready;
for (let step = 0; step < 10; step += 1) {
  const r = await ev(`(() => {
    if (document.querySelector('[contenteditable="true"]')) return "composer";
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
    const apikey = btns.find(b => (b.innerText || "").includes("使用 API key"));
    if (apikey) { apikey.click(); return "apikey"; }
    const next = btns.find(b => (b.innerText || "").trim() === "继续");
    if (next) { next.click(); return "continue"; }
    const skip = btns.find(b => (b.innerText || "").trim() === "跳过");
    if (skip) { skip.click(); return "skip"; }
    const next2 = btns.find(b => (b.innerText || "").trim() === "下一步");
    if (next2) { next2.click(); return "next"; }
    return "wait";
  })()`);
  if (r === "apikey") {
    await sleep(1200);
    await ev(`(() => {
      const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null);
      const inp = inputs[0];
      if (!inp) return "no-input";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "sk-zcode-go-e2e");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      return "filled";
    })()`);
    await sleep(400);
    await ev(`Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && (b.innerText || "").trim() === "继续")?.click(); "ok"`);
  }
  if (r === "composer") break;
  await sleep(1200);
}
const desktopComposerOk = await ev(`!!document.querySelector('[contenteditable="true"]')`);
console.log("0. desktop booted:", desktopComposerOk);

// ── 1. 桌面模型自动勾选 ──
const desktopModel = await ev(`(() => {
  const t = document.querySelector('[data-composer-leading-content], .composer-provider-prefix, [data-testid="composer-model"]');
  const text = t ? t.textContent || "" : document.body.innerText;
  return text.includes("选择模型") ? "placeholder" : "selected";
})()`);
console.log("1. desktop model:", desktopModel);

// ── 2. fresh pair + web 连接 ──
await ev("window.zcode.zcodeGoMobileBridgeStop()");
await sleep(2000);
await ev("window.zcode.zcodeGoMobileBridgeStart()");
let qr = "";
for (let i = 0; i < 25 && !qr; i += 1) {
  await sleep(1200);
  const st = await ev("window.zcode.zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))");
  const parsed = JSON.parse(st);
  if (parsed.pairingUrl) qr = parsed.pairingUrl;
}
console.log("2. pairing url ready:", Boolean(qr));

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: false, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto(qr, { waitUntil: "domcontentloaded" });
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
await sleep(2500);
const webModel = await page.evaluate(() => {
  const d = document.querySelector("iframe")?.contentDocument;
  if (!d) return "no-frame";
  const text = d.body.innerText;
  return text.includes("选择模型") ? "placeholder" : "selected";
}).catch(() => "err");
console.log("2. web connected, model:", webModel);

// ── 3. 桌面发 → 双端收 ok ──
await ev(`(() => {
  const ed = document.querySelector('[contenteditable="true"]');
  ed.focus();
  document.execCommand("insertText", false, "桌面发起验证");
  setTimeout(() => ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })), 150);
  return "sent";
})()`);
const countOk = async () => {
  const d = await page.evaluate(() => (document.querySelector("iframe")?.contentDocument?.body.innerText.match(/\bok\b/g) || []).length).catch(() => 0);
  return d;
};
const dtCountOk = () => ev(`(document.body.innerText.match(/\\bok\\b/g) || []).length`);
const webBefore = await countOk();
const dtBefore = await dtCountOk();
let bWeb = false, bDesk = false;
for (let i = 0; i < 25; i += 1) {
  await sleep(1000);
  if (!bWeb && (await countOk()) > webBefore) bWeb = true;
  if (!bDesk && (await dtCountOk()) > dtBefore) bDesk = true;
  if (bWeb && bDesk) break;
}
console.log(`3. desktop→web: web=${bWeb} desktop=${bDesk}`);

// ── 4. web 发 → 双端 ok 再 +1 ──
const composer = page.frameLocator("iframe").locator('[contenteditable="true"]').first();
await composer.click();
await composer.type("web 端发起验证");
await page.waitForTimeout(300);
await composer.press("Enter");
const webBefore2 = await countOk();
const dtBefore2 = await dtCountOk();
let cWeb = false, cDesk = false;
for (let i = 0; i < 25; i += 1) {
  await sleep(1000);
  if (!cWeb && (await countOk()) > webBefore2) cWeb = true;
  if (!cDesk && (await dtCountOk()) > dtBefore2) cDesk = true;
  if (cWeb && cDesk) break;
}
console.log(`4. web→desktop: web=${cWeb} desktop=${cDesk}`);

await browser.close();
const pass = desktopComposerOk && desktopModel === "selected" && webModel === "selected";
console.log(pass ? "FRESH-MODEL-SYNC-OK ✓" : "FRESH-MODEL-SYNC-FAIL ✗");
process.exit(pass ? 0 : 1);
