/**
 * zcode-go E2E（草稿，未接 CI）：subagent 配置变更 → 闲置 runtime 即时回收。
 *
 * 背景：runtime 进程在 bootstrap 一次性读入 subagent 配置（launcher 闭包
 * 冻结）。修复（d615876）：subagentsService 六个变更路径触发
 * onRuntimeAffectingChange → 进程管理器按 idle-timeout 同判定回收闲置进程。
 * 通知契约由单测覆盖（subagentsRuntimeAffectingChange.test，4/4）；本 E2E
 * 目标是把链路推到真实 UI。
 *
 * ⚠️ 当前环境阻断（接 CI 前需解决）：设置页的模型 registry 在 HOME 沙箱里
 * 只渲染 provider 组头、组内无模型项——内置 agent 的模型选择器无可选项，
 * 新建表单的 canSave 因 modelAvailable 恒 false 无法提交（把模型设回
 * 「继承默认」的菜单项在该状态下也不渲染）。需要给设置上下文种子模型
 * 项（或让 fake provider 的 /models 被设置页拉取）后才能全链路跑通。
 *
 * 已验证可用的部分：沙箱引导/onboarding/预热/设置页直开（task-settings-
 * button）/subagents 分区导航/表单填充/Radix 菜单 pointerdown 打开法。
 *
 * 运行：node scripts/e2e/subagent-recycle-e2e.mjs（需 Xvfb :103 在跑）
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
const PROFILE_TAG = "zg-subagent-e2e-profile";

const E2E_DISPLAY = process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103";
const ws = join(tmpdir(), `zg-subagent-e2e-${Date.now()}`);
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
  const trustedTypeAndEnterAt = async (text, x, y) => {
    await trustedClick(x, y);
    await trustedSelectAll();
    await input("insertText", { text });
    await new Promise((r) => setTimeout(r, 400));
  };
  return { ev, consoleLines: () => consoleBuffer.slice(), trustedClick, trustedTypeAndEnterAt, close: () => ws0.close() };
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
        if (env.includes(`HOME=${join(tmpdir(), "zg-goal-e2e-")}`)) process.kill(Number(d), "SIGTERM");
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
  writeRoutes([
    { match: "(?i).", content: "ok" },
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

  /** 输入 → 等发送按钮可用（双语重试）→ 可信点击。按钮在输入后才可能启用，
   * 且 goal 循环活跃期持续禁用——等待必须在点击前，事后轮询只会误报。 */
  const sendViaComposer = async (text) => {
    await ev(`document.querySelector('[contenteditable="true"]')?.focus(); "ok"`);
    const rect = await ev(`(() => { const r = document.querySelector('[contenteditable="true"]').getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
    const { x, y } = JSON.parse(rect);
    await c.trustedTypeAndEnterAt(text, x, y);
    for (let i = 0; i < 40; i += 1) {
      const state = await ev(`(() => {
        const body = document.body.innerText;
        const retry = Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && ['重试','Retry'].includes((b.innerText || '').trim()));
        if (retry && /模型(加载|配置)失败|[Ff]ailed to load model/.test(body)) { retry.click(); return 'retried'; }
        const submit = document.querySelector('[contenteditable="true"]')?.closest('form')?.querySelector('button[type="submit"]');
        if (submit && !submit.disabled) return 'ready';
        return 'wait';
      })()`);
      if (state === "ready") break;
      await sleep(1500);
    }
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

  // ── 2. 打开设置（侧栏页脚 task-settings-button 直开） ──
  let settingsOpened = false;
  {
    const has = await ev(`!!document.querySelector('[data-testid="task-settings-button"]')`);
    if (has) {
      await ev(`document.querySelector('[data-testid="task-settings-button"]').click(); "clicked"`);
      for (let i = 0; i < 10 && !settingsOpened; i += 1) {
        await sleep(800);
        settingsOpened = await ev(`!!document.querySelector('[data-testid="settings-page"], [data-testid^="settings-section-nav"]')`);
      }
    }
  }
  console.log("2. settings page opened:", settingsOpened);
  if (!settingsOpened) {
    const dump = await ev(`document.body.innerText.slice(0, 300)`);
    console.log("2x. body dump:", dump);
    throw new Error("设置页未打开（task-settings-button 路径失败，看 dump）");
  }

  // ── 3. 进入 subagents 分区 ──
  let subagentsNav = false;
  for (let i = 0; i < 5 && !subagentsNav; i += 1) {
    subagentsNav = await ev(`!!document.querySelector('[data-testid="settings-section-nav-subagents"]')`);
    if (!subagentsNav) {
      await ev(`(() => { const el = Array.from(document.querySelectorAll('button,[role="tab"]')).find(b => /子代理|Subagents?/i.test(b.innerText || "")); el?.click(); return "ok"; })()`).catch(() => {});
      await sleep(800);
    }
  }
  if (subagentsNav) {
    await ev(`document.querySelector('[data-testid="settings-section-nav-subagents"]').click(); "ok"`);
    await sleep(800);
  }
  const rowSeen = await ev(`!!document.querySelector('[data-testid^="subagent-row-"]')`);
  console.log("3. subagents section nav:", subagentsNav, "| rows visible:", rowSeen);
  if (!rowSeen) throw new Error("subagent 行未出现（分区导航失败）");

  // ── 4. 新建用户 subagent（createAgent → onRuntimeAffectingChange）──
  // 内置 agent 无启停开关、模型选择器在单模型沙箱不渲染可选项——createAgent
  // 是纯表单路径（名称/描述/提示词 + 提交），无 picker 依赖。
  const beforeCount = readFileSync(appLog, "utf8").split("recycling for subagent config change").length - 1;
  const addClicked = await ev(`(() => { const btn = Array.from(document.querySelectorAll("button")).find(b => b.offsetParent !== null && /创建|新建|Create/.test((b.innerText || "").trim())); if (!btn) return false; btn.click(); return true; })()`);
  console.log("4a. create form opened:", addClicked);
  if (!addClicked) throw new Error("未找到「新建子智能体」入口");
  await sleep(800);
  const filled = await ev(`(() => {
    const setVal = (el, v) => { const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    const byPh = (re) => Array.from(document.querySelectorAll("input, textarea")).find(i => i.offsetParent !== null && re.test(i.getAttribute("placeholder") || ""));
    const name = byPh(/code-reviewer|名称/); if (name) setVal(name, "e2e-recycle-helper");
    const desc = byPh(/展示给模型的简短说明|description/i); if (desc) setVal(desc, "e2e 回收验证 agent");
    const prompt = document.querySelector("textarea[placeholder]"); if (prompt) setVal(prompt, "You are an e2e helper.");
    return JSON.stringify({ name: name?.value?.slice(0, 20) ?? null, desc: desc?.value?.slice(0, 20) ?? null, prompt: prompt?.value?.slice(0, 20) ?? null });
  })()`);
  console.log("4b. form filled:", filled);
  await sleep(500);
  // canSave 含 modelAvailable：新表单的模型字段预填默认模型，而设置页 registry
  // 在单模型沙箱里组内无选项 → 不可用。把模型显式设回「继承默认」解锁保存。
  const modelTrig = await ev(`(() => { const t = document.querySelector('form [data-testid^="chat-model-select-trigger"]'); if (!t) return null; t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true })); return "pd"; })()`);
  if (modelTrig === "pd") {
    await sleep(1000);
    const inheritClicked = await ev(`(() => { const btn = Array.from(document.querySelectorAll('[role="menu"] button, [role="menu"] [role="menuitem"]')).find(b => /继承默认|Inherit/i.test(b.innerText || "")); if (!btn) return false; btn.click(); return true; })()`);
    console.log("4b3. model set to inherit-default:", inheritClicked);
    await sleep(800);
  }
  const submitted = await ev(`(() => { const btn = document.querySelector('form button[type="submit"]'); if (!btn || btn.disabled) return false; btn.click(); return true; })()`);
  console.log("4c. form submitted:", submitted);
  if (!submitted) throw new Error("表单提交失败（必填未满足？看 4b）");

  // ── 5. 断言闲置 runtime 被回收（判定与 idle-timeout 同：无在飞 RPC） ──
  let recycled = false;
  for (let i = 0; i < 20 && !recycled; i += 1) {
    await sleep(1000);
    const count = readFileSync(appLog, "utf8").split("recycling for subagent config change").length - 1;
    recycled = count > beforeCount;
  }
  console.log("5. idle runtime recycled for subagent config change:", recycled);

  pass = prewarmed && settingsOpened && rowSeen && addClicked && submitted && recycled;
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
console.log(pass ? "SUBAGENT-RECYCLE-E2E-OK ✓" : "SUBAGENT-RECYCLE-E2E-FAIL ✗");
process.exit(pass ? 0 : 1);
