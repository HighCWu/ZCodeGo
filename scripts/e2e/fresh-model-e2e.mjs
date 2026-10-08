#!/usr/bin/env node
/**
 * zcode-go E2E：fresh 环境「模型自动勾上」+ 桌面↔web 双向对话同步闭环（自包含版）。
 *
 * 旧版依赖外部 9333 实例 + ZCODE_DATA_BASE_DIR 隔离：agent 运行时（官方
 * bundle）的配置根不受该 env 影响，读不到假 Provider，步骤 3/4（双向同步）
 * 因「Registry 中不存在 Provider」永远无回复，只能作信息输出。
 * 本版一揽子自包含（与 goal-verify-e2e 同构）：
 *   - HOME 沙箱：主进程 settings / host personal 配置 / agent 配置全落沙箱，
 *     agent 运行时与 Host 层看到同一个假 Provider——步骤 3/4 可作硬判据；
 *   - 信令 Worker 本地起（wrangler dev，mobile-bridge/worker），配对 URL 落
 *     127.0.0.1（localhost 是安全上下文，Service Worker 可注册；web UI 产物
 *     经 DataChannel 从桌面拉取，无外部托管依赖）；
 *   - web 端浏览器：playwright-core + 系统Chrome/已装chromium（env
 *     ZCODE_GO_E2E_BROWSER 可注入）。
 *
 * 流程与判据（全部纳入 pass）：
 *   0. 沙箱实例过 onboarding（API key）→ composer 就绪；
 *   1. 桌面 composer 模型自动勾选（无「选择模型」占位）；
 *   1.5 预热：发消息直到假 Provider 真收到请求（agent 运行时 ↔ 假 Provider
 *      通道就绪的确定性闸门——旧版步骤 3/4 失败的根因点）；
 *   2. 移动桥 → pairingUrl（本地信令）→ web 连接 → web 模型同样自动勾选；
 *   3. 桌面发消息 → 桌面与 web 双端出现假 Provider 回复（desktop→web 同步）；
 *   4. web 发消息 → 双端回复数再 +1（web→desktop 同步）。
 *
 * 运行：node scripts/e2e/fresh-model-e2e.mjs
 * （Linux 需 Xvfb :103 在跑且 DISPLAY 指向它——CI 经 xvfb-run 包裹，
 *  脚本内 ZCODE_GO_E2E_DISPLAY 控制 app 实例的 display。）
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REAL_STATE_DIR = join(homedir(), ".zcode-go");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = join(REPO, "mobile-bridge", "worker");
const WRANGLER_ENTRY = join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const ELECTRON = process.env.ZCODE_GO_E2E_APP_BIN ?? join(REAL_STATE_DIR, "electron", "zcode");
const playwrightEntry = join(REPO, "node_modules", "playwright-core", "index.mjs");
const CDP_PORT = 9335;
const PROFILE_TAG = "zg-fresh-e2e-profile";
const REPLY_TOKEN = "ZGFRESHOK";

const E2E_DISPLAY = process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103";
const ws = join(tmpdir(), `zg-fresh-e2e-${Date.now()}`);
const sandboxHome = join(ws, "home");
const routesPath = join(ws, "routes.json");
const providerLog = join(ws, "provider.log.jsonl");
const providerPortFile = join(ws, "provider.port");
const appLog = join(ws, "app.log");
const wranglerLog = join(ws, "wrangler.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const httpGet = (port, path) =>
  new Promise((resolve, reject) => {
    const req = require("node:http").get({ host: "127.0.0.1", port, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
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

/** web 端浏览器可执行文件：env 注入 > playwright 自带（install 过才有）> 系统 Chrome。 */
function resolveBrowserPath() {
  const candidates = [
    process.env.ZCODE_GO_E2E_BROWSER,
    join(homedir(), ".cache", "ms-playwright"), // 目录存在与否在调用方按 chromium.executablePath() 判
    ...(process.platform === "win32"
      ? [
          join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : []),
    ...(process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.endsWith("ms-playwright")) continue; // 目录本身不是可执行文件
    try {
      if (existsSync(c)) return c;
    } catch { /* 无权限按不存在 */ }
  }
  return null;
}

async function cdp() {
  const targets = JSON.parse(await httpGet(CDP_PORT, "/json/list"));
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
  // CDP 调用一律 30s 超时：WS 静默死亡/渲染进程停摆时 evaluate 永不回包
  //（windows 实测桥 Stop/Start 处悬死 17 分钟靠熔断收场）——超时转 reject
  // 走有界失败路径
  const ev = (expr) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      reject(new Error("CDP evaluate 超时（30s）"));
    }, 30_000);
    pending.set(mid, (m) => {
      clearTimeout(timer);
      if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 200)));
      else resolve(m.result?.result?.value);
    });
    ws0.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  const input = (method, params) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => {
        pending.delete(mid);
        reject(new Error(`CDP Input.${method} 超时（30s）`));
      }, 30_000);
      pending.set(mid, () => {
        clearTimeout(timer);
        resolve();
      });
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
  /** 点击编辑器 → 全选清空 → 输入文本。提交统一走发送按钮可信点击（CDP+Lexical
   *  下 Enter 键序不可靠——goal E2E 的既证路径）。 */
  const trustedTypeAt = async (text, x, y) => {
    await trustedClick(x, y);
    await trustedSelectAll();
    await input("insertText", { text });
    await sleep(400);
  };
  return { ev, trustedClick, trustedTypeAt, close: () => ws0.close() };
}

