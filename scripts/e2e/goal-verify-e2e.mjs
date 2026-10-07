#!/usr/bin/env node
/**
 * zcode-go E2E：goal 完成复核真实闭环（HOME 级沙箱 + 脚本化假 Provider，零真人介入）。
 *
 * 隔离教训（前两轮实测）：desktop 主进程 settings 不认 ZCODE_DATA_BASE_DIR、
 * DISPLAY 继承会把窗口弹到真实桌面、provider env 覆盖会破坏 host 的 CDN builtin
 * 同步。本脚本用 HOME 沙箱一揽子解决：<ws>/home 下的一切（~/.zcode 主进程
 * settings / host personal 配置 / agent 配置与账号库 / ~/.zcode-go redirect map
 * 与 official.json）全部落在沙箱内——真实凭证与真实配置物理不可达，模型调用
 * 只可能打到假 Provider；DISPLAY 强制 :103 绝不上真实桌面。
 *
 * 流程：
 *   0. 沙箱（HOME + user-data-dir + CDP 9334）+ 假 Provider（脚本路由 + 请求日志）；
 *   1. 过 onboarding（API key）→ composer 就绪；
 *   2. composer 发 /goal <objective>；假 Provider 按路由回复驱动运行时把 goal
 *      判为 verified（路由热读，可按 provider.log 调参）；
 *   3. 等待复核链路命中：假 Provider 收到带 ZCODE_GO_GOAL_VERIFY_MARKER 的判定
 *      消息（= 边沿检测 → readSession → sendText 全链工作）；
 *   4. 判定回复 passed:false → 断言：判定消息落库（沙箱 DB part 行）+ goal
 *      重新驱动（Provider 日志出现复核之后的新请求）；
 *   5. 清理：精确杀本实例 + 删沙箱（失败保留现场）。
 *
 * 运行：node scripts/e2e/goal-verify-e2e.mjs（需 Xvfb :103 在跑）
 */
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REAL_STATE_DIR = join(homedir(), ".zcode-go");
const REPO = "/home/whc/pnpm_repos/zcode-go";
const ELECTRON = join(REAL_STATE_DIR, "electron", "zcode");
const CDP_PORT = 9334;
const PROFILE_TAG = "zg-goal-e2e-profile";
const OBJECTIVE = "把示例项目构建修绿并跑通测试";
const MARKER = "<!-- zcode-go:goal-verify";

