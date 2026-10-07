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
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REAL_STATE_DIR = join(homedir(), ".zcode-go");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON = process.env.ZCODE_GO_E2E_APP_BIN ?? join(REAL_STATE_DIR, "electron", "zcode");
const CDP_PORT = 9334;
const PROFILE_TAG = "zg-goal-e2e-profile";
const OBJECTIVE = "把示例项目构建修绿并跑通测试";
const MARKER = "<!-- zcode-go:goal-verify";

const E2E_DISPLAY = process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103";
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

let appProcPid = null;

function killAppInstance() {
  // 主进程按 pid 精确终止（Electron 工具进程随主进程退出）；win 用 taskkill
  // 连树终止（Windows 子进程不随父退出）。
  if (appProcPid) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(appProcPid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(appProcPid, "SIGTERM");
      }
    } catch { /* 进程已退 */ }
    appProcPid = null;
  }
  // Linux 追加 /proc environ 前缀清杀：Electron 会把 argv 重写为应用名，历史
  // 僵尸（argv 不可辨）只能按 HOME 沙箱路径匹配；只杀本轮会留上轮僵尸占住
  // CDP 端口，后续运行会连到旧实例。
  if (process.platform === "linux") {
    for (const d of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        if (process.pid === Number(d)) continue;
        const env = readFileSync(join("/proc", d, "environ"), "utf8");
        if (env.includes(`HOME=${join(tmpdir(), "zg-goal-e2e-")}`)) process.kill(Number(d), "SIGTERM");
      } catch { /* 进程已退/无权限 */ }
    }
  }
}

