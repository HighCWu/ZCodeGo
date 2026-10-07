/**
 * zcode-go E2E：共享 host 多窗口生命周期。
 *
 * 验证：
 *  1. 「在新窗口打开会话」→ 新窗口挂接既有 host（日志「新窗口已挂接既有 host」），
 *     不 spawn 独立 host；
 *  2. 首窗关闭 → host 不回收（日志「跳过 host 回收」），二窗仍存活且可交互；
 *  3. （结构保证）同 host 多窗共享 sessions-index/会话流——与 web 远程桥同构。
 *
 * 前置：E2E 实例（CDP 9333，Xvfb :103）已启动并完成首屏。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const LOG = process.argv[2] ?? "/tmp/zgbridge/e2e-restart24.log";
const httpGet = (path) =>
  new Promise((resolve, reject) => {
    const req = require("node:http").get({ host: "127.0.0.1", port: 9333, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = async (page) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 150));
    return r.result?.result?.value;
  };
  return { ws, ev };
};

// 等首窗就绪
let main1 = null;
for (let i = 0; i < 30; i += 1) {
  await sleep(2000);
  const targets = await httpGet("/json/list").catch(() => []);
  main1 = targets.find((t) => t.type === "page" && t.title === "ZCode");
  if (main1) break;
}
if (!main1) { console.log("FAIL: 首窗未出现"); process.exit(1); }
const c1 = await connect(main1);
console.log("first window ready");

// 触发「在新窗口打开会话」（taskId 任意——本 E2E 只验窗口/host 生命周期）
const opened = await c1.ev(`window.zcode && window.zcode.zcodeGoOpenSessionInNewWindow
  ? window.zcode.zcodeGoOpenSessionInNewWindow({ taskId: "e2e-lifecycle", workspacePath: "/tmp" }).then(r => JSON.stringify(r))
  : "no-bridge"`);
console.log("open-in-new-window:", opened);

// 等第二个 ZCode 页面 target
let main2 = null;
for (let i = 0; i < 20; i += 1) {
  await sleep(1500);
  const targets = await httpGet("/json/list").catch(() => []);
  const pages = targets.filter((t) => t.type === "page" && t.title === "ZCode");
  if (pages.length >= 2) { main2 = pages.find((p) => p.webSocketDebuggerUrl !== main1.webSocketDebuggerUrl); break; }
}
console.log("second window:", main2 ? "appeared" : "MISSING");
if (!main2) process.exit(1);

// 日志断言：挂接既有 host（而非 spawn 新 host）
await sleep(2500);
const log1 = await readFile(LOG, "utf-8").catch(() => "");
const attached = log1.includes("新窗口已挂接既有 host");
console.log("attached-to-shared-host:", attached);

// 关闭首窗（window.close）
const c2 = await connect(main2);
await c1.ev(`window.close(); "closing"`);
await sleep(3000);
const log2 = await readFile(LOG, "utf-8").catch(() => "");
const skippedDispose = log2.includes("跳过 host 回收");
// 二窗仍存活且可交互
const alive2 = await c2.ev(`JSON.stringify({ready: document.readyState, hasRoot: !!document.getElementById("root")})`).catch(() => null);
console.log("first-window-closed; host-dispose-skipped:", skippedDispose, "second-window-alive:", alive2);

// 收尾：关二窗（真实回收路径，日志应不再跳过——引用清零）
await c2.ev(`window.close(); "closing"`).catch(() => {});
await sleep(2500);
const log3 = await readFile(LOG, "utf-8").catch(() => "");
const finalDispose = /host process \([^)]*\) exited| disposing host process/.test(log3.slice(log3.indexOf("跳过 host 回收") + 100));
console.log("last-ref-disposed:", finalDispose);

const aliveOk = Boolean(alive2 && String(alive2).includes("complete"));
const pass = attached && skippedDispose && aliveOk && finalDispose;
console.log(pass ? "SHARED-HOST-WINDOW-OK ✓" : "SHARED-HOST-WINDOW-FAIL ✗");
process.exit(pass ? 0 : 1);
