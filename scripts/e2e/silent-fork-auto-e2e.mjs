#!/usr/bin/env node
/**
 * zcode-go E2E：静默 fork 自动触发真实闭环（HOME 沙箱 + 假 Provider 驱动 compaction）。
 *
 * 与 goal-verify-e2e 同一套 HOME 沙箱基建（隔离教训见彼处头注）。差异：
 *   - provider 声明小 contextWindow（16k）+ 假 Provider 回长文——几轮内真实
 *     触发官方运行时的 auto-compaction；
 *   - composer 发普通消息若干轮（不设 goal，turn 结束即静默点）；
 *   - 断言链：沙箱 DB 出现活跃压缩边界 part → 帧观察者 armed → 静默点门控 →
 *     host→main arm 信号 → direct fork + redirect 落盘（沙箱 ~/.zcode-go/
 *     session-redirect.json）→ fork 会话尾部裁剪 + 原会话任务行不动；
 *   - 转接后原会话内继续对话（无订阅风暴）+ 隐形 fork 零任务行泄漏；
 *   - 轮换诊断段：二次 compaction → S'→S'' 表项更新 + 旧 fork 行删除。
 *
 * 运行：node scripts/e2e/silent-fork-auto-e2e.mjs（需 Xvfb :103 在跑）
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REAL_STATE_DIR = join(homedir(), ".zcode-go");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON = process.env.ZCODE_GO_E2E_APP_BIN ?? join(REAL_STATE_DIR, "electron", "zcode");
const CDP_PORT = 9335;
const PROFILE_TAG = "zg-sfk-e2e-profile";

const E2E_DISPLAY = process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103";
const ws = join(tmpdir(), `zg-sfk-e2e-${Date.now()}`);
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

function writeRoutes(routes) {
  writeFileSync(routesPath, JSON.stringify(routes, null, 1));
}

function providerEntries() {
  try {
    return readFileSync(providerLog, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function cdp() {
  const targets = await httpGet("/json/list");
  const page = targets.find((t) => t.type === "page" && t.title === "ZCode");
  if (!page) return null;
  const ws0 = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
  let id = 0;
  const pending = new Map();
  // renderer console 缓冲：redirect 后恢复链的风暴信号（[v4-store] resync 失败 /
  // notOwned 自愈）只走 renderer logger，遥测与 host 日志都不覆盖——风暴回归断言靠这里。
  const consoleBuffer = [];
  ws0.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      consoleBuffer.push(`${m.params.type}: ${text}`.slice(0, 300));
    }
  };
  await new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, () => resolve());
    ws0.send(JSON.stringify({ id: mid, method: "Runtime.enable" }));
  });
  const ev = (expr) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => { pending.delete(mid); resolve(null); }, 15000);
    pending.set(mid, (m) => {
      clearTimeout(timer);
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
  return { ev, trustedClick, trustedTypeAndEnterAt, consoleLines: () => consoleBuffer.slice(), close: () => ws0.close() };
}

let appProcPid = null;
let appExitInfo = null;

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
        if (env.includes(`HOME=${join(tmpdir(), "zg-sfk-e2e-")}`)) process.kill(Number(d), "SIGTERM");
      } catch { /* 进程已退/无权限 */ }
    }
  }
}

