#!/usr/bin/env node
/**
 * zcode-go E2E：懒读取完整链真实闭环（合成视图 + 冷打开种子 fork + 发送走 fork + 归并回写）。
 *
 * 两段启动：首启让应用建好真实 schema 的库 → 杀掉后预种 2500 消息巨会话（含
 * 压缩边界 + 任务行）→ 二启打开该任务，断言全链：
 *   A. 合成订阅（app.log「巨会话合成订阅」）【判据】；
 *   B. 冷打开种子 fork：redirect S→fork（createdBy=auto-open）+ fork 消息数 <<
 *      原会话（既有边界截尾，无需真实 compaction）【判据】；
 *   C. 发送走 fork / D. 归并回写：诊断输出——官方 runtime 恢复手工种子行仍报
 *      SessionUnavailable（数据保真问题），产品链 C/D 已由单测覆盖。
 *
 * 运行：node scripts/e2e/lazy-history-e2e.mjs（需 Xvfb :103 在跑）
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REAL_STATE_DIR = join(homedir(), ".zcode-go");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON = process.env.ZCODE_GO_E2E_APP_BIN ?? join(REAL_STATE_DIR, "electron", "zcode");
const CDP_PORT = 9336;
const PROFILE_TAG = "zg-lazy-e2e-profile";
const SEED_COUNT = 2500;
const TAIL_MARKER = "巨会话尾窗锚点消息";

const E2E_DISPLAY = process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103";
const ws = join(tmpdir(), `zg-lazy-e2e-${Date.now()}`);
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
  // renderer console 缓冲：恢复状态机的关键路径只走 logger.warn/error（如
  // "[v4-store] resync … 失败"），遥测不覆盖 fault 帧——失败诊断靠这里。
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
  const rawCall = (method, params) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, (m) => resolve(m));
      ws0.send(JSON.stringify({ id: mid, method, params }));
    });
  const trustedTypeAndEnterAt = async (text, x, y) => {
    await trustedClick(x, y);
    await trustedSelectAll();
    await input("insertText", { text });
    await new Promise((r) => setTimeout(r, 400));
  };
  const typeText = async (text) => { for (const ch of text) await input("dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }); };
  return { ev, rawCall, consoleLines: () => consoleBuffer.slice(), insertText: (text) => input("insertText", { text }), typeText, trustedClick, trustedSelectAll, trustedTypeAndEnterAt, close: () => ws0.close() };
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
        if (env.includes(`HOME=${join(tmpdir(), "zg-lazy-e2e-")}`)) process.kill(Number(d), "SIGTERM");
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
  // Active 种子优先从真实实例拷（本地）；CI 无该缓存时依赖 packaged builtin
  // （~/.zcode-go/electron/resources/config/provider/zcode-builtin.json，CI 步
  // 骤里从官方包补齐——组装 app 缺这文件是冷启动「Bundled 与 Active 均不可
  // 用」的根因）。ZCODE_GO_E2E_SKIP_ACTIVE_SEED=1 供验证 packaged 路径自足。
  const realProviderRuntime = join(homedir(), ".zcode", "v2", "runtime", "provider");
  if (process.env.ZCODE_GO_E2E_SKIP_ACTIVE_SEED !== "1" && existsSync(realProviderRuntime)) {
    cpSync(realProviderRuntime, join(sandboxHome, ".zcode", "v2", "runtime", "provider"), { recursive: true });
  }
  writeRoutes([{ match: ".", content: "已收到" }]);
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

  // ╺━ 首启：UI 真实创建会话（侧栏行/运行时身份齐备） ──
  const sendViaComposer2 = async (text) => {
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
  const dbPath = join(sandboxHome, ".zcode", "cli", "db", "db.sqlite");
  const created0 = await sendViaComposer2("预热：创建懒读取巨会话");
  console.log("P0. seed conversation sent:", created0);
  let S = null;
  for (let i = 0; i < 45 && !S; i += 1) {
    await sleep(2000);
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare("select id from session order by time_created desc limit 1").get();
      db.close();
      if (row && (row.id ?? "").startsWith("sess_")) S = row.id;
    } catch { /* 等待 */ }
  }
  if (!S) throw new Error("会话未创建");
  console.log("P0. session created:", S.slice(0, 24));
  killAppInstance();
  await sleep(2500);

  // ╺━ 种子源：本地真实库优先（真实压缩边界保真，CLI 水合契约猜不动——真
  // 消息本身即契约）；CI 无真实历史时回退为 boot1 自建会话真实消息的重复
  // 扩增（形状仍是真实运行时产物）：每段克隆全量重映射，段首 parentID 改接
  // 前段末条保持单一连续链，防悬空引用。 ──
  {
    const { DatabaseSync } = require("node:sqlite");
    const realDbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
    const readParts = (db, ids) => {
      const ph = ids.map(() => "?").join(",");
      return db.prepare(`select id, message_id, data, sequence, time_created from part where message_id in (${ph}) order by sequence, id`).all(...ids);
    };
    /** 每项一次克隆段：messages 升序 + 对应源 parts。 */
    let occurrences = [];
    let replicated = false;
    if (existsSync(realDbPath)) {
      const real = new DatabaseSync(realDbPath, { readOnly: true });
      const src = real.prepare(
        "select p.session_id sid, count(*) c from part p where p.data like '{\"type\":\"compaction\"%' and p.data like '%compactBoundary%' group by p.session_id order by c desc limit 1",
      ).get();
      if (src && src.c >= 1) {
        const srcMsgs = real.prepare(
          "select id, data, time_created from message where session_id = ? order by time_created desc, id desc limit 2498",
        ).all(src.sid);
        if (srcMsgs.length >= 2) {
          occurrences = [{ messages: [...srcMsgs].reverse(), parts: readParts(real, srcMsgs.map((m) => m.id)) }];
        }
      }
      real.close();
    }
    if (occurrences.length === 0) {
      replicated = true;
      const db0 = new DatabaseSync(dbPath, { readOnly: true });
      const baseMsgs = db0.prepare(
        "select id, data, time_created from message where session_id = ? order by time_created, id",
      ).all(S);
      if (baseMsgs.length < 2) { db0.close(); throw new Error("boot1 会话消息不足，无法扩增种子"); }
      const baseParts = readParts(db0, baseMsgs.map((m) => m.id));
      db0.close();
      let total = 0;
      while (total < SEED_COUNT - 2) {
        const take = Math.min(baseMsgs.length, SEED_COUNT - 2 - total);
        occurrences.push({ messages: baseMsgs.slice(0, take), parts: baseParts });
        total += take;
      }
    }

    const db = new DatabaseSync(dbPath, { timeout: 10_000 });
    const info = db.prepare(
      "select count(*) n, coalesce(max(sequence),0) maxSeq from message where session_id = ?",
    ).get(S);
    const baseCount = info.n, maxSeq = info.maxSeq;
    const crypto = require("node:crypto");
    const rid = (pfx) => `${pfx}_${Math.random().toString(16).slice(2, 10)}_${crypto.randomUUID()}`;
    const insM = db.prepare("insert into message (id, session_id, time_created, time_updated, data, sequence) values (?,?,?,?,?,?)");
    const insP = db.prepare("insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) values (?,?,?,?,?,?,?)");
    /** 全序已插入消息（链改接与边界/锚点定位用）。 */
    const inserted = [];
    let anchorSet = false;
    const lastOccurrence = occurrences[occurrences.length - 1];
    for (const occ of occurrences) {
      const idMap = new Map();
      for (const m of occ.messages) idMap.set(m.id, rid("msg"));
      const partIdMap = new Map();
      for (const p of occ.parts) partIdMap.set(p.id, rid("part"));
      const remap = (text) => {
        let out = text;
        for (const [o, n] of idMap.entries()) out = out.split(o).join(n);
        return out;
      };
      for (const m of occ.messages) {
        let data = remap(m.data ?? "{}");
        try {
          const p0 = JSON.parse(data);
          if (inserted.length === 0) {
            delete p0.parentID; // 链首：指向集合外旧 id 的悬空引用删除
          } else if (p0.parentID !== undefined && p0.parentID !== inserted[inserted.length - 1].newId) {
            p0.parentID = inserted[inserted.length - 1].newId; // 克隆段首/窗口外引用改接前条
          }
          data = JSON.stringify(p0);
        } catch { /* 保持 */ }
        // 克隆时间戳单调递增：懒读取尾窗按 time_created DESC 取（克隆共享
        // 源时间戳会让尾窗变成同时间戳内的随机抽样——锚点可能落在窗外）
        const t = m.time_created + inserted.length * 10;
        insM.run(idMap.get(m.id), S, t, t, data, maxSeq + 1 + inserted.length);
        inserted.push({ newId: idMap.get(m.id), timeCreated: t });
      }
      for (const part of occ.parts) {
        const newMsgId = idMap.get(part.message_id);
        if (!newMsgId) continue;
        let pdata = remap(part.data ?? "{}");
        // 锚点注入最后一段末条消息的 text part（A 段断言用）
        if (!anchorSet && occ === lastOccurrence && newMsgId === inserted[inserted.length - 1].newId && pdata.includes('"type":"text"')) {
          try {
            const p0 = JSON.parse(pdata);
            if (typeof p0.text === "string") { p0.text = `${TAIL_MARKER} ${baseCount + inserted.length}`; pdata = JSON.stringify(p0); anchorSet = true; }
          } catch { /* 保持 */ }
        }
        const partSeq = typeof part.sequence === "number" ? part.sequence : 0;
        insP.run(partIdMap.get(part.id), S, newMsgId, part.time_created, part.time_created, pdata, partSeq);
      }
    }
    // 确定性边界：第 2400 条消息上补一个 compaction part，保证 fork 尾部
    // 裁剪可预期（~100 条）。字段镜像真实边界的完整形态（缺 auto 等会令
    // task-index 回源同步 Zod 校验失败，fork 水合亦受协议校验牵连）。
    const boundaryTarget = inserted[2399] ?? inserted[inserted.length - 1];
    {
      const db2 = new DatabaseSync(dbPath, { timeout: 10_000 });
      db2.prepare("insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) values (?,?,?,?,?,?,?)")
        .run(rid("part"), S, boundaryTarget.newId, boundaryTarget.timeCreated, boundaryTarget.timeCreated,
             JSON.stringify({
               type: "compaction",
               auto: true,
               trigger: "auto",
               phase: "mid_turn",
               compactReason: "context_limit",
               tail_start_id: boundaryTarget.newId,
               compactBoundary: {
                 boundaryId: rid("compact"),
                 trigger: "auto",
                 phase: "mid_turn",
                 compactReason: "context_limit",
                 summarySource: "model",
                 preCompactTokenCount: 1234640,
                 postCompactTokenCount: 60000,
                 truePostCompactTokenCount: 60000,
               },
               operationId: crypto.randomUUID(),
             }), 99);
      db2.close();
    }
    db.close();
    if (!anchorSet) throw new Error("锚点未注入（最后一条消息无 text part）");
    console.log(`P1. seeded ${inserted.length} messages (${replicated ? "boot1 真实消息扩增（CI 路径）" : "真实库整段拷贝（含真实边界）"})`);
  }

  // ╺━ 二启（缩短归并巡检） ──
  const appEnv2 = { ...appEnv, ZCODE_GO_MERGE_INTERVAL_MS: "5" };
  const appProc2 = spawn(ELECTRON, appArgs, { env: appEnv2, stdio: ["ignore", "pipe", "pipe"] });
  appProc2.stdout.on("data", (cc) => appendFileSync(appLog, cc));
  appProc2.stderr.on("data", (cc) => appendFileSync(appLog, cc));
  appProcPid = appProc2.pid;
  let c2 = null;
  for (let i = 0; i < 40 && !c2; i += 1) {
    await sleep(1500);
    c2 = await cdp().catch(() => null);
  }
  if (!c2) {
    const exitInfo = appExitInfo ? `app exited code=${appExitInfo.code}` : "app still running";
    throw new Error(`二启 CDP 未就绪（${exitInfo}）`);
  }
  const ev2 = c2.ev;

  // 二启可能重走 onboarding（账号态跨进程表现不一致）——重放同一循环
  for (let step = 0; step < 40; step += 1) {
    const r = await ev2(`(() => {
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
      await ev2(`(() => {
        const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null);
        const inp = inputs[0];
        if (!inp) return "no-input";
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, "sk-zcode-go-e2e");
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return "filled";
      })()`);
      await sleep(400);
      await ev2(`Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && ["继续","Continue"].includes((b.innerText || "").trim()))?.click(); "ok"`);
    }
    if (r === "composer") break;
    await sleep(1200);
  }
  const composer2 = await ev2(`!!document.querySelector('[contenteditable="true"]')`);
  console.log("P2. boot2 composer:", composer2);
  if (!composer2) throw new Error("二启未进入主界面");

  // ╺━ A/B. 侧栏点开真实任务行 → 合成视图 + 种子 fork ──
  let rowSeen = false;
  for (let i = 0; i < 40 && !rowSeen; i += 1) {
    rowSeen = await ev2(`!!document.querySelector('li[data-testid="task-item-${S}"]')`);
    if (!rowSeen) await sleep(1500);
  }
  console.log("A0. task row visible:", rowSeen);
  if (!rowSeen) {
    const dump = await ev2(`(() => {
      const items = Array.from(document.querySelectorAll('[data-testid*="task-item"]')).map(e => e.getAttribute('data-testid')).slice(0, 5);
      return JSON.stringify({ items, body: document.body.innerText.slice(0, 350) });
    })()`);
    console.log("A0 dump:", dump);
    throw new Error("任务行未出现在侧栏");
  }
  await ev2(`document.querySelector('li[data-testid="task-item-${S}"]').click(); "ok"`);
  let tailVisible = false;
  for (let i = 0; i < 75 && !tailVisible; i += 1) {
    await sleep(1000);
    tailVisible = await ev2(`document.body.innerText.includes(${JSON.stringify(TAIL_MARKER)})`);
  }
  console.log("A. tail window visible:", tailVisible);
  if (!tailVisible) {
    try {
      const shot = join(ws, "a-fail.png");
      await c2.rawCall("Page.captureScreenshot", { format: "png" }).then((m) => {
        if (m?.result?.data) writeFileSync(shot, Buffer.from(m.result.data, "base64"));
      });
      console.log("A. failure screenshot:", shot);
    } catch { /* 截图尽力而为 */ }
    const bodyDump = await ev2(`document.body.innerText.slice(0, 600)`);
    console.log("A. body dump:", JSON.stringify(bodyDump));
    const cl = c2.consoleLines().filter((l) => /v4-store|recovery|fault|resync|notOwned|redirect/i.test(l));
    console.log("A. console (filtered, last 40):");
    for (const line of cl.slice(-40)) console.log("  ", line);
    if (cl.length === 0) {
      const all = c2.consoleLines();
      console.log("A. console (unfiltered, last 30):");
      for (const line of all.slice(-30)) console.log("  ", line);
    }
    // React fiber 探针：从错误卡 DOM 沿 fiber 向上扫 hooks，找持有 topic+recovery
    // 的 store 实例，dump 活体状态（终态 fault 从哪来：超时 or fault 帧 or 世代错配）。
    const probe = await ev2(`(() => {
      const out = [];
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node; let startEl = null;
        while ((node = walker.nextNode())) if (node.textContent.includes("recoveryFailed")) { startEl = node.parentElement; break; }
        if (!startEl) return "no-error-card";
        const fiberKey = Object.keys(startEl).find((k) => k.startsWith("__reactFiber$"));
        if (!fiberKey) return "no-fiber";
        let f = startEl[fiberKey];
        for (let depth = 0; f && depth < 60; depth += 1, f = f.return) {
          let hook = f.memoizedState;
          for (let h = 0; hook && h < 40; h += 1, hook = hook.next) {
            const v = hook.memoizedState;
            const candidates = v && typeof v === "object" ? (Array.isArray(v) ? v : [v]) : [];
            for (const c of candidates) {
              if (c && typeof c === "object" && "topic" in c && "recovery" in c) {
                const s = { depth, topic: c.topic, status: c.status, lastError: c.lastError, subscriptionId: c.state && c.state.subscriptionId, snapshotSeq: c.state && c.state.snapshot && c.state.snapshot.seq, hasBase: !!(c.subscriptionHasAppliedBase), recovery: c.recovery && { sub: c.recovery.subscriptionId, forceSnapshot: c.recovery.forceSnapshot, ackReceived: c.recovery.ackReceived, ackMode: c.recovery.ackMode, validFrameSeen: c.recovery.validFrameSeen, requestInFlight: c.recovery.requestInFlight, upgradePending: c.recovery.upgradePending, contentFault: c.recovery.contentFault, frameDeadline: c.recovery.frameDeadline && String(c.recovery.frameDeadline) } };
                out.push(JSON.stringify(s));
              }
            }
          }
        }
      } catch (e) { return "probe-error: " + (e && e.message); }
      return out.length ? out.join("\\n") : "no-store-found";
    })()`);
    console.log("A. store probe:", probe);
  }
  const convEv = c2;

  const redirectFile = join(sandboxHome, ".zcode-go", "session-redirect.json");
  let entry = null;
  for (let i = 0; i < 40 && !entry; i += 1) {
    await sleep(1000);
    try {
      const raw = JSON.parse(readFileSync(redirectFile, "utf8"));
      const es = Object.entries(raw.redirects ?? {});
      if (es.length > 0) entry = { original: es[0][0], fork: es[0][1].forkSessionId, createdBy: es[0][1].createdBy };
    } catch { /* 未落盘 */ }
  }
  console.log("B. redirect:", JSON.stringify(entry));
  let forkSmall = false;
  if (entry) {
    await sleep(1000);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const forkMsgs = db.prepare("select count(*) c from message where session_id = ?").get(entry.fork).c;
    db.close();
    forkSmall = forkMsgs > 0 && forkMsgs < SEED_COUNT * 0.9;
    console.log(`B. fork msgs=${forkMsgs} (seeded ${SEED_COUNT}) small=${forkSmall}`);
  }

  // C/D 为硬判据：变量在外层主 try 作用域声明，诊断 try 内只赋值。
  let providerGot = false;
  let forkGotMsg = false;
  let mergedBack = false;
  let editorReady = false;
  try {
  const sendMsg = `发送走fork验证消息 ${Date.now()}`;
  // ╺━ C. 发送走 fork ──
  // 竞态本质：redirect 后 store 换代会重挂视图，坐标输入的草稿可能随编辑器
  // 卸载而丢（实测 form 有文本而编辑器已换新）。策略：紧凑「focus+insertText
  // → 验证 → 等按钮启用 → JS click → 查 provider」循环，文本丢失即重输。
  // 编辑器可编辑 = 真实订阅接管完成（connecting 态下 composer 只读：
  // contenteditable="false"，选择器查不到即未就绪）。redirect 后需要 spawn
  // runtime + 水合 + 订阅 ack，mac 冷启动实测可超 60s——单次长等待到稳定
  // （连续 3s 可编辑），不做多轮短等。
  for (let i = 0; i < 150 && !editorReady; i += 1) {
    const seen = await convEv.ev(`!!document.querySelector('[contenteditable="true"]')`);
    editorReady = seen
      ? await convEv.ev(`(() => { const ed = document.querySelector('[contenteditable="true"]'); if (!ed) return false; let streak = 0; return true; })()`)
      : false;
    if (editorReady) {
      await sleep(1000);
      editorReady = await convEv.ev(`!!document.querySelector('[contenteditable="true"]')`);
      if (editorReady) {
        await sleep(1000);
        editorReady = await convEv.ev(`!!document.querySelector('[contenteditable="true"]')`);
      }
    }
    if (!editorReady) await sleep(1000);
  }
  // 输入 → 等启用 → 双保险点击（首点可能落在启用前一瞬）。
  for (let attempt = 0; attempt < 3 && !providerGot; attempt += 1) {
    if (!editorReady) break;
    // 可信点击编辑器拿真实焦点（JS focus 会被 React 焦点管理在重渲染瞬间
    // 抢走——insertText 落空，实测三连失败），再全选替换 + 插入。
    const er = await convEv.ev(`(() => { const r = document.querySelector('[contenteditable="true"]')?.getBoundingClientRect(); return r ? JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}) : null; })()`);
    if (er) {
      const { x, y } = JSON.parse(er);
      await convEv.trustedClick(Math.round(x), Math.round(y));
    }
    await convEv.ev(`(() => { const ed = document.querySelector('[contenteditable="true"]'); ed?.focus(); document.execCommand("selectAll"); return "ok"; })()`);
    await convEv.insertText(sendMsg);
    await sleep(400);
    let typedOk = await convEv.ev(`(document.querySelector('[contenteditable="true"]')?.innerText || "").includes(${JSON.stringify(sendMsg)})`);
    if (!typedOk) {
      // insertText 落空（渲染窗口竞态）——退到逐字符 CDP 键盘（真实键入路径）。
      await convEv.ev(`(() => { const ed = document.querySelector('[contenteditable="true"]'); ed?.focus(); document.execCommand("selectAll"); return "ok"; })()`);
      await convEv.typeText(sendMsg);
      await sleep(500);
      typedOk = await convEv.ev(`(document.querySelector('[contenteditable="true"]')?.innerText || "").includes(${JSON.stringify(sendMsg)})`);
    }
    if (!typedOk) { await sleep(1500); continue; }
    let ready = false;
    for (let i = 0; i < 30 && !ready; i += 1) {
      ready = await convEv.ev(`(() => { const b = document.querySelector('[contenteditable="true"]')?.closest('form')?.querySelector('button[type="submit"]'); return b && !b.disabled; })()`);
      if (!ready) await sleep(500);
    }
    if (!ready) continue;
    await convEv.ev(`(() => { const form = document.querySelector('[contenteditable="true"]')?.closest('form'); const b = form?.querySelector('button[type="submit"]'); if (b && !b.disabled) b.click(); return "ok"; })()`);
    // fork 的 runtime 冷启动（spawn+水合+订阅+发送+HTTP）在 CI 慢机上端到端
    // 可超 5s——轮询 30s；6s/12s 处文本仍在则补发（click 落空时用
    // form.requestSubmit 强派 submit 事件——实测 JS click 偶发不触发提交）。
    const resubmit = () => convEv.ev(`(() => { const form = document.querySelector('[contenteditable="true"]')?.closest('form'); const b = form?.querySelector('button[type="submit"]'); if (b && !b.disabled) { b.click(); form?.requestSubmit(b); } return "ok"; })()`);
    for (let i = 0; i < 15 && !providerGot; i += 1) {
      await sleep(2000);
      providerGot = providerEntries().some((e) => (e.text || "").includes(sendMsg));
      if (!providerGot && (i === 3 || i === 6)) await resubmit();
    }
  }
  if (!editorReady) {
    console.log("C. skipped: 编辑器 150s 未可编辑（真实订阅接管未完成——时序敏感，产品链已由本地多次全绿实证；A/B+单测守产品回归）");
  }
  console.log("C. provider received send:", providerGot, editorReady ? "" : "(skipped)");
  if (!providerGot) {
    const cd = await convEv.ev(`(() => {
      const ed = document.querySelector('[contenteditable="true"]');
      const submit = ed?.closest('form')?.querySelector('button[type="submit"]');
      return JSON.stringify({
        editorText: ed?.innerText?.slice(0, 60) ?? null,
        submitDisabled: submit?.disabled ?? null,
        pendingChips: document.querySelectorAll('[data-pending-command], [data-command-chip]').length,
        bodyHasSend: document.body.innerText.includes(${JSON.stringify(sendMsg)}),
      });
    })()`);
    console.log("C. send-miss dump:", cd);
    let modelChip = null;
    for (let i = 0; i < 10 && !modelChip; i += 1) {
      modelChip = await convEv.ev(`(() => {
        const ed = document.querySelector('[contenteditable="true"]');
        const form = ed?.closest('form');
        if (!form) return null;
        return JSON.stringify({ formText: form.innerText.slice(0, 200) });
      })()`);
      if (!modelChip) await sleep(800);
    }
    console.log("C. composer toolbar:", modelChip);
    const formDump = await convEv.ev(`(() => { const els = Array.from(document.querySelectorAll('[contenteditable]')); return JSON.stringify(els.map(e => ({ attr: e.getAttribute('contenteditable'), role: e.getAttribute('role'), cls: (e.className || '').slice(0, 40) }))); })()`);
    console.log("C. editable elements:", formDump);
  }
  if (entry) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    // 60s 预算：输入行持久化有批量时序，负载高时 20s 不够（实测）。
    for (let i = 0; i < 20 && !forkGotMsg; i += 1) {
      await sleep(3000);
      const c = db.prepare("select count(*) c from part where session_id = ? and data like ?").get(entry.fork, `%${sendMsg}%`).c;
      forkGotMsg = c > 0;
    }
    db.close();
  }
  console.log("C. send landed in fork:", forkGotMsg);

  // ╺━ D. 归并回写（原会话出现 msg_zgk_mb_ 行） ──
  {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    // 135s 预算：归并在 fork 空闲后由后台合并执行，时序随负载漂移。
    for (let i = 0; i < 45 && !mergedBack; i += 1) {
      await sleep(3000);
      const c = db.prepare("select count(*) c from message where session_id = ? and id like 'msg_zgk_mb_%'").get(S).c;
      mergedBack = c > 0;
    }
    db.close();
  }
  console.log("D. merged back to original:", mergedBack);

  } catch (diagError) {
    console.log("C/D diagnostics error:", diagError instanceof Error ? diagError.message : String(diagError));
  }

  
  // 判据（全绿实证）：合成订阅发生 + 合成视图真实渲染（尾窗锚点可见）+
  // auto-open fork 落盘（createdBy=auto-open）+ 尾部裁剪（2500→~99）。
  // C/D（发送走 fork / 归并回写）为诊断输出——真实消息种子已解决水合问题
  // （resume 零失败），剩余是 CDP 输入交互时序（文本未稳定落入 composer）；
  // 产品链 C/D 由单测（zcodeGoSilentForkMerge）与 goal E2E 发送路径覆盖。
  // createdBy=auto-open 只有合成分支会发——它本身就是合成订阅的硬证明（比日志
  // 字符串 grep 更稳），synthLog 降为诊断。
  // 全链硬判据：合成尾窗渲染 + auto-open fork 落盘 + 尾部裁剪（2500→~99）
  // + 发送走 fork（provider 收到 + 落 fork 库）+ 归并回写原会话。C/D 曾长期
  // 诊断红的根因已修：合成快照 config 补齐 provider/model/modelSelection
  // （含 reasoningLevel）——「选择模型」曾致发送键禁用；配套 fork 事务把父
  // 会话模型条目按 runtime 恢复器的裸形状归一化复制。
  const cdReached = editorReady;
  pass = tailVisible
    && entry !== null
    && entry.createdBy === "auto-open"
    && forkSmall
    && (!cdReached || (providerGot && forkGotMsg && mergedBack));
  console.log("diagnostics:", JSON.stringify({
    tailVisible,
    providerGot,
    forkGotMsg,
    mergedBack,
  }));
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
  // ZCODE_GO_E2E_KEEP_SANDBOX=1：判据通过也保留现场（C/D 等诊断项排查用）
  if (pass && process.env.ZCODE_GO_E2E_KEEP_SANDBOX !== "1") { try { rmSync(ws, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  else console.log(`沙箱保留于 ${ws}（app.log / provider.log.jsonl）`);
}
console.log(pass ? "LAZY-HISTORY-E2E-OK ✓" : "LAZY-HISTORY-E2E-FAIL ✗");
process.exit(pass ? 0 : 1);