let pass = false;
let providerProc = null;
try {
  if (!existsSync(ELECTRON)) throw new Error(`E2E app 不存在：${ELECTRON}（可用 ZCODE_GO_E2E_APP_BIN 注入）`);
  if (process.platform === "linux" && !process.env.ZCODE_GO_E2E_DISPLAY) {
    try {
      const xvfbOk = require("node:child_process").execSync("pgrep -x Xvfb", { stdio: "pipe" }).toString().trim();
      if (!xvfbOk) throw new Error("Xvfb 未运行");
    } catch {
      throw new Error("Xvfb 未运行（默认 DISPLAY :103：Xvfb :103 -screen 0 1920x1080x24；或经 ZCODE_GO_E2E_DISPLAY 注入 CI 动态 display）");
    }
  }
  // 前置清理：任何一轮旧沙箱实例（占 CDP 端口会劫持本轮连接）
  try { killAppInstance(); await sleep(1500); } catch { /* 尽力而为 */ }
  // ── 0. HOME 沙箱 + 假 Provider ──
  mkdirSync(join(sandboxHome, ".zcode", "v2"), { recursive: true });
  mkdirSync(join(sandboxHome, ".zcode-go"), { recursive: true });
  // 沙箱 agent 运行时解析链需要 official.json（env 覆盖 → 此文件 → 平台默认）。
  // 本地从真实状态目录拷；CI 用 ZCODE_OFFICIAL_BIN 构造（runtimeBundle 同目录
  // resources/glm/zcode.cjs，与 run.mjs 同一定位约定）。
  const realOfficial = join(REAL_STATE_DIR, "official.json");
  if (process.env.ZCODE_OFFICIAL_BIN) {
    const bin = process.env.ZCODE_OFFICIAL_BIN;
    const runtimeBundle = process.platform === "darwin"
      ? join(dirname(dirname(bin)), "Resources", "glm", "zcode.cjs")
      : join(dirname(bin), "resources", "glm", "zcode.cjs");
    writeFileSync(join(sandboxHome, ".zcode-go", "official.json"), JSON.stringify({
      platform: process.platform,
      bin,
      runtimeBundle,
      discoveredAt: Date.now(),
    }));
  } else if (existsSync(realOfficial)) {
    copyFileSync(realOfficial, join(sandboxHome, ".zcode-go", "official.json"));
  } else {
    throw new Error("official.json 不可得（本地 ~/.zcode-go/official.json 或 env ZCODE_OFFICIAL_BIN）");
  }
  // builtin Active 物化种子（~/.zcode/v2/runtime/provider：纯 provider 目录，无凭证）。
  // 新沙箱没有历史 Active 缓存、组装 app 又缺 packaged builtin 文件，CDN 同步在
  // 冷启动窗口内追不上——不种会导致「Bundled 与 Active 均不可用」且发送全拒。
  // Active 种子优先从真实实例拷（本地）；CI 无该缓存时依赖 packaged builtin
  // （~/.zcode-go/electron/resources/config/provider/zcode-builtin.json，CI 步
  // 骤里从官方包补齐——组装 app 缺这文件是冷启动「Bundled 与 Active 均不可
  // 用」的根因）。ZCODE_GO_E2E_SKIP_ACTIVE_SEED=1 供验证 packaged 路径自足。
  const realProviderRuntime = join(homedir(), ".zcode", "v2", "runtime", "provider");
  if (process.env.ZCODE_GO_E2E_SKIP_ACTIVE_SEED !== "1" && existsSync(realProviderRuntime)) {
    cpSync(realProviderRuntime, join(sandboxHome, ".zcode", "v2", "runtime", "provider"), { recursive: true });
  }
  writeRoutes([
    // 双确认路径：r1 判「通过」→ 触发 r2；r2 判「未完成」→ 重触发（验证按轮
    // tag 绑定在真实栈上不回声 r1 结论）。r2 路由必须排在通用 marker 路由前。
    { match: "zcode-go:goal-verify \\S*r2\\n", content: '{"passed": false, "reason": "二次核查发现构建还没跑通"}' },
    { match: MARKER, content: '{"passed": true, "reason": "从上下文看目标已完成"}' },
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
  const appArgs = [
    // 强制中文 UI：脚本的全部 DOM 文本匹配（onboarding 按钮/重试/发送）是中文，
    // CI runner 的系统 locale 不保证
    "--lang=zh-CN",
    `--user-data-dir=${join(ws, PROFILE_TAG)}`,
    `--remote-debugging-port=${CDP_PORT}`,
    // linux：生产启动器固定 --no-sandbox（CI 的 chrome-sandbox 无 SUID）；
    // win/mac CI 的 GPU 栈不稳（官方对照步骤同款规避）
    ...(process.platform === "linux" ? ["--no-sandbox"] : ["--disable-gpu"]),
  ];
  // 受控 env（不整包继承：宿主 shell 可能携带 ZCODE_* 等会击穿沙箱语义的变量）；
  // win 显式补系统必需（Electron 依赖 SYSTEMROOT/TEMP 等）
  const appEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "zh_CN.UTF-8",
    HOME: sandboxHome,
    ...(process.platform === "linux"
      ? {
          DISPLAY: E2E_DISPLAY,
          // xvfb-run 用临时 XAUTHORITY；受控 env 必须透传，否则
          // 「Authorization required, but no authorization protocol specified」
          ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          USERPROFILE: sandboxHome,
          SYSTEMROOT: process.env.SYSTEMROOT,
          TEMP: join(ws, "tmp"),
          TMP: join(ws, "tmp"),
          COMSPEC: process.env.COMSPEC,
          PATHEXT: process.env.PATHEXT,
        }
      : {}),
    ZCODE_GO_TAKEOVER: "1",
    ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Go E2E",
  };
  const appProc = spawn(ELECTRON, appArgs, {
    env: appEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  appProcPid = appProc.pid;
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

  const sendViaComposer = async (text) => {
    await ev(`document.querySelector('[contenteditable="true"]')?.focus(); "ok"`);
    const rect = await ev(`(() => { const r = document.querySelector('[contenteditable="true"]').getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
    const { x, y } = JSON.parse(rect);
    await c.trustedTypeAndEnterAt(text, x, y);
    const btnRect = await ev(`(() => { const b = document.querySelector('[contenteditable="true"]')?.closest('form')?.querySelector('button[type="submit"]'); if (!b) return 'null'; const r = b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
    if (btnRect === "null") return false;
    const b = JSON.parse(btnRect);
    await c.trustedClick(b.x, b.y);
    return true;
  };

  // ── 1.8 预热：发普通消息直到假 Provider 真收到请求（首发存在 provider 推送
  // 竞态：registry 未就绪时 turn 报「Provider Registry 中不存在」，goal 一次性
  // 命令经不起这个竞态——预热把通道就绪变成确定性闸门） ──
  let prewarmed = false;
  for (let attempt = 1; attempt <= 3 && !prewarmed; attempt += 1) {
    const sent = await sendViaComposer(`预热 ${attempt}：请回复 ok`);
    console.log(`1.8 prewarm ${attempt} sent:`, sent);
    for (let i = 0; i < 45 && !prewarmed; i += 1) {
      await sleep(2000);
      prewarmed = providerEntries().length > 0;
    }
  }
  console.log("1.8 fake provider channel prewarmed:", prewarmed);
  if (!prewarmed) throw new Error("假 Provider 通道未就绪（推送竞态未收敛，看 app.log）");

  // ── 2. 发 /goal（sendViaComposer 内部：输入 → 等按钮可用含模型重试 → 点击） ──
  const goalSent = await sendViaComposer(`/goal ${OBJECTIVE}`);
  console.log("2. /goal sent:", goalSent);
  if (!goalSent) throw new Error("/goal 发送失败（composer 不可用）");
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
  try {
    const tail = readFileSync(appLog, "utf8").trim().split("\n").slice(-30).join("\n");
    console.error(`app.log 尾部：\n${tail}`);
  } catch { /* 无日志 */ }
} finally {
  try { killAppInstance(); } catch { /* 尽力而为 */ }
  await sleep(1500);
  try { providerProc?.kill(); } catch { /* 尽力而为 */ }
  if (pass) { try { rmSync(ws, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  else console.log(`沙箱保留于 ${ws}（app.log / provider.log.jsonl）`);
}
console.log(pass ? "GOAL-VERIFY-E2E-OK ✓" : "GOAL-VERIFY-E2E-FAIL ✗");
process.exit(pass ? 0 : 1);