// 硬超时熔断：单个无超时 await（CDP 回复丢失 / 子进程挂起）会拖死整个 CI
// 步骤（windows 实测 41 分钟无输出靠人工取消）——到点强退，孤儿进程由
// runner 清理兜底。ZCODE_GO_E2E_FUSE_MS（秒）可调。
const E2E_FUSE_MS = (Number(process.env.ZCODE_GO_E2E_FUSE_MS) || 18) * 60_000;
setTimeout(() => {
  console.error(`E2E 硬超时熔断（${E2E_FUSE_MS}ms）触发，强制退出`);
  try { killAppInstance(); } catch { /* 尽力而为 */ }
  process.exit(1);
}, E2E_FUSE_MS).unref?.();

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
  const realProviderRuntime = join(homedir(), ".zcode", "v2", "runtime", "provider");
  if (existsSync(realProviderRuntime)) {
    cpSync(realProviderRuntime, join(sandboxHome, ".zcode", "v2", "runtime", "provider"), { recursive: true });
  }
  // 长回复驱动上下文膨胀（~1200 token/轮 × 多轮 → 触发 auto-compaction）
  const LONG_REPLY = "这是一段用于快速消耗上下文窗口的长回复。".repeat(240);
  writeRoutes([{ match: ".", content: LONG_REPLY }]);
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
        providerModelRules: [
          {
            providerId: "zcode-go-fake",
            modelId: "fake-model",
            config: { enabled: true, properties: { contextWindow: 16000 } },
          },
          // 自动选择可能命中模板目录模型（实测 gpt-6-astra）——窗口覆盖必须
          // 挂在真正被选中的 modelId 上，否则目录窗口获胜、compaction 永不触发
          {
            providerId: "zcode-go-fake",
            modelId: "gpt-6-astra",
            config: { enabled: true, properties: { contextWindow: 16000 } },
          },
        ],
        manualProviderModelRules: [],
      },
    },
  }));
  console.log(`0a. sandbox=${sandboxHome} fake provider port=${port}`);

  // ── 0b. 启动沙箱 E2E 实例（HOME 隔离 + DISPLAY 强制 :103） ──
  if (process.platform === "win32") {
    // TEMP/TMP/APPDATA 指向的沙箱目录必须先存在（缺失会让主进程早期挂起）
    mkdirSync(join(ws, "tmp"), { recursive: true });
    mkdirSync(join(sandboxHome, "AppData", "Roaming"), { recursive: true });
    mkdirSync(join(sandboxHome, "AppData", "Local"), { recursive: true });
  }
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
  // profile 目录预创建：Electron 偶发在 DevToolsActivePort 写入时目录尚未建好（竞态实测）
  mkdirSync(join(ws, PROFILE_TAG), { recursive: true });
  // devtools handler 把 active port 写到 <HOME>/.config/<应用名>/session/，
  // 全新 HOME 首启时该深层目录的创建存在竞态（实测间歇性写失败→CDP 不可用
  // →无窗口自退）——spawn 前预建。
  mkdirSync(join(sandboxHome, ".config", "ZCode Go E2E", "session"), { recursive: true });
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
          // Windows Electron 早期启动需要一批系统变量；APPDATA/LOCALAPPDATA
          // 指向沙箱（缺它们主进程会停在 crash-capture 之后一行日志）
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
          SYSTEMDRIVE: process.env.SYSTEMDRIVE,
          PROGRAMDATA: process.env.PROGRAMDATA,
          ...(process.env.ALLUSERSPROFILE ? { ALLUSERSPROFILE: process.env.ALLUSERSPROFILE } : {}),
          ...(process.env.COMPUTERNAME ? { COMPUTERNAME: process.env.COMPUTERNAME } : {}),
          ...(process.env.USERNAME ? { USERNAME: process.env.USERNAME } : {}),
          ...(process.env.USERDOMAIN ? { USERDOMAIN: process.env.USERDOMAIN } : {}),
          ...(process.env.OS ? { OS: process.env.OS } : {}),
          ...(process.env.NUMBER_OF_PROCESSORS
            ? { NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS }
            : {}),
          ...(process.env.PROCESSOR_ARCHITECTURE
            ? { PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE }
            : {}),
          TEMP: join(ws, "tmp"),
          TMP: join(ws, "tmp"),
          COMSPEC: process.env.COMSPEC,
          PATHEXT: process.env.PATHEXT,
          APPDATA: join(sandboxHome, "AppData", "Roaming"),
          LOCALAPPDATA: join(sandboxHome, "AppData", "Local"),
          HOMEDRIVE: process.env.HOMEDRIVE ?? "C:",
          ...(process.env.HOMEPATH ? { HOMEPATH: process.env.HOMEPATH } : {}),
        }
      : {}),
    ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Go E2E",
  };
  const appProc = spawn(ELECTRON, appArgs, {
    env: appEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  appProcPid = appProc.pid;
  appProc.on("exit", (code, signal) => {
    appExitInfo = { code, signal };
  });
  appProc.stdout.on("data", (c) => appendFileSync(appLog, c));
  appProc.stderr.on("data", (c) => appendFileSync(appLog, c));
  console.log("0b. app launched (sandboxed), waiting CDP…");

  let c = null;
  for (let i = 0; i < 40 && !c; i += 1) {
    await sleep(1500);
    c = await cdp().catch(() => null);
  }
  if (!c) {
    const exitInfo = appExitInfo ? `app exited code=${appExitInfo.code} signal=${appExitInfo.signal}` : "app still running";
    throw new Error(`E2E 实例 CDP 未就绪（${exitInfo}；看 app.log）`);
  }
  const { ev } = c;

  // ── 1. onboarding（API key 路径） ──
  for (let step = 0; step < 40; step += 1) {
    const r = await ev(`(() => {
      if (document.querySelector('[contenteditable="true"]')) return "composer";
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
      const apikey = btns.find(b => /使用 API key|Use API key/i.test(b.innerText || ""));
      if (apikey) { apikey.click(); return "apikey"; }
      const next = btns.find(b => ["继续", "Continue"].includes((b.innerText || "").trim()));
      if (next) { next.click(); return "continue"; }
      const skip = btns.find(b => ["跳过", "Skip"].includes((b.innerText || "").trim()));
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
      await ev(`Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && ["继续","Continue"].includes((b.innerText || "").trim()))?.click(); "ok"`);
    }
    if (r === "composer") break;
    await sleep(1200);
  }
  const composerOk = await ev(`!!document.querySelector('[contenteditable="true"]')`);
  console.log("1. onboarding composer:", composerOk);
  if (!composerOk) {
    const dump = await ev(`(() => {
      const btns = Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null)
        .map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 15);
      return JSON.stringify({ body: document.body.innerText.slice(0, 400), btns });
    })()`);
    console.log("onboarding stuck dump:", dump);
    throw new Error("onboarding 未完成（见上 dump）");
  }

  // ── 2. 多轮普通消息（可信输入 + 发送按钮；每轮 turn 结束即静默点） ──
  const sendRound = async (text) => {
    await ev(`document.querySelector('[contenteditable="true"]')?.focus(); "ok"`);
    const rect = await ev(`(() => { const r = document.querySelector('[contenteditable="true"]').getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
    const { x, y } = JSON.parse(rect);
    await c.trustedTypeAndEnterAt(text, x, y);
    for (let i = 0; i < 30; i += 1) {
      const state = await ev(`(() => {
        const submit = document.querySelector('[contenteditable="true"]')?.closest('form')?.querySelector('button[type="submit"]');
        if (submit && !submit.disabled) return 'ready';
        return 'wait';
      })()`);
      if (state === "ready") break;
      await sleep(1000);
    }
    const btnRect = await ev(`(() => { const b = document.querySelector('[contenteditable="true"]')?.closest('form')?.querySelector('button[type="submit"]'); if (!b) return 'null'; const r = b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
    if (btnRect === "null") return false;
    const b = JSON.parse(btnRect);
    await c.trustedClick(b.x, b.y);
    return true;
  };
  const dbPath = join(sandboxHome, ".zcode", "cli", "db", "db.sqlite");
  const compactionInDb = () => {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const hit = db.prepare(
        "select count(*) c from part where data like '{\"type\":\"compaction\"%' and data like '%compactBoundary%'",
      ).get();
      db.close();
      return hit.c > 0;
    } catch {
      return false;
    }
  };
  let compactionSeen = false;
  for (let round = 1; round <= 8 && !compactionSeen; round += 1) {
    const sent = await sendRound(`第 ${round} 轮：继续补充实现细节`);
    console.log(`2. round ${round} sent:`, sent);
    for (let i = 0; i < 30 && !compactionSeen; i += 1) {
      await sleep(2000);
      compactionSeen = compactionInDb();
    }
  }
  console.log("2z. compaction boundary in db:", compactionSeen);

  // ── 3. 等 redirect 落盘（armed → 静默点 5s debounce + 事件检查 2s → fork） ──
  const redirectFile = join(sandboxHome, ".zcode-go", "session-redirect.json");
  let entry = null;
  for (let i = 0; i < 60 && !entry; i += 1) {
    await sleep(3000);
    try {
      const raw = JSON.parse(readFileSync(redirectFile, "utf8"));
      const entries = Object.entries(raw.redirects ?? {});
      if (entries.length > 0) entry = { original: entries[0][0], fork: entries[0][1].forkSessionId };
    } catch { /* 未落盘 */ }
  }
  const redirectSeen = Boolean(entry);
  console.log("3. redirect map written:", redirectSeen, entry ?? "");

  // ── 4. fork 形态断言：尾部裁剪 + 原会话行仍在 + 发送走 fork（后续请求） ──
  let forkTrimmed = false;
  let originalIntact = false;
  if (entry) {
    await sleep(2000);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const forkMsgs = db.prepare("select count(*) c from message where session_id = ?").get(entry.fork).c;
    const origMsgs = db.prepare("select count(*) c from message where session_id = ?").get(entry.original).c;
    const origSession = db.prepare("select count(*) c from session where id = ?").get(entry.original).c;
    db.close();
    forkTrimmed = forkMsgs > 0 && forkMsgs < origMsgs;
    originalIntact = origSession === 1 && origMsgs > 0;
    console.log(`4. fork msgs=${forkMsgs} orig msgs=${origMsgs} trimmed=${forkTrimmed} originalIntact=${originalIntact}`);
  }

  // ── 5. redirect 后会话仍可用 + 无订阅风暴（2026-10-09 事故回归）──
  //    修复前：renderer 重订订阅后任何 resync 都被路由表 fork/原会话 topic 错位
  //    拒绝（notOwned）→ 自愈 connect 再被替换 → 30ms/轮风暴（实测 832 代/16s）。
  //    修复后：路由查找按 redirect 对称翻译 + 后台订阅独立 scope，恢复链应零
  //    notOwned。容忍 <3 次瞬态（偶发单次 notOwned 自愈一次即收敛，非风暴）。
  let postRedirectLive = false;
  let stormFree = true;
  if (entry) {
    const providerLogText = () => { try { return readFileSync(providerLog, "utf8"); } catch { return ""; } };
    const beforeLen = providerLogText().length;
    // forceSnapshot 重订会让视图短暂回到加载态（composer 卸载重挂）——先等它回来
    let composerBack = false;
    for (let i = 0; i < 30 && !composerBack; i += 1) {
      composerBack = await ev(`!!document.querySelector('[contenteditable="true"]')`);
      if (!composerBack) await sleep(1000);
    }
    if (!composerBack) {
      const dump = await ev(`document.body.innerText.slice(0, 500)`);
      console.log("5z. composer 未回归 dump:", JSON.stringify(dump));
      // renderer 恢复链诊断：[v4-store] 只进 renderer console
      const storeLines = c.consoleLines().filter((l) => l.includes("v4-store") || l.includes("fault."));
      console.log("5z. v4-store console 尾部:\n" + storeLines.slice(-25).join("\n"));
      throw new Error("转接后 composer 未回归（视图卡加载/错误态）");
    }
    const sent = await sendRound("转接后续轮：验证原会话内继续对话");
    for (let i = 0; i < 40; i += 1) {
      await sleep(1500);
      if (providerLogText().length > beforeLen) { postRedirectLive = true; break; }
    }
    // 观察窗 12s：统计恢复链风暴信号
    const lines = c ? c.consoleLines() : [];
    const stormSignals = lines.filter((l) =>
      l.includes("fault.subscription.notOwned") || l.includes("resyncGenerationMismatch"),
    ).length;
    stormFree = stormSignals < 3;
    console.log(`5. post-redirect live: ${postRedirectLive}; storm signals: ${stormSignals} (stormFree=${stormFree})`);
  }

  // ── 6. 隐形 fork 不泄漏进任务索引（侧栏唯一数据源）──
  //    修复前：静默点 checkQuiescence 的 readSession 返回快照带着 fork sessionId，
  //    task adapter snapshotToMeta 以 fork 身份建任务行 → 侧栏出现 "Fork of ..."。
  //    修复后：readSession 返回快照身份回写为请求方（原会话）。
  let forkRowLeakFree = true;
  if (entry) {
    await sleep(2000);
    try {
      const { DatabaseSync } = require("node:sqlite");
      const tasksDb = new DatabaseSync(join(sandboxHome, ".zcode", "v2", "tasks-index.sqlite"), { readOnly: true });
      const leak = tasksDb
        .prepare("select count(*) c from tasks where task_id = ?")
        .get(entry.fork).c;
      tasksDb.close();
      forkRowLeakFree = leak === 0;
      console.log(`6. fork task-row leak free: ${forkRowLeakFree} (fork rows: ${leak})`);
    } catch (error) {
      forkRowLeakFree = false;
      console.log("6. tasks-index 读取失败:", error.message);
    }
  }

  // ── 7. 轮换（batch 4）：二次 compaction → 活跃端点轮换 S'→S''（终末归并
  //    旧 fork 增量 → redirect 表项更新 → 旧 fork 会话行删除）。曾因两处 bug
  //    从未真正触发：notifiedSessions 去重泄漏（首 fork 后永久跳过，已修）+
  //    resync 路由错位风暴（已修）——升级为判据。
  let rotationOk = false;
  if (entry) {
    const oldFork = entry.fork;
    let rotated = null;
    const providerCount = () => providerEntries().length;
    const forkStats = () => {
      try {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const msgs = db.prepare("select count(*) c from message where session_id = ?").get(oldFork).c;
        const bounds = db.prepare(
          "select count(*) c from part where session_id = ? and data like '{\"type\":\"compaction\"%' and data like '%compactBoundary%'",
        ).get(oldFork).c;
        db.close();
        return { msgs, bounds };
      } catch { return { msgs: -1, bounds: -1 }; }
    };
    const provBefore = providerCount();
    const statsBefore = forkStats();
    // 归并回写基线：轮换（终末归并）或周期 worker 应把 fork 增量并入原会话——
    // 此前产品链「归并回写」只有单测覆盖，这里补真实闭环断言。
    const origMsgsBefore = (() => {
      try {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const c = db.prepare("select count(*) c from message where session_id = ?").get(entry.original).c;
        db.close();
        return c;
      } catch { return -1; }
    })();
    for (let round = 1; round <= 8 && !rotated; round += 1) {
      await sendRound(`轮换第 ${round} 轮：继续补充实现细节`);
      for (let i = 0; i < 22 && !rotated; i += 1) {
        await sleep(3000);
        try {
          const raw = JSON.parse(readFileSync(redirectFile, "utf8"));
          const forkNow = raw.redirects?.[entry.original]?.forkSessionId;
          if (forkNow && forkNow !== oldFork) rotated = forkNow;
        } catch { /* 表项暂未轮换 */ }
      }
    }
    if (rotated) {
      await sleep(3000);
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const oldForkDeleted = db.prepare("select count(*) c from session where id = ?").get(oldFork).c === 0;
      const origRow = db.prepare("select count(*) c from session where id = ?").get(entry.original).c;
      const origMsgsAfter = db.prepare("select count(*) c from message where session_id = ?").get(entry.original).c;
      db.close();
      const mergedBack = origMsgsAfter > origMsgsBefore;
      const storm2 = c ? c.consoleLines().filter((l) =>
        l.includes("fault.subscription.notOwned") || l.includes("resyncGenerationMismatch"),
      ).length : 0;
      rotationOk = oldForkDeleted && origRow === 1 && mergedBack && storm2 < 3;
      console.log(`7. rotation: ${oldFork.slice(5, 13)} → ${rotated.slice(5, 13)}; oldForkDeleted=${oldForkDeleted}; origRow=${origRow}; mergedBack=${mergedBack} (orig msgs ${origMsgsBefore}→${origMsgsAfter}); stormSignals(累计)=${storm2}; rotationOk=${rotationOk}`);
    } else {
      const statsAfter = forkStats();
      console.log(`7. rotation: 未在窗口内发生二次 compaction 轮换`,
        `provider 请求增量=${providerCount() - provBefore}`,
        `fork msgs ${statsBefore.msgs}→${statsAfter.msgs}`,
        `fork 压缩边界 ${statsBefore.bounds}→${statsAfter.bounds}`);
    }
  }

  pass = compactionSeen && redirectSeen && forkTrimmed && originalIntact && postRedirectLive && stormFree && forkRowLeakFree && rotationOk;
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
  else console.log(`沙箱保留于 ${ws}（app.log / provider.log.jsonl / home）`);
}
console.log(pass ? "SILENT-FORK-AUTO-E2E-OK ✓" : "SILENT-FORK-AUTO-E2E-FAIL ✗");
process.exit(pass ? 0 : 1);