let appProcPid = null;
let appExitInfo = null;

/** 应用 iframe 精确选择器（evaluate 内联用；泛匹配会撞上 UI 动态插入的
 * 其它 iframe——命令面板预览等，ubuntu CI 实测步骤 4 因此点错 composer）。 */
function killProcTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch { /* 进程已退 */ }
}

function killAppInstance() {
  killProcTree(appProcPid);
  appProcPid = null;
  // Linux 追加 /proc environ 前缀清杀（Electron 重写 argv 后 cmdline 不可辨；
  // 只杀本轮沙箱 HOME 前缀，绝不误杀真实实例）
  if (process.platform === "linux") {
    for (const d of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        if (process.pid === Number(d)) continue;
        const env = readFileSync(join("/proc", d, "environ"), "utf8");
        if (env.includes(`HOME=${join(tmpdir(), "zg-fresh-e2e-")}`)) process.kill(Number(d), "SIGTERM");
      } catch { /* 进程已退/无权限 */ }
    }
  }
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require("node:net").createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
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
let wranglerProc = null;
let wranglerPort = 0;
let browser = null;
try {
  if (!existsSync(ELECTRON)) throw new Error(`E2E app 不存在：${ELECTRON}（可用 ZCODE_GO_E2E_APP_BIN 注入）`);
  if (!existsSync(WRANGLER_ENTRY)) throw new Error(`wrangler 不可用：${WRANGLER_ENTRY}（mobile-bridge/worker 需先安装依赖）`);
  if (!existsSync(playwrightEntry)) throw new Error(`playwright-core 不可用：${playwrightEntry}`);
  if (process.platform === "linux" && !process.env.ZCODE_GO_E2E_DISPLAY) {
    try {
      const xvfbOk = require("node:child_process").execSync("pgrep -x Xvfb", { stdio: "pipe" }).toString().trim();
      if (!xvfbOk) throw new Error("Xvfb 未运行");
    } catch {
      throw new Error("Xvfb 未运行（默认 DISPLAY :103：Xvfb :103 -screen 0 1920x1080x24；或经 ZCODE_GO_E2E_DISPLAY 注入 CI 动态 display）");
    }
  }
  // Windows 下动态 import 绝对路径必须是 file:// URL（D:\... 会报
  // "Only URLs with a scheme in: file..."）
  const { chromium } = await import(pathToFileURL(playwrightEntry).href);
  // playwright 自带浏览器优先（CI 经 install 装的版本与应用同源），系统 Chrome 兜底
  let browserPath = null;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) browserPath = p;
  } catch { /* 未 install */ }
  browserPath = browserPath ?? resolveBrowserPath();
  console.log(`browser: ${browserPath ?? "(playwright 默认解析)"}`);

  // 前置清理：旧沙箱实例占 CDP 端口会劫持本轮连接
  try { killAppInstance(); await sleep(1500); } catch { /* 尽力而为 */ }

  // ── 0. HOME 沙箱 + 假 Provider + 本地信令 Worker ──
  mkdirSync(join(sandboxHome, ".zcode", "v2"), { recursive: true });
  mkdirSync(join(sandboxHome, ".zcode-go"), { recursive: true });
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
  const realProviderRuntime = join(homedir(), ".zcode", "v2", "runtime", "provider");
  if (process.env.ZCODE_GO_E2E_SKIP_ACTIVE_SEED !== "1" && existsSync(realProviderRuntime)) {
    cpSync(realProviderRuntime, join(sandboxHome, ".zcode", "v2", "runtime", "provider"), { recursive: true });
  }
  writeFileSync(routesPath, JSON.stringify([
    { match: ".", content: `${REPLY_TOKEN} 同步验证回复已收到。` },
  ], null, 1));
  providerProc = spawn(process.execPath, [
    join(REPO, "scripts", "e2e", "fake-provider.mjs"),
    "--port-file", providerPortFile, "--script", routesPath, "--log", providerLog,
  ], { stdio: "ignore" });
  let providerPort = 0;
  for (let i = 0; i < 50 && !providerPort; i += 1) {
    try { providerPort = Number(readFileSync(providerPortFile, "utf8").trim()) || 0; } catch { /* 等待 */ }
    if (!providerPort) await sleep(200);
  }
  if (!providerPort) throw new Error("假 Provider 未就绪");

  wranglerPort = await pickFreePort();
  wranglerProc = spawn(process.execPath, [
    WRANGLER_ENTRY, "dev", "--port", String(wranglerPort), "--ip", "127.0.0.1",
  ], { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"] });
  wranglerProc.stdout.on("data", (c) => appendFileSync(wranglerLog, c));
  wranglerProc.stderr.on("data", (c) => appendFileSync(wranglerLog, c));
  let wranglerReady = false;
  for (let i = 0; i < 60 && !wranglerReady; i += 1) {
    try {
      const body = await httpGet(wranglerPort, "/");
      wranglerReady = body.length > 0;
    } catch { /* 等待 */ }
    if (!wranglerReady) await sleep(1000);
  }
  if (!wranglerReady) throw new Error(`信令 Worker 未就绪（看 ${wranglerLog}）`);

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
            api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${providerPort}/v1` },
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
  console.log(`0a. sandbox=${sandboxHome} provider=${providerPort} signaling=127.0.0.1:${wranglerPort}`);

  // ── 0b. 启动沙箱 E2E 实例（HOME 隔离 + 本地信令 + DISPLAY 隔离） ──
  if (process.platform === "win32") {
    mkdirSync(join(ws, "tmp"), { recursive: true });
    mkdirSync(join(sandboxHome, "AppData", "Roaming"), { recursive: true });
    mkdirSync(join(sandboxHome, "AppData", "Local"), { recursive: true });
  }
  const appArgs = [
    "--lang=zh-CN",
    `--user-data-dir=${join(ws, PROFILE_TAG)}`,
    `--remote-debugging-port=${CDP_PORT}`,
    // 桥 PC 的 host candidates 去 mDNS 混淆（裸 IP 同机直连——本环境无
    // mDNS 解析器，混淆名会令 ICE 全候选失败；Chromium 开关经 argv 透传）
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    ...(process.platform === "linux" ? ["--no-sandbox"] : ["--disable-gpu"]),
  ];
  // 受控 env（不整包继承：宿主 ZCODE_* 会击穿沙箱语义）；信令指本地 Worker
  const appEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "zh_CN.UTF-8",
    HOME: sandboxHome,
    ZCODE_GO_SIGNALING_ORIGIN: `http://127.0.0.1:${wranglerPort}`,
    ZCODE_GO_BRIDGE_ICE_SERVERS: "",
    ...(process.platform === "linux"
      ? {
          DISPLAY: E2E_DISPLAY,
          ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          USERPROFILE: sandboxHome,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
          SYSTEMDRIVE: process.env.SYSTEMDRIVE,
          PROGRAMDATA: process.env.PROGRAMDATA,
          ...(process.env.ALLUSERSPROFILE ? { ALLUSERSPROFILE: process.env.ALLUSERSPROFILE } : {}),
          ...(process.env.COMPUTERNAME ? { COMPUTERNAME: process.env.COMPUTERNAME } : {}),
          ...(process.env.USERNAME ? { USERNAME: process.env.USERNAME } : {}),
          ...(process.env.USERDOMAIN ? { USERDOMAIN: process.env.USERDOMAIN } : {}),
          ...(process.env.OS ? { OS: process.env.OS } : {}),
          ...(process.env.NUMBER_OF_PROCESSORS ? { NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS } : {}),
          ...(process.env.PROCESSOR_ARCHITECTURE ? { PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE } : {}),
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
  const appProc = spawn(ELECTRON, appArgs, { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
  appProcPid = appProc.pid;
  appProc.on("exit", (code, signal) => { appExitInfo = { code, signal }; });
  appProc.stdout.on("data", (c) => appendFileSync(appLog, c));
  appProc.stderr.on("data", (c) => appendFileSync(appLog, c));

  let c = null;
  for (let i = 0; i < 40 && !c; i += 1) {
    await sleep(1500);
    c = await cdp().catch(() => null);
  }
  if (!c) {
    const exitInfo = appExitInfo ? `app exited code=${appExitInfo.code} signal=${appExitInfo.signal}` : "app still running";
    throw new Error(`E2E 实例 CDP 未就绪（${exitInfo}；看 app.log）`);
  }
  const { ev, trustedClick } = c;

  // ── 0c. onboarding（API key 路径，双语匹配） ──
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
  console.log("0. desktop booted:", composerOk);
  if (!composerOk) {
    const dump = await ev(`(() => {
      const btns = Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null)
        .map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 15);
      return JSON.stringify({ body: document.body.innerText.slice(0, 400), btns });
    })()`);
    throw new Error(`onboarding 未完成（dump：${dump}）`);
  }

  // ── 1. 桌面模型自动勾选 ──
  const desktopModel = await ev(`(() => {
    const t = document.querySelector('[data-composer-leading-content], .composer-provider-prefix, [data-testid="composer-model"]');
    const text = t ? t.textContent || "" : document.body.innerText;
    return text.includes("选择模型") ? "placeholder" : "selected";
  })()`);
  console.log("1. desktop model:", desktopModel);

  /** 输入 → 等发送按钮可用 → 可信点击（goal E2E 既证路径）。 */
  const sendViaComposer = async (text) => {
    await ev(`document.querySelector('[contenteditable="true"]')?.focus(); "ok"`);
    const rect = await ev(`(() => { const r = document.querySelector('[contenteditable="true"]').getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`);
    const { x, y } = JSON.parse(rect);
    await c.trustedTypeAt(text, x, y);
    for (let i = 0; i < 40; i += 1) {
      const state = await ev(`(() => {
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
    await trustedClick(b.x, b.y);
    return true;
  };

  // ── 1.5 预热：agent 运行时 ↔ 假 Provider 通道（旧版 3/4 失败的根因点） ──
  let prewarmed = false;
  for (let attempt = 1; attempt <= 3 && !prewarmed; attempt += 1) {
    const sent = await sendViaComposer(`预热 ${attempt}：请回复`);
    console.log(`1.5 prewarm ${attempt} sent:`, sent);
    for (let i = 0; i < 45 && !prewarmed; i += 1) {
      await sleep(2000);
      prewarmed = providerEntries().length > 0;
    }
  }
  console.log("1.5 agent↔fake-provider channel:", prewarmed);
  if (!prewarmed) throw new Error("假 Provider 通道未就绪（agent 运行时未读到沙箱 provider 配置；看 app.log）");

  // ── 2. 移动桥 → 本地信令 pairingUrl → web 连接 ──
  // 桥启停各带一次重试（windows 实测此处的 evaluate 会偶发悬死/超时）
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ev("window.zcode.zcodeGoMobileBridgeStop()");
      break;
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(2000);
    }
  }
  await sleep(2000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ev("window.zcode.zcodeGoMobileBridgeStart()");
      break;
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(2000);
    }
  }
  let qr = "";
  const qrDeadline = Date.now() + 90_000; // 总时限：逐次 30s 超时会把轮数放大成 21 分钟
  for (let i = 0; i < 40 && !qr && Date.now() < qrDeadline; i += 1) {
    await sleep(1200);
    // 桥启动窗口期（预生成 offer ≤8s）主进程忙，status IPC 可能悬死——
    // 超时按本轮无响应跳过继续轮询（windows 实测），不作为致命错误
    const st = await ev("window.zcode.zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))").catch(() => null);
    if (!st) continue;
    try {
      const parsed = JSON.parse(st);
      if (parsed.pairingUrl) qr = parsed.pairingUrl;
    } catch { /* 坏响应按无响应处理 */ }
  }
  if (!qr) {
    // 看门狗文件直读：主线程冻结时 app.log 不再更新，但 worker 线程仍能
    // 写文件（windows 冻结排查的决定性证据）。
    try {
      const wd = join(sandboxHome, ".zcode-go", "mobile-bridge-watchdog.log");
      if (existsSync(wd)) console.log("watchdog.log:", readFileSync(wd, "utf8").trim().split("\n").slice(-5).join(" | "));
    } catch { /* 尽力而为 */ }
    throw new Error("pairingUrl 未就绪（移动桥启动失败；看 app.log / watchdog.log）");
  }
  if (!qr.startsWith(`http://127.0.0.1:${wranglerPort}`)) {
    throw new Error(`pairingUrl 未指向本地信令：${qr}（ZCODE_GO_SIGNALING_ORIGIN 未生效？）`);
  }
  console.log(`2. pairing url ready: ${qr}`);
  const pairingParams = new URL(qr).searchParams;
  console.log(`2. pairing params: t=${pairingParams.get("t")} i=${pairingParams.get("i")} p.len=${pairingParams.get("p")?.length ?? 0}`);
  // 等桥真正就绪（waiting-mobile = 房间已登记 + secret 已存 + 信令 WS 已
  // register）再开浏览器——pairingUrl 在本地生成即可读，秒连会撞 desktop_
  // offline/bad_secret（mac CI 实测三连快速失败即此竞态）
  let bridgeReady = false;
  const readyDeadline = Date.now() + 90_000;
  for (let i = 0; i < 30 && !bridgeReady && Date.now() < readyDeadline; i += 1) {
    const st = JSON.parse(await ev("window.zcode.zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))").catch(() => "{}"));
    if (st.state === "waiting-mobile" || st.state === "connected") bridgeReady = true;
    else await sleep(1000);
  }
  console.log(`2. bridge ready (waiting-mobile): ${bridgeReady}`);

  browser = await chromium.launch({
    ...(browserPath ? { executablePath: browserPath } : {}),
    headless: false,
    // web 侧同样去 mDNS 混淆：CI runner 无 mDNS 解析器，页面应答里的 .local
    // 候选桌面端解析不了 → ICE 失败（p2pFailed，实测 ubuntu CI 间歇性命中）
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  // web 侧 JS 异常/报错收集（iframe 内的未捕获异常同页捕获）——错误边界
  // （「这块界面出了点问题」）只吞 UI 不吐日志，这里留下定位线索
  const webErrors = [];
  page.on("pageerror", (e) => { webErrors.push(`[pageerror] ${String(e).slice(0, 400)}`); });
  page.on("console", (m) => {
    if (m.type() === "error") webErrors.push(`[console.error] ${m.text().slice(0, 400)}`);
  });
  await page.goto(qr, { waitUntil: "domcontentloaded" });
  let webReady = false;
  let webRetries = 0;
  for (let i = 0; i < 90 && !webReady; i += 1) {
    await sleep(2000);
    const st = await page.evaluate(() => {
      const fs = document.querySelectorAll('iframe[src="/app/"]');
      if (!fs.length) return { f: 0 };
      const d = fs[fs.length - 1].contentDocument;
      if (!d || !d.body || !d.body.innerText.trim()) return { f: 0 };
      return { f: 1, loading: !!d.querySelector("[data-testid=root-startup-loading]") };
    }).catch(() => ({ f: 0 }));
    if (st.f && !st.loading) webReady = true;
    if (!webReady && webRetries < 5) {
      // ICE 偶发失败（页面错误卡片 + 重试按钮）：点重连 + 调桌面 Start 恢复
      // 被挂起的信令（pc 连上后信令挂起省流量，页面重试的 req-offer 需要
      // Start 唤醒——与产品「重开对话框=恢复信令」同一条路径）
      const retryable = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button"))
          .find(b => b.offsetParent !== null && ["重试", "Retry"].includes((b.innerText || "").trim()));
        if (!btn) return false;
        btn.click();
        return true;
      }).catch(() => false);
      if (retryable) {
        webRetries += 1;
        console.log(`2. web pairing retry #${webRetries}（page reload + desktop Start）`);
        await ev("window.zcode.zcodeGoMobileBridgeStart()").catch(() => {});
        // 退避：Start 恢复挂起信令（WS 重连 + register + 房间续期）需 1-2s
        // 落地，页面立即重载会再撞 desktop_offline 形成空转
        await sleep(6000);
      }
    }
  }
  console.log("2. web app ready:", webReady);
  if (!webReady) {
    const pageState = await page.evaluate(() => ({
      url: location.href.slice(0, 120),
      meta: document.querySelector("#meta")?.textContent ?? "",
      body: document.body.innerText.slice(0, 300),
    })).catch((e) => ({ err: String(e) }));
    console.log("2. web page state:", JSON.stringify(pageState, null, 1));
    await page.screenshot({ path: join(ws, "web-not-ready.png") }).catch(() => {});
    throw new Error(`web 端未就绪（截图 ${join(ws, "web-not-ready.png")}；看 ${wranglerLog}）`);
  }
  await sleep(2500);
  // web 端 onboarding：web 远程是独立浏览器态（桌面过完不代表 web 过），
  // 显示「连接账号」时走同款 API key 路径（设置经 shim RPC 落桌面侧，幂等）。
  // 状态机覆盖：入口按钮态 / API-key 表单态（输入框出现即先填再继续）。
  // 停滞检测：同一动作连做 5 步无进展 → 转储 body（重试后设置部分同步会
  // 出现「API Key/BigModel」选择页等中间态，便于定位卡点）。
  let lastAction = "", stagnant = 0;
  for (let step = 0; step < 30; step += 1) {
    const r = await page.evaluate(() => {
      const d = document.querySelector('iframe[src="/app/"]')?.contentDocument;
      if (!d) return "wait";
      if (d.querySelector('[contenteditable="true"]')) return "composer";
      const btns = Array.from(d.querySelectorAll("button")).filter(b => b.offsetParent !== null);
      const input = Array.from(d.querySelectorAll("input")).find(i => i.offsetParent !== null);
      if (input) { return "fill"; }
      const apikey = btns.find(b => /使用 API key|Use API key/i.test(b.innerText || ""));
      if (apikey) { apikey.click(); return "apikey"; }
      const apiTab = btns.find(b => /^(API Key|API key|Use API Key)$/i.test((b.innerText || "").trim()));
      if (apiTab) { apiTab.click(); return "apikey"; }
      const next = btns.find(b => ["继续", "Continue"].includes((b.innerText || "").trim()) && !b.disabled);
      if (next) { next.click(); return "continue"; }
      const skip = btns.find(b => ["跳过", "Skip", "暂时跳过"].includes((b.innerText || "").trim()) && !b.disabled);
      if (skip) { skip.click(); return "skip"; }
      return "wait";
    }).catch(() => "wait");
    if (r === "composer") break;
    stagnant = r === lastAction ? stagnant + 1 : 0;
    lastAction = r;
    if (stagnant === 4) {
      const stuck = await page.evaluate(
        () => document.querySelector('iframe[src="/app/"]')?.contentDocument?.body.innerText.slice(0, 200) ?? "",
      ).catch(() => "");
      console.log(`2. web onboarding stagnant (${r}): ${JSON.stringify(stuck)}`);
    }
    if (r === "fill" || r === "apikey") {
      await sleep(1200);
      await page.evaluate(() => {
        const d = document.querySelector('iframe[src="/app/"]')?.contentDocument;
        if (!d) return;
        const inp = Array.from(d.querySelectorAll("input")).find(i => i.offsetParent !== null);
        if (!inp) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, "sk-zcode-go-e2e");
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }).catch(() => {});
      await sleep(600);
      await page.evaluate(() => {
        const d = document.querySelector('iframe[src="/app/"]')?.contentDocument;
        if (!d) return;
        const next = Array.from(d.querySelectorAll("button"))
          .find(b => b.offsetParent !== null && ["继续", "Continue"].includes((b.innerText || "").trim()) && !b.disabled);
        next?.click();
      }).catch(() => {});
    }
    await sleep(1200);
  }
  // web composer 就绪 + 模型勾选（以 composer 实际存在为准——旧检查只认
  // 「选择模型」占位文案，onboarding 页会误报 selected）
  let webComposerOk = false;
  for (let i = 0; i < 40 && !webComposerOk; i += 1) {
    webComposerOk = await page.evaluate(
      () => !!document.querySelector('iframe[src="/app/"]')?.contentDocument?.querySelector('[contenteditable="true"]'),
    ).catch(() => false);
    if (!webComposerOk) await sleep(1500);
  }
  const webModel = await page.evaluate(() => {
    const d = document.querySelector('iframe[src="/app/"]')?.contentDocument;
    if (!d) return "no-frame";
    if (!d.querySelector('[contenteditable="true"]')) return "no-composer";
    return d.body.innerText.includes("选择模型") ? "placeholder" : "selected";
  }).catch(() => "err");
  const webBody = await page.evaluate(
    () => document.querySelector('iframe[src="/app/"]')?.contentDocument?.body.innerText.slice(0, 200) ?? "",
  ).catch(() => "");
  console.log(`2. web composer: ${webComposerOk} model: ${webModel} body: ${JSON.stringify(webBody.slice(0, 120))}`);
  // web 打开既有会话：onboarding 后 composer 多停在空白新会话（问候语态），
  // 双向同步断言要求两端查看同一会话——点侧栏第一个任务行打开桌面预热
  // 会话（唯一会话；对已打开会话重复点击幂等）
  if (webComposerOk) {
    await page.evaluate(() => {
      const d = document.querySelector('iframe[src="/app/"]')?.contentDocument;
      const row = d?.querySelector('li[data-testid^="task-item-"]');
      row?.click();
    }).catch(() => {});
    await sleep(2500);
    const body2 = await page.evaluate(
      () => document.querySelector('iframe[src="/app/"]')?.contentDocument?.body.innerText.slice(0, 300) ?? "",
    ).catch(() => "");
    console.log(`2. after task-row click body: ${JSON.stringify(body2.slice(0, 160))}`);
  }

  // 双端回复计数器（假 Provider 回复带 REPLY_TOKEN；预热轮的回复计入基线）
  const webCount = () => page.evaluate(
    () => (document.querySelector('iframe[src="/app/"]')?.contentDocument?.body.innerText.match(/ZGFRESHOK/g) || []).length,
  ).catch(() => 0);
  const dtCount = () => ev(`(document.body.innerText.match(/ZGFRESHOK/g) || []).length`);
  const waitBoth = async (before, tries) => {
    let w = false, d = false;
    for (let i = 0; i < tries; i += 1) {
      await sleep(1500);
      if (!w && (await webCount()) > before.web) w = true;
      if (!d && (await dtCount()) > before.dt) d = true;
      if (w && d) break;
    }
    return { web: w, desk: d };
  };

  // ── 3. 桌面发 → 双端收回复（desktop→web 同步） ──
  const b1 = { web: await webCount(), dt: await dtCount() };
  const sent3 = await sendViaComposer("桌面端发起同步验证");
  const r3 = sent3 ? await waitBoth(b1, 28) : { web: false, desk: false };
  console.log(`3. desktop→web: sent=${sent3} web=${r3.web} desktop=${r3.desk} (base web=${b1.web} dt=${b1.dt})`);
  if (!r3.web) {
    const webState = await page.evaluate(() => {
      const d = document.querySelector('iframe[src="/app/"]')?.contentDocument;
      return {
        body: d?.body?.innerText.slice(0, 400) ?? "(no-frame)",
        composers: d?.querySelectorAll('[contenteditable="true"]').length ?? -1,
        url: d?.location?.href ?? "",
      };
    }).catch((e) => ({ err: String(e) }));
    console.log("3. web state (sync miss):", JSON.stringify(webState, null, 1));
  }

  // ── 4. web 发 → 双端回复再 +1（web→desktop 同步） ──
  let r4 = { web: false, desk: false };
  try {
    const composer = page.frameLocator('iframe[src="/app/"]').locator('[contenteditable="true"]').first();
    await composer.click({ timeout: 15000 });
    await composer.type("web 端发起同步验证");
    await page.waitForTimeout(300);
    await composer.press("Enter");
  } catch (e) {
    await page.screenshot({ path: join(ws, "web-step4-fail.png") }).catch(() => {});
    const webState = await page.evaluate(() => ({
      iframes: document.querySelectorAll('iframe[src="/app/"]').length,
      composers: document.querySelector('iframe[src="/app/"]')?.contentDocument?.querySelectorAll('[contenteditable="true"]').length ?? -1,
      body: document.querySelector('iframe[src="/app/"]')?.contentDocument?.body?.innerText.slice(0, 300) ?? "",
    })).catch(() => ({}));
    console.log("4. web composer 失败（截图已存）：", JSON.stringify(webState), String(e).slice(0, 120));
  }
  const b2 = { web: await webCount(), dt: await dtCount() };
  r4 = await waitBoth(b2, 40);
  console.log(`4. web→desktop: web=${r4.web} desktop=${r4.desk} (base web=${b2.web} dt=${b2.dt})`);

  pass = composerOk && desktopModel === "selected" && webReady && webComposerOk && webModel === "selected"
    && r3.web && r3.desk && r4.web && r4.desk;
  if (!pass && webErrors.length > 0) {
    console.log("web JS errors（最近 8 条）:");
    for (const e of webErrors.slice(-8)) console.log("  ", e);
  }
} catch (error) {
  console.error("E2E 失败:", error.message);
  try {
    const tail = readFileSync(appLog, "utf8").trim().split("\n").slice(-30).join("\n");
    console.error(`app.log 尾部：\n${tail}`);
  } catch { /* 无日志 */ }
  try {
    const tail = readFileSync(wranglerLog, "utf8").trim().split("\n").slice(-15).join("\n");
    console.error(`wrangler.log 尾部：\n${tail}`);
  } catch { /* 无日志 */ }
} finally {
  try { await browser?.close(); } catch { /* 尽力而为 */ }
  try { killAppInstance(); } catch { /* 尽力而为 */ }
  await sleep(1500);
  try { providerProc?.kill(); } catch { /* 尽力而为 */ }
  killProcTree(wranglerProc?.pid ?? null);
  if (pass) { try { rmSync(ws, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  else console.log(`沙箱保留于 ${ws}（app.log / provider.log.jsonl / wrangler.log）`);
}
console.log(pass ? "FRESH-MODEL-SYNC-OK ✓" : "FRESH-MODEL-SYNC-FAIL ✗");
process.exit(pass ? 0 : 1);
