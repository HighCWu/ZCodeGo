#!/usr/bin/env node
/**
 * zcode-go E2E：takeover 插件全链路（官方开源版 + /zcode-go hook → 拉起接管）。
 *
 * 链路（全部真实组件，零 mock）：
 *   官方开源版 Electron（CI @ 锚点构建 / 本地 /opt/ZCode）
 *     → workspace 插件目录发现 zcode-go 插件（sync-plugin.mjs 免 UI 安装，
 *       与真实安装产物同构：plugins/zcode-go + marketplace.json）
 *     → 会话输入 /zcode-go 提交 → UserPromptSubmit hook 拦截（continue:false，
 *       模型零参与）
 *     → hook 在官方进程树内祖先链回溯探测官方安装 → 写 ~/.zcode-go/official.json
 *     → detached 拉起 scripts/launch-zcode-go.sh（ZCODE_GO_TAKEOVER=1）
 *
 * 判据（全绿）：
 *   1. hook 生效：提交后官方无模型回合（provider 零请求）+ 空会话被清理
 *   2. official.json 落盘且指向真实官方安装（bin/runtimeBundle 均存在）
 *   3. zcode-go 桌面拉起：~/.zcode-go/desktop.pid 落盘且进程存活
 *
 * 运行：node scripts/e2e/takeover-e2e.mjs（需 Xvfb :103；ZCODE_OFFICIAL_BIN
 * 可注入官方 bin，缺省 /opt/ZCode/zcode——CI 由工作流传入锚点构建产物）。
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OFFICIAL_BIN = process.env.ZCODE_OFFICIAL_BIN?.trim() || "/opt/ZCode/zcode";
const CDP_PORT = 9338;
const PROFILE_TAG = "zg-takeover-e2e-profile";

const E2E_DISPLAY = process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103";
const ws = join(tmpdir(), `zg-takeover-e2e-${Date.now()}`);
const sandboxHome = join(ws, "home");
const sandboxWorkspace = join(sandboxHome, ".zcode", "workspace", "default");
const routesPath = join(ws, "routes.json");
const providerLog = join(ws, "provider.log.jsonl");
const portFile = join(ws, "provider.port");
const appLog = join(ws, "official-app.log");

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
  const page = targets.find((t) => t.type === "page" && /ZCode/i.test(t.title));
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
  return { ev, input, trustedClick, close: () => ws0.close() };
}

let appProcPid = null;
let appExitInfo = null;
function killAppInstance() {
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
  if (process.platform === "linux") {
    for (const d of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        if (process.pid === Number(d)) continue;
        const env = readFileSync(join("/proc", d, "environ"), "utf8");
        if (env.includes(`HOME=${join(tmpdir(), "zg-takeover-e2e-")}`)) process.kill(Number(d), "SIGTERM");
      } catch { /* 进程已退/无权限 */ }
    }
  }
}

const E2E_FUSE_MS = (Number(process.env.ZCODE_GO_E2E_FUSE_MS) || 15) * 60_000;
setTimeout(() => {
  console.error(`E2E 硬超时熔断（${E2E_FUSE_MS}ms）触发，强制退出`);
  try { killAppInstance(); } catch { /* 尽力而为 */ }
  process.exit(1);
}, E2E_FUSE_MS).unref?.();

