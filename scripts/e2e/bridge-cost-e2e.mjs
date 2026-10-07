/**
 * zcode-go E2E：配对会话成本模型生命周期（零空闲流量）。
 *
 * 验证（ZCODE_GO_BRIDGE_CLOSE_FUSE_MS/ZCODE_GO_BRIDGE_IDLE_MS 缩短时序）：
 *  1. 不预建：会话只在 Start 后存在；
 *  2. 对话框关闭保险丝：关窗（无连接）→ 短延时收摊为 idle；
 *  3. idle 后 Start 重建新配对码（token 变化）；
 *  4. 客户端连接后信令挂起（日志「信令挂起」，P2P 不受影响）；
 *  5. 挂起态 Start 恢复信令（日志「信令恢复」，状态仍 connected、URL 不变）；
 *  6. 客户端断开 + 空闲看门狗 → idle 收摊。
 *
 * 前置：E2E 实例（CDP 9333）需以
 *   ZCODE_GO_BRIDGE_CLOSE_FUSE_MS=3000 ZCODE_GO_BRIDGE_IDLE_MS=8000 启动。
 * 用法：node scripts/e2e/bridge-cost-e2e.mjs <log-file>
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
const playwrightEntry = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "playwright-core", "index.mjs",
);
const { chromium } = await import(playwrightEntry);
const LOG = process.argv[2] ?? "/tmp/zgbridge/e2e-restart17.log";

const httpGet = (path) =>
  new Promise((resolve, reject) => {
    const req = require("node:http").get({ host: "127.0.0.1", port: 9333, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
  });
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

async function cdpEval(expression) {
  const targets = await httpGet("/json/list");
  const page = targets.find((t) => t.type === "page" && (t.title === "ZCode" || t.title.includes("ZCode")));
  if (!page) throw new Error("main page target 未找到");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const result = await new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      if (m.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 200)));
        return;
      }
      resolve(m.result?.result?.value); // type "undefined" → undefined ✓
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  return result;
}
const bridgeCall = (expr) => cdpEval(`window.zcode.${expr}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = async () => { try { return await readFile(LOG, "utf-8"); } catch { return ""; } };

// ── 1. Start：建会话拿 token1 ──
await bridgeCall("zcodeGoMobileBridgeStart()");
let status = await bridgeCall("zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))").then(JSON.parse);
const token1 = status.token;
console.log("step1 token:", token1, "state:", status.state);

// ── 2. 关窗保险丝 → idle ──
await bridgeCall("zcodeGoMobileBridgeSetDialogVisible(false)");
let idleSeen = false;
for (let i = 0; i < 10; i += 1) {
  await sleep(1000);
  status = await bridgeCall("zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))").then(JSON.parse);
  if (status.state === "idle") { idleSeen = true; break; }
}
console.log("step2 fuse-teardown:", idleSeen);

// ── 3. Start 重建：token 稳定（持久配对身份——手机保存的链接跨会话再生效）──
await bridgeCall("zcodeGoMobileBridgeStart()");
for (let i = 0; i < 12; i += 1) {
  await sleep(1500);
  status = await bridgeCall("zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))").then(JSON.parse);
  if (status.pairingUrl) break;
}
const token2 = status.token;
console.log("step3 recreated with stable identity:", token2 === token1, "token:", token2);

// ── 4. 真客户端连接 → 信令挂起 ──
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: false, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "zh-CN" });
const page = await context.newPage();
await page.goto(status.pairingUrl, { waitUntil: "domcontentloaded" });
let connected = false;
for (let i = 0; i < 60; i += 1) {
  await sleep(2000);
  if (await page.evaluate(() => !!document.querySelector("iframe")).catch(() => false)) { connected = true; break; }
}
const logA = await readLog();
const suspended = logA.includes("信令挂起");
status = await bridgeCall("zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))").then(JSON.parse);
console.log("step4 phone-connected:", connected, "suspended:", suspended, "state:", status.state);

// ── 5. 挂起态 Start → 恢复信令，状态/URL 不变 ──
const urlBefore = status.pairingUrl;
await bridgeCall("zcodeGoMobileBridgeStart()");
await sleep(2500);
const logB = await readLog();
const resumed = logB.includes("信令恢复");
status = await bridgeCall("zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))").then(JSON.parse);
const sameUrl = status.pairingUrl === urlBefore;
console.log("step5 resumed:", resumed, "still-connected:", status.state === "connected", "same-url:", sameUrl);

// ── 6. 关闭手机页 → 空闲看门狗收摊 ──
await browser.close();
let idle2 = false;
for (let i = 0; i < 50; i += 1) {
  await sleep(1500);
  status = await bridgeCall("zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))").then(JSON.parse);
  if (status.state === "idle") { idle2 = true; break; }
}
console.log("step6 idle-watchdog-teardown:", idle2);

const pass = Boolean(
  token1 && idleSeen && token2 && token2 === token1 && connected && suspended && resumed && sameUrl && idle2,
);
console.log(pass ? "BRIDGE-COST-OK ✓" : "BRIDGE-COST-FAIL ✗");
process.exit(pass ? 0 : 1);