const ws = join(tmpdir(), `zg-goal-e2e-${Date.now()}`);
const sandboxHome = join(ws, "home");
const routesPath = join(ws, "routes.json");
const providerLog = join(ws, "provider.log.jsonl");
const portFile = join(ws, "provider.port");
const appLog = join(ws, "app.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const httpGet = (path) =>
  new Promise((resolve, reject) => {
    const req = require("node:http").get({ host: "127.0.0.1", port: CDP_PORT, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
  });

function providerEntries() {
  try {
    return readFileSync(providerLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function writeRoutes(routes) {
  writeFileSync(routesPath, JSON.stringify(routes, null, 1));
}

async function cdp() {
  const targets = await httpGet("/json/list");
  const page = targets.find((t) => t.type === "page" && t.title === "ZCode");
  if (!page) return null;
  const ws0 = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws0.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const ev = (expr) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => {
      if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 200)));
      else resolve(m.result?.result?.value);
    });
    ws0.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  // CDP Input 域：可信输入事件（合成 KeyboardEvent isTrusted=false 会被编辑器忽略）
  const input = (method, params) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, () => resolve());
      ws0.send(JSON.stringify({ id: mid, method: `Input.${method}`, params }));
    });
  const trustedClick = async (x, y) => {
    await input("dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await input("dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const trustedSelectAll = async () => {
    await input("dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, text: "a" });
    await input("dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  };
  /** 点击编辑器 → 全选清空 → 输入文本（Enter 键序在 CDP+Lexical 下不稳定，
   *  提交统一走发送按钮的可信点击——与 Enter 同路径触发 form submit）。 */
  const trustedTypeAndEnterAt = async (text, x, y) => {
    await trustedClick(x, y);
    await trustedSelectAll();
    await input("insertText", { text });
    await new Promise((r) => setTimeout(r, 400));
  };
  return { ev, trustedClick, trustedTypeAndEnterAt, close: () => ws0.close() };
}

function killAppInstance() {
  // 精确杀本 E2E 实例：Electron 会把 argv 重写为应用名，cmdline 匹配不可靠——
  // 按 environ 的 HOME=沙箱路径匹配（绝不碰真实实例/second-profile）。
  for (const d of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      if (process.pid === Number(d)) continue;
      const env = readFileSync(join("/proc", d, "environ"), "utf8");
      // 前缀匹配清掉任何一轮本脚本的沙箱实例：只杀本轮会留下上轮僵尸占住
      // CDP 端口，后续运行会连到旧实例（其假 Provider 端口已死、状态混乱）。
      if (env.includes(`HOME=${join(tmpdir(), "zg-goal-e2e-")}`)) process.kill(Number(d), "SIGTERM");
    } catch { /* 进程已退/无权限 */ }
  }
}

let pass = false;
let providerProc = null;
try {
  // 前置清理：任何一轮旧沙箱实例（占 CDP 端口会劫持本轮连接）
  try { killAppInstance(); await sleep(1500); } catch { /* 尽力而为 */ }
  // ── 0. HOME 沙箱 + 假 Provider ──
  mkdirSync(join(sandboxHome, ".zcode", "v2"), { recursive: true });
  mkdirSync(join(sandboxHome, ".zcode-go"), { recursive: true });
  copyFileSync(join(REAL_STATE_DIR, "official.json"), join(sandboxHome, ".zcode-go", "official.json"));
  // builtin Active 物化种子（~/.zcode/v2/runtime/provider：纯 provider 目录，无凭证）。
  // 新沙箱没有历史 Active 缓存、组装 app 又缺 packaged builtin 文件，CDN 同步在
  // 冷启动窗口内追不上——不种会导致「Bundled 与 Active 均不可用」且发送全拒。
  const realProviderRuntime = join(homedir(), ".zcode", "v2", "runtime", "provider");
  if (existsSync(realProviderRuntime)) {
    cpSync(realProviderRuntime, join(sandboxHome, ".zcode", "v2", "runtime", "provider"), { recursive: true });
  }
  writeRoutes([
    { match: MARKER, content: '{"passed": false, "reason": "测试还没跑通，不能算完成"}' },
    { match: "(?i)goal|objective|complete|done|finish|完成", content: "我已经完成了这个目标：构建已修绿，全部测试通过。" },
  ]);
  providerProc = spawn(process.execPath, [
    join(REPO, "scripts", "e2e", "fake-provider.mjs"),
    "--port-file", portFile, "--script", routesPath, "--log", providerLog,
  ], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 50 && !port; i += 1) {
    try { port = Number(readFileSync(portFile, "utf8").trim()) || 0; } catch { /* 等待 */ }
    if (!port) await sleep(200);
  }
  if (!port) throw new Error("假 Provider 未就绪");
  // host 的 personal 配置固定读 $HOME/.zcode/v2/provider_config.json（getAppConfigDir）
  writeFileSync(join(sandboxHome, ".zcode", "v2", "provider_config.json"), JSON.stringify({
    schemaVersion: 1,
    config: {
      providerOrder: ["zcode-go-fake"],
      providerConfigRules: {
        providerRules: [{
          providerId: "zcode-go-fake",
          templateId: "openai",
          providerName: "zcode-go-fake",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "sk-zcode-go-e2e" },
            api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
            personalModelIds: [],
            modelOrder: ["fake-model"],
          },
        }],
      },
      modelConfigRules: {
        providerModelRules: [{
          providerId: "zcode-go-fake",
          modelId: "fake-model",
          config: { enabled: true, properties: { contextWindow: 128000 } },
        }],
        manualProviderModelRules: [],
      },
    },
  }));
  console.log(`0a. sandbox=${sandboxHome} fake provider port=${port}`);

  // ── 0b. 启动沙箱 E2E 实例（HOME 隔离 + DISPLAY 强制 :103） ──
  const appProc = spawn(ELECTRON, [
    `--user-data-dir=${join(ws, PROFILE_TAG)}`,
    `--remote-debugging-port=${CDP_PORT}`,
  ], {
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "zh_CN.UTF-8",
      HOME: sandboxHome,
      DISPLAY: ":103",
      ZCODE_GO_TAKEOVER: "1",
      ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Go E2E",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  appProc.stdout.on("data", (c) => appendFileSync(appLog, c));
  appProc.stderr.on("data", (c) => appendFileSync(appLog, c));
  console.log("0b. app launched (sandboxed), waiting CDP…");

  let c = null;
  for (let i = 0; i < 40 && !c; i += 1) {
    await sleep(1500);
    c = await cdp().catch(() => null);
  }
  if (!c) throw new Error("E2E 实例 CDP 未就绪（看 app.log）");
  const { ev } = c;

  // ── 1. onboarding（API key 路径） ──
  for (let step = 0; step < 14; step += 1) {
    const r = await ev(`(() => {
      if (document.querySelector('[contenteditable="true"]')) return "composer";
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
      const apikey = btns.find(b => (b.innerText || "").includes("使用 API key"));
      if (apikey) { apikey.click(); return "apikey"; }
      const next = btns.find(b => (b.innerText || "").trim() === "继续");
      if (next) { next.click(); return "continue"; }
      const skip = btns.find(b => (b.innerText || "").trim() === "跳过");
      if (skip) { skip.click(); return "skip"; }
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
  const composerOk = await ev(`!!document.querySelector('[contenteditable="true"]')`);
  console.log("1. onboarding composer:", composerOk);
  if (!composerOk) throw new Error("onboarding 未完成");

  // ── 2. 发 /goal：先可信输入文本（空编辑器的发送按钮恒禁用，就绪检查必须在输入后） ──
  await ev(`document.querySelector('[contenteditable="true"]')?.focus(); "ok"`);
  const rect = await ev(`(() => { const r = document.querySelector('[contenteditable="true"]').getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
  const { x, y } = JSON.parse(rect);
  await c.trustedTypeAndEnterAt(`/goal ${OBJECTIVE}`, x, y);
  const typed = await ev(`document.querySelector('[contenteditable="true"]')?.innerText?.includes(${JSON.stringify(OBJECTIVE)})`);
  console.log("2a. goal text in editor:", typed);
  if (!typed) throw new Error("goal 文本未进入编辑器");

  // ── 2.5 输入就位后轮询发送按钮可用（模型视图冷启动竞态：失败态点「重试」） ──
  let submitReady = false;
  for (let i = 0; i < 30 && !submitReady; i += 1) {
    const state = await ev(`(() => {
      const body = document.body.innerText;
      const retry = Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && (b.innerText || '').trim() === '重试');
      if (retry && (body.includes('模型加载失败') || body.includes('模型配置加载失败'))) { retry.click(); return 'retried'; }
      const submit = document.querySelector('[contenteditable="true"]')?.closest('form')?.querySelector('button[type="submit"]');
      if (submit && !submit.disabled) return 'ready';
      return 'wait';
    })()`);
    if (state === "ready") submitReady = true;
    await sleep(1500);
  }
  console.log("2b. submit button ready:", submitReady);
  if (!submitReady) {
    const dump = await ev(`JSON.stringify({ body: document.body.innerText.slice(0, 400) })`);
    console.log("2b not-ready dump:", dump);
    throw new Error("发送按钮未就绪（见上 dump）");
  }
  const btnRect = await ev(`(() => { const b = document.querySelector('[contenteditable="true"]')?.closest('form')?.querySelector('button[type="submit"]'); if (!b) return 'null'; const r = b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
  if (btnRect !== "null") {
    const b = JSON.parse(btnRect);
    await c.trustedClick(b.x, b.y);
  }
  await sleep(2500);
  const diag = await ev(`(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    const submit = ed?.closest('form')?.querySelector('button[type="submit"]');
    const pending = document.querySelectorAll('[data-pending-command], [data-command-chip]').length;
    return JSON.stringify({
      editorText: ed?.innerText?.slice(0, 60) ?? null,
      submitDisabled: submit?.disabled ?? null,
      bodyHasGoal: document.body.innerText.includes(${JSON.stringify(OBJECTIVE)}),
      bodySnippet: document.body.innerText.slice(0, 200),
      pending,
    });
  })()`);
  console.log("2.5 diag:", diag);
  console.log("2. /goal sent (trusted input + button)");

  // ── 3. 等复核判定消息到达 Provider（verified 边沿 → 复核链路命中） ──
  let markerEntry = null;
  for (let i = 0; i < 120 && !markerEntry; i += 1) {
    await sleep(3000);
    markerEntry = providerEntries().find((e) => (e.text || "").includes(MARKER)) ?? null;
  }
  const markerSeen = Boolean(markerEntry);
  console.log("3. judgment prompt reached provider:", markerSeen);
  if (!markerSeen) {
    console.log("   provider log tail:", providerEntries().slice(-3).map((e) => (e.text || "").slice(0, 120)));
    throw new Error("复核判定消息未到达（goal 未到 verified 或链路断裂，看 app.log/provider.log.jsonl）");
  }
  const markerAt = markerEntry.ts;

  // ── 4. passed:false → 重触发断言 ──
  const dbPath = join(sandboxHome, ".zcode", "cli", "db", "db.sqlite");
  let markerInDb = false;
  for (let i = 0; i < 10 && !markerInDb; i += 1) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const hit = db.prepare("select count(*) c from part where data like ?").get(`%${MARKER}%`);
      db.close();
      markerInDb = hit.c > 0;
    } catch { /* 等待落库 */ }
    if (!markerInDb) await sleep(2000);
  }
  console.log("4a. judgment message persisted in db:", markerInDb);

  let resumed = false;
  for (let i = 0; i < 40 && !resumed; i += 1) {
    await sleep(3000);
    resumed = providerEntries().some((e) => e.ts > markerAt + 5000 && !(e.text || "").includes(MARKER));
  }
  console.log("4b. goal resumed after retrigger:", resumed);

  pass = markerSeen && markerInDb && resumed;
} catch (error) {
  console.error("E2E 失败:", error.message);
} finally {
  try { killAppInstance(); } catch { /* 尽力而为 */ }
  await sleep(1500);
  try { providerProc?.kill(); } catch { /* 尽力而为 */ }
  if (pass) { try { rmSync(ws, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  else console.log(`沙箱保留于 ${ws}（app.log / provider.log.jsonl）`);
}
console.log(pass ? "GOAL-VERIFY-E2E-OK ✓" : "GOAL-VERIFY-E2E-FAIL ✗");
process.exit(pass ? 0 : 1);