let pass = false;
let providerProc = null;
try {
  if (!existsSync(OFFICIAL_BIN)) throw new Error(`官方二进制不存在：${OFFICIAL_BIN}（env ZCODE_OFFICIAL_BIN 注入）`);
  if (!existsSync(join(REPO, "plugin", "hooks", "zcode-go.cjs"))) throw new Error("插件未构建：先 node plugin/build.mjs");
  if (process.platform === "linux" && !process.env.ZCODE_GO_E2E_DISPLAY) {
    try {
      const xvfbOk = require("node:child_process").execSync("pgrep -x Xvfb", { stdio: "pipe" }).toString().trim();
      if (!xvfbOk) throw new Error("Xvfb 未运行");
    } catch {
      throw new Error("Xvfb 未运行（默认 DISPLAY :103：Xvfb :103 -screen 0 1920x1080x24）");
    }
  }
  try { killAppInstance(); await sleep(1500); } catch { /* 尽力而为 */ }

  // ── 0. HOME 沙箱 + 假 Provider（官方 onboarding 的 API key 路径同款） ──
  mkdirSync(join(sandboxHome, ".zcode", "v2"), { recursive: true });
  mkdirSync(sandboxWorkspace, { recursive: true });
  // 官方 app 冷启动需要 builtin Active 物化（同其余 E2E 的种子逻辑）。
  const realProviderRuntime = join(homedir(), ".zcode", "v2", "runtime", "provider");
  if (process.env.ZCODE_GO_E2E_SKIP_ACTIVE_SEED !== "1" && existsSync(realProviderRuntime)) {
    cpSync(realProviderRuntime, join(sandboxHome, ".zcode", "v2", "runtime", "provider"), { recursive: true });
  }
  writeRoutes([{ match: "(?i).", content: "ok" }]);
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

  // ── 1. 免 UI 安装插件（真实环境同款路径：cli config 的 plugins.dirs 直挂
  //     插件源目录——inline 市场 + enabledPlugins 启用，零 RPC 文件级安装；
  //     launcher 由 hook 内置链定位 repo/scripts/launch-zcode-go.sh） ──
  mkdirSync(join(sandboxHome, ".zcode", "cli"), { recursive: true });
  writeFileSync(join(sandboxHome, ".zcode", "cli", "config.json"), JSON.stringify({
    plugins: {
      enabledPlugins: { "zcode-go@inline": true },
      dirs: [join(REPO, "plugin")],
    },
  }, null, 2));
  if (!existsSync(join(REPO, "plugin", "hooks", "hooks.json"))) {
    throw new Error("插件源缺失（plugin/hooks/hooks.json）");
  }
  console.log("1. plugin installed (inline dirs):", join(REPO, "plugin"));

  // ── 2. 启动官方开源版（HOME 沙箱；ZCODE_OFFICIAL_BIN 透传给 hook→launcher 链） ──
  if (process.platform === "win32") {
    mkdirSync(join(ws, "tmp"), { recursive: true });
    mkdirSync(join(sandboxHome, "AppData", "Roaming"), { recursive: true });
    mkdirSync(join(sandboxHome, "AppData", "Local"), { recursive: true });
  }
  const appArgs = [
    "--lang=zh-CN",
    `--user-data-dir=${join(ws, PROFILE_TAG)}`,
    `--remote-debugging-port=${CDP_PORT}`,
    ...(process.platform === "linux" ? ["--no-sandbox"] : ["--disable-gpu"]),
  ];
  const appEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "zh_CN.UTF-8",
    HOME: sandboxHome,
    // hook（官方进程树内）→ launch-zcode-go.sh → ensure-official-electron.mjs
    // 的官方 bin 解析链全部继承本 env——CI 上锚点产物路径由此传入。
    ZCODE_OFFICIAL_BIN: OFFICIAL_BIN,
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
  };
  const appProc = spawn(OFFICIAL_BIN, appArgs, { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
  appProcPid = appProc.pid;
  appProc.on("exit", (code, signal) => { appExitInfo = { code, signal }; });
  appProc.stdout.on("data", (c) => appendFileSync(appLog, c));
  appProc.stderr.on("data", (c) => appendFileSync(appLog, c));
  console.log("2. official app launched:", OFFICIAL_BIN);

  let c = null;
  for (let i = 0; i < 40 && !c; i += 1) {
    await sleep(1500);
    c = await cdp().catch(() => null);
  }
  if (!c) {
    const exitInfo = appExitInfo ? `app exited code=${appExitInfo.code} signal=${appExitInfo.signal}` : "app still running";
    throw new Error(`官方实例 CDP 未就绪（${exitInfo}；看 official-app.log）`);
  }
  const { ev } = c;

  // ── 3. onboarding（API key 路径；官方与 fork 同款流程） ──
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
  console.log("3. onboarding composer:", composerOk);
  if (!composerOk) {
    const dump = await ev(`document.body.innerText.slice(0, 400)`);
    console.log("onboarding stuck dump:", dump);
    throw new Error("官方 onboarding 未完成（见上 dump；强更/登录墙？）");
  }

  // ── 4. 提交 /zcode-go（hook 拦截 → 探测官方 → 拉起接管） ──
  const officialJsonPath = join(sandboxHome, ".zcode-go", "official.json");
  const pidPath = join(sandboxHome, ".zcode-go", "desktop.pid");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 可信点击编辑器拿焦点 → 逐字符键入（Lexical 稳定）→ Enter 提交。
    const er = await ev(`(() => { const r = document.querySelector('[contenteditable="true"]')?.getBoundingClientRect(); return r ? JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}) : null; })()`);
    if (!er) { await sleep(1500); continue; }
    const { x, y } = JSON.parse(er);
    await c.trustedClick(Math.round(x), Math.round(y));
    await ev(`document.querySelector('[contenteditable="true"]')?.focus(); "ok"`);
    for (const ch of "/zcode-go") {
      await c.input("dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
    }
    await sleep(500);
    const typed = await ev(`(document.querySelector('[contenteditable="true"]')?.innerText || "").includes("/zcode-go")`);
    if (!typed) { await sleep(1500); continue; }
    await c.input("dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await c.input("dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(1000);
    // Enter 在 CDP+Lexical 下不稳定：回落到发送按钮的可信点击。
    const submitStill = await ev(`(() => { const ed = document.querySelector('[contenteditable="true"]'); const b = ed?.closest('form')?.querySelector('button[type="submit"]'); return b && !b.disabled ? JSON.stringify({x:b.getBoundingClientRect().x+b.offsetWidth/2,y:b.getBoundingClientRect().y+b.offsetHeight/2}) : null; })()`);
    if (submitStill) {
      const s = JSON.parse(submitStill);
      await c.trustedClick(Math.round(s.x), Math.round(s.y));
    }
    break;
  }
  console.log("4. /zcode-go submitted");

  // ── 5. 断言一：hook 生效（官方零模型回合）+ official.json 落盘且真实 ──
  let officialJsonOk = false;
  let officialJson = null;
  for (let i = 0; i < 20 && !officialJsonOk; i += 1) {
    await sleep(1000);
    try {
      officialJson = JSON.parse(readFileSync(officialJsonPath, "utf8"));
      officialJsonOk = Boolean(
        officialJson.bin && officialJson.runtimeBundle && existsSync(officialJson.bin) && existsSync(officialJson.runtimeBundle),
      );
    } catch { /* 等待 hook 写入 */ }
  }
  const providerQuiet = providerEntries().length === 0;
  console.log("5a. official.json written & valid:", officialJsonOk, officialJson ? `(bin=${String(officialJson.bin).slice(0, 60)})` : "");
  console.log("5b. official made zero model calls (hook intercepted):", providerQuiet);
  if (!providerQuiet) {
    console.log("   provider log:", providerEntries().slice(-2).map((e) => (e.text || "").slice(0, 80)));
  }

  // ── 6. 断言二：zcode-go 桌面拉起（pid 落盘 + 进程存活） ──
  let goDesktopAlive = false;
  let goDesktopPid = null;
  for (let i = 0; i < 60 && !goDesktopAlive; i += 1) {
    await sleep(2000);
    try {
      goDesktopPid = Number(readFileSync(pidPath, "utf8").trim());
      if (Number.isFinite(goDesktopPid)) {
        try { process.kill(goDesktopPid, 0); goDesktopAlive = true; } catch { /* 未起/已退 */ }
      }
    } catch { /* 等待 launcher 装配+启动（ensure-official-electron + 桌面引导） */ }
  }
  console.log("6. zcode-go desktop launched & alive:", goDesktopAlive, goDesktopPid ? `(pid=${goDesktopPid})` : "");

  pass = officialJsonOk && providerQuiet && goDesktopAlive;
  if (!pass) {
    try {
      const pluginLog = readFileSync(join(sandboxHome, ".zcode-go", "plugin.log"), "utf8").trim().split("\n").slice(-10).join("\n");
      console.log("plugin.log tail:\n" + pluginLog);
    } catch { /* 无插件日志 */ }
    try {
      const launchLog = readFileSync(join(sandboxHome, ".zcode-go", "desktop-launch.log"), "utf8").trim().split("\n").slice(-10).join("\n");
      console.log("desktop-launch.log tail:\n" + launchLog);
    } catch { /* 无启动日志 */ }
  }
} catch (error) {
  console.error("E2E 失败:", error.message);
  try {
    const tail = readFileSync(appLog, "utf8").trim().split("\n").slice(-30).join("\n");
    console.error(`official-app.log 尾部：\n${tail}`);
  } catch { /* 无日志 */ }
} finally {
  try { killAppInstance(); } catch { /* 尽力而为 */ }
  await sleep(2000);
  try { providerProc?.kill(); } catch { /* 尽力而为 */ }
  if (pass) { try { rmSync(ws, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  else console.log(`沙箱保留于 ${ws}（official-app.log / provider.log.jsonl / .zcode-go/）`);
  console.log(pass ? "TAKEOVER-E2E-OK ✓" : "TAKEOVER-E2E-FAIL ✗");
  process.exit(pass ? 0 : 1);
}
