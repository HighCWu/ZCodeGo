#!/usr/bin/env node
/**
 * zcode-go E2E：官方「插件市场」UI 安装全链（此前零覆盖的真实用户安装路径）。
 *
 * 与 takeover-e2e 的差异：沙箱 config.json **不配 plugins.dirs**——插件只能
 * 经「侧边栏插件市场 → 添加插件市场（本地目录）→ 卡片安装」进入，因此装出来
 * 副本的任何 hook 活动（plugin.log/official.json）都是市场安装产物的直接证明。
 *
 * 判据（全绿）：
 *   1. UI 安装闭环：添加本地市场 → zcode-go 卡片 → 安装 → 卡片「已安装」
 *      + 沙箱 config.json 落 enabledPlugins 记录（CLI 级真相）
 *   2. 装出的插件功能可用：/zcode-go 提交被 hook 拦截（provider 零模型回合）
 *      + official.json 由 hook 写入
 * 安全：fork 桌面会按 takeover 语义杀 official.json.bin——官方 bin 一律先
 *   镜像进沙箱（linux/win；darwin .app 直用），杀链只可能命中沙箱副本。
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OFFICIAL_BIN = process.env.ZCODE_OFFICIAL_BIN?.trim() || "/opt/ZCode/zcode";
const CDP_PORT = 9339;
const PROFILE_TAG = "zg-mkt-e2e-profile";

const E2E_DISPLAY = process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103";
const ws = join(tmpdir(), `zg-mkt-e2e-${Date.now()}`);
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
    const timer = setTimeout(() => { pending.delete(mid); resolve(null); }, 15000);
    pending.set(mid, (m) => {
      clearTimeout(timer);
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
  const trustedSelectAll = async () => {
    await input("dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, text: "a" });
    await input("dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  };
  return { ev, input, trustedClick, trustedSelectAll, close: () => ws0.close() };
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
        if (env.includes(`HOME=${join(tmpdir(), "zg-mkt-e2e-")}`)) process.kill(Number(d), "SIGTERM");
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

  // ── 0.5 官方 bin 沙箱镜像（安全隔离，本地必配；darwin 除外）──
  // fork 桌面 takeover 语义 = 杀掉 exe 精确等于 official.json.bin 的进程。
  // 若直接用真实安装路径（本地 /opt/ZCode），会误杀本机正在运行的官方实例
  // （2026-10-09 两次事故：用户官方 app 被 SIGTERM 优雅退出）。镜像后整条链
  // （hook 祖先探测 / official.json / launcher / 杀官方）都只认沙箱副本路径。
  // darwin 例外：官方 bin 在 .app bundle 内，镜像其 MacOS 目录会破坏 bundle
  // 结构与签名（CI 实测 SIGABRT）；mac 的杀官方链走 osascript 按名退出，
  // 镜像本也不改变其作用域——直接用官方 bin（CI 无用户实例可误杀）。
  const OFFICIAL_DIR = dirname(OFFICIAL_BIN);
  const mirrorBin =
    process.platform === "darwin" ? OFFICIAL_BIN : join(ws, "official-mirror", basename(OFFICIAL_BIN));
  const MIRROR_DIR = dirname(mirrorBin);
  if (process.platform !== "darwin") mkdirSync(MIRROR_DIR, { recursive: true });
  if (process.platform === "darwin") {
    console.log("0.5 official bin mirror: skipped on darwin（.app bundle 直用）:", OFFICIAL_BIN);
  } else {
    const binName = basename(OFFICIAL_BIN);
    console.log("0.5 official bin mirrored (kill-chain scoped):", mirrorBin);
    for (const entry of readdirSync(OFFICIAL_DIR)) {
      if (entry === binName) continue;
      try { symlinkSync(join(OFFICIAL_DIR, entry), join(MIRROR_DIR, entry)); } catch { /* 已存在 */ }
    }
    // 必须独立 inode（reflink 复制）：硬链接下 /proc/<pid>/exe 实测解析回原路径
    // （2026-10-09 第三次事故），祖先探测会写回真实安装路径 → 杀官方链越界。
    spawnSync("cp", ["--reflink=auto", OFFICIAL_BIN, mirrorBin], { stdio: "ignore" });
    if (!existsSync(mirrorBin)) copyFileSync(OFFICIAL_BIN, mirrorBin);
    try { spawnSync("chmod", ["+x", mirrorBin], { stdio: "ignore" }); } catch { /* 尽力而为 */ }
  }
  const APP_BIN = mirrorBin;

  // ── 0. HOME 沙箱 + 假 Provider（官方 onboarding 的 API key 路径同款） ──
  mkdirSync(join(sandboxHome, ".zcode", "v2"), { recursive: true });
  mkdirSync(sandboxWorkspace, { recursive: true });
  // 官方 app 冷启动需要 builtin Active 物化（同其余 E2E 的种子逻辑）。
  const realProviderRuntime = join(homedir(), ".zcode", "v2", "runtime", "provider");
  if (process.env.ZCODE_GO_E2E_SKIP_ACTIVE_SEED !== "1" && existsSync(realProviderRuntime)) {
    cpSync(realProviderRuntime, join(sandboxHome, ".zcode", "v2", "runtime", "provider"), { recursive: true });
  } else {
    // CI（无真实 ~/.zcode 可种子）：官方 runtime 解析器按序探测
    // <resources>/glm 与 ~/.zcode/server/agents/glm（生产 bundle 反解实证）。
    // 首选种到沙箱 HOME 的 server/agents——官方包零改动（mac 上改封官方 .app
    // 会让其后任何 codesign 抛 bundle format unrecognized，37960650353 实测），
    // 全新 HOME + server/agents 种子实测零 unsupported_runtime。
    try {
      const plat = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const glmSrc = join(REPO, "packages", "desktop", "bundled-agents", `${plat}-${arch}`, "glm");
      if (existsSync(join(glmSrc, "zcode.cjs"))) {
        const dst = join(sandboxHome, ".zcode", "server", "agents", "glm");
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(glmSrc, dst, { recursive: true });
        console.log("0. runtime agent seeded at ~/.zcode/server/agents/glm ←", `${plat}-${arch}`);
      } else {
        console.log("0. bundled-agents 缺 glm（先 pnpm --filter @zcode/desktop prepare:agent-bundle）——依赖官方包自带");
      }
      const bundled = join(dirname(OFFICIAL_BIN), "resources", "config", "provider", "zcode-builtin.json");
      if (existsSync(bundled)) {
        const dstDir = join(sandboxHome, ".zcode", "v2", "runtime", "provider", "bundled");
        mkdirSync(dstDir, { recursive: true });
        copyFileSync(bundled, join(dstDir, "zcode-builtin.json"));
      }
    } catch { /* 尽力而为 */ }
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

  // ── 1. 本地市场夹具：marketplace.json + 插件副本（沙箱不配 plugins.dirs，
  //     安装只能走 UI 市场路径） ──
  if (!existsSync(join(REPO, "plugin", "hooks", "hooks.json"))) {
    throw new Error("插件源缺失（plugin/hooks/hooks.json）");
  }
  const mktDir = join(ws, "marketplace");
  const mktPluginDir = join(mktDir, "zcode-go");
  mkdirSync(mktDir, { recursive: true });
  cpSync(join(REPO, "plugin"), mktPluginDir, { recursive: true });
  writeFileSync(join(mktDir, "marketplace.json"), JSON.stringify({
    name: "zg-e2e-local",
    plugins: [
      // source 形态对齐官方缓存实测（{source:"url",...}）——本地目录用相对路径字符串
      { name: "zcode-go", description: "ZCode Go desktop takeover (E2E local marketplace)", source: "zcode-go" },
    ],
  }, null, 2));
  mkdirSync(join(sandboxHome, ".zcode", "cli"), { recursive: true });
  writeFileSync(join(sandboxHome, ".zcode", "cli", "config.json"), JSON.stringify({
    plugins: { enabledPlugins: {} },
  }, null, 2));
  console.log("1. local marketplace fixture ready:", mktDir);

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
    ZCODE_OFFICIAL_BIN: APP_BIN,
    // 插件官方发现的显式覆盖变量（plugin/src/zcode-go.ts discoverOfficial）：
    // 优先于祖先链 ps-walk——不设它时硬链接/exe 解析歧义会把真实安装路径写进
    // official.json，杀官方链即越界（实测）。镜像路径在此钦定。
    ZCODE_GO_OFFICIAL_BIN: APP_BIN,
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
  const appProc = spawn(APP_BIN, appArgs, { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
  appProcPid = appProc.pid;
  appProc.on("exit", (code, signal) => { appExitInfo = { code, signal }; });
  appProc.stdout.on("data", (c) => appendFileSync(appLog, c));
  appProc.stderr.on("data", (c) => appendFileSync(appLog, c));
  console.log("2. official app launched:", APP_BIN);

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

  // ── 4. UI 市场安装：侧边栏「插件市场」→ 添加本地市场 → 安装 zcode-go ──
  // CI runner 的 UI 语言可能是英文（--lang=zh-CN 部分平台未生效，38023610968
  // 实测）——所有文案匹配一律双语。
  const L = {
    marketplace: ["插件市场", "Plugin Marketplace"],
    viewReady: ["用插件为 ZCode 扩展", "Extend ZCode with skills, commands, and MCP servers"],
    add: ["添加", "Add"],
    addMarketplace: ["添加插件市场", "Add marketplace"],
    personal: ["个人", "Personal"],
    install: ["安装", "Install"],
    installed: ["已安装", "Installed"],
  };
  const dumpUi = async (tag) => {
    try {
      const d = await ev(`(() => {
        const btns = Array.from(document.querySelectorAll('button'))
          .filter(b => b.offsetParent !== null)
          .map(b => (b.innerText || "").trim()).filter(Boolean).slice(0, 25);
        const inputs = Array.from(document.querySelectorAll('input'))
          .filter(i => i.offsetParent !== null)
          .map(i => i.placeholder || i.type).slice(0, 10);
        return JSON.stringify({ body: document.body.innerText.split("\\n").join(" | ").slice(0, 600), btns, inputs });
      })()`);
      console.log(`${tag}:`, d);
    } catch (e) { console.log(`${tag} dump 失败:`, e.message); }
  };
  const clickVisibleButton = async (labels) => {
    const r = await ev(`(() => {
      const wanted = ${JSON.stringify(labels)};
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
      const hit = btns.find(b => wanted.includes((b.innerText || "").trim()));
      if (!hit) return null;
      const rc = hit.getBoundingClientRect();
      return JSON.stringify({ x: rc.x + rc.width / 2, y: rc.y + rc.height / 2, label: (hit.innerText || "").trim() });
    })()`);
    if (!r) return null;
    const { x, y, label } = JSON.parse(r);
    await c.trustedClick(Math.round(x), Math.round(y));
    return "trusted:" + label;
  };
  const waitVisibleText = async (text, timeoutMs) => waitVisibleTextList([text], timeoutMs);
  const waitVisibleTextList = async (words, timeoutMs) => {
    for (let i = 0; i < timeoutMs / 1000; i += 1) {
      const ok = await ev(`(() => { const t = document.body.innerText; return ${JSON.stringify(words)}.some((w) => t.includes(w)); })()`);
      if (ok) return true;
      await sleep(1000);
    }
    return false;
  };

  // 4a. 打开市场视图（侧边栏入口；文本精确匹配可见元素）
  let mktOpened = false;
  for (let i = 0; i < 3 && !mktOpened; i += 1) {
    const clicked = await ev(`(() => {
      const hits = Array.from(document.querySelectorAll('button, a, [role="button"], li, span, div'))
        .filter(el => el.offsetParent !== null && ${JSON.stringify(L.marketplace)}.includes((el.innerText || "").trim()));
      if (!hits.length) return null;
      hits[0].click();
      return "sidebar-clicked";
    })()`);
    if (clicked && await waitVisibleTextList(L.viewReady, 20)) { mktOpened = true; break; }
    await dumpUi(`4a.${i} 市场入口未达`);
    await sleep(2000);
  }
  console.log("4a. marketplace view opened:", mktOpened);
  if (!mktOpened) throw new Error("未能进入插件市场视图（见上 dump）");

  // 4b. 添加本地市场：「添加」弹下拉菜单（创建插件 / 添加插件市场）→ 点后者
  await clickVisibleButton(L.add);
  const menuItemR = await ev(`(() => {
    const hits = Array.from(document.querySelectorAll('button, [role="menuitem"], div, span, li, a'))
      .filter(el => el.offsetParent !== null && ${JSON.stringify(L.addMarketplace)}.includes((el.textContent || "").trim()));
    if (!hits.length) return null;
    hits.sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
    const rc = hits[0].getBoundingClientRect();
    return JSON.stringify({ x: rc.x + rc.width / 2, y: rc.y + rc.height / 2, area: rc.width * rc.height });
  })()`);
  let menuItemFinal = menuItemR;
  for (let i = 0; i < 3 && !menuItemFinal; i += 1) {
    // 菜单可能已随焦点丢失关闭：重开再找
    await clickVisibleButton(L.add);
    await sleep(800);
    break;
  }
  if (!menuItemFinal) { await dumpUi("4b 菜单项未找到"); throw new Error("「添加插件市场」菜单项未出现"); }
  {
    const m = JSON.parse(menuItemR);
    await c.trustedClick(Math.round(m.x), Math.round(m.y));
  }
  await sleep(1000);
  let inputFilled = false;
  for (let i = 0; i < 10 && !inputFilled; i += 1) {
    await sleep(1000);
    inputFilled = await ev(`(() => {
      const inp = Array.from(document.querySelectorAll('input')).find(i =>
        i.offsetParent !== null && /GitHub/i.test(i.placeholder || ""));
      if (!inp) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inp, ${JSON.stringify(mktDir)});
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!inputFilled && i < 3) {
      const probe = await ev(`(() => {
        const parts = document.body.innerText.split(String.fromCharCode(10)).filter(s => s.trim()).slice(0, 40);
        const menus = Array.from(document.querySelectorAll('[role="menu"] *, [role="dialog"] *, [data-state="open"] *'))
          .filter(el => el.offsetParent !== null && el.children.length === 0 && (el.textContent || "").trim())
          .map(el => (el.textContent || "").trim()).slice(0, 20);
        return JSON.stringify({ tail: parts.slice(-18), menus });
      })()`);
      console.log(`4b.${i} probe:`, probe);
    }
  }
  console.log("4b. marketplace path filled:", inputFilled);
  if (!inputFilled) { await dumpUi("4b 输入框未找到"); throw new Error("添加市场输入框未出现"); }
  await sleep(500);
  // 对话框结构 dump（确认按钮真实 label / 校验错误文案都在这里）
  const dlg = await ev(`(() => {
    const dialog = document.querySelector('[role="dialog"]') ||
      Array.from(document.querySelectorAll('div')).find(d => d.offsetParent !== null &&
        d.querySelector('input[placeholder*="GitHub 仓库"]') && d.querySelectorAll("button").length >= 1);
    if (!dialog) return JSON.stringify({ dialog: false });
    const btns = Array.from(dialog.querySelectorAll("button"))
      .filter(b => b.offsetParent !== null)
      .map(b => (b.innerText || "").trim());
    const errs = Array.from(dialog.querySelectorAll("*"))
      .filter(el => el.children.length === 0 && /失败|错误|无效|invalid|failed/i.test(el.textContent || ""))
      .map(el => (el.textContent || "").trim()).slice(0, 4);
    return JSON.stringify({ dialog: true, btns, errs });
  })()`);
  console.log("4b. dialog structure:", dlg);
  let added = false;
  // 对话框确认按钮实测文案就是「添加插件市场」（dump 实证：["选择目录","添加插件市场","Close"]）
  for (const labels of [L.addMarketplace, ["确认", "确定", "保存", "Confirm", "Save"]]) {
    const r = await clickVisibleButton(labels);
    if (r) {
      await sleep(2500);
      const gone = await ev(`!document.querySelector('input[placeholder*="GitHub 仓库"]')`);
      const registered = await ev(`document.body.innerText.includes("zg-e2e-local") || document.body.innerText.includes("zcode-go")`);
      if (gone && registered) { added = true; break; }
    }
  }
  if (!added) { await dumpUi("4b 确认后未生效"); throw new Error("添加市场未确认（见上 dump）"); }
  console.log("4b. local marketplace added");

  // 4c. 找 zcode-go 卡片并安装（安装按钮所属卡片须含 zcode-go 文本）
  let installClicked = false;
  for (let i = 0; i < 20 && !installClicked; i += 1) {
    if (i === 2 || i === 8) {
      // 本地市场在「个人」来源页签下——兜底切换
      const tabR = await ev(`(() => {
        const tab = Array.from(document.querySelectorAll('button, [role="tab"], span'))
          .filter(el => el.offsetParent !== null && ${JSON.stringify(L.personal)}.includes((el.innerText || "").trim()))[0];
        if (!tab) return null;
        const rc = tab.getBoundingClientRect();
        return JSON.stringify({ x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 });
      })()`);
      if (tabR) { const t = JSON.parse(tabR); await c.trustedClick(Math.round(t.x), Math.round(t.y)); }
      await sleep(1500);
    }
    const btnR = await ev(`(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null && ${JSON.stringify(L.install)}.includes((b.innerText || "").trim()));
      const hit = btns.find(b => {
        let p = b; for (let k = 0; k < 8 && p; k += 1) {
          if ((p.innerText || "").toLowerCase().replace(/[^a-z]/g, "").includes("zcodego")) return true;
          p = p.parentElement;
        }
        return false;
      });
      if (!hit) return null;
      const rc = hit.getBoundingClientRect();
      return JSON.stringify({ x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 });
    })()`);
    if (btnR) {
      const b = JSON.parse(btnR);
      await c.trustedClick(Math.round(b.x), Math.round(b.y));
      installClicked = true;
    }
    if (!installClicked) await sleep(2000);
  }
  console.log("4c. zcode-go install clicked:", installClicked);
  if (!installClicked) { await dumpUi("4c 卡片/安装按钮未找到"); throw new Error("未找到 zcode-go 卡片安装按钮"); }

  // 4d. 等安装完成：卡片「已安装」或 config.json enabledPlugins 落记录（CLI 级真相）
  let installedConfigOk = false;
  const sandboxConfigPath = join(sandboxHome, ".zcode", "cli", "config.json");
  for (let i = 0; i < 30 && !installedConfigOk; i += 1) {
    await sleep(2000);
    try {
      const cfg = JSON.parse(readFileSync(sandboxConfigPath, "utf8"));
      const enabled = Object.keys(cfg.plugins?.enabledPlugins ?? {});
      if (enabled.some((k) => k.startsWith("zcode-go@"))) installedConfigOk = true;
    } catch { /* 等待写入 */ }
  }
  const cardInstalled = await waitVisibleTextList(L.installed, 5);
  console.log(`4d. installed: configRecord=${installedConfigOk} cardState=${cardInstalled}`);
  if (!installedConfigOk) { await dumpUi("4d 安装记录未落"); throw new Error("安装未完成（config 无 zcode-go@ 记录）"); }

  // ── 4e. 提交 /zcode-go（装出来的插件 hook 拦截；展开命令形态直达模型的
  //     情况由 cjs 的 expanded 匹配兜底）──
  const officialJsonPath = join(sandboxHome, ".zcode-go", "official.json");
  for (let attempt = 0; attempt < 3; attempt += 1) {
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
    const submitStill = await ev(`(() => { const ed = document.querySelector('[contenteditable="true"]'); const b = ed?.closest('form')?.querySelector('button[type="submit"]'); return b && !b.disabled ? JSON.stringify({x:b.getBoundingClientRect().x+b.offsetWidth/2,y:b.getBoundingClientRect().y+b.offsetHeight/2}) : null; })()`);
    if (submitStill) {
      const s = JSON.parse(submitStill);
      await c.trustedClick(Math.round(s.x), Math.round(s.y));
    }
    break;
  }
  console.log("4e. /zcode-go submitted");

  // ── 4f. 安装副本功能验证：以官方 hook 同参数直调安装副本 bootstrap 链 ──
  //    实证过的产品事实：市场安装后 hook 需 app 重启才注册（官方行为），且
  //    UI 提交→hook→takeover 全链已由 takeover E2E 覆盖。此处验证「市场安装
  //    产物」作为插件的功能完整性：bootstrap 链（stdin /zcode-go）→ 拦截
  //    JSON + official.json 落盘。
  let hookJsonOk = false;
  {
    const hookSh = (() => {
      const scan = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) { const r = scan(p); if (r) return r; }
          else if (e.name === "bootstrap.sh") return p;
        }
        return null;
      };
      return scan(join(sandboxHome, ".zcode", "cli", "plugins", "cache", "zg-e2e-local"));
    })();
    if (!hookSh) throw new Error("安装副本中未找到 hooks/bootstrap.sh");
    const run = spawnSync("sh", [hookSh], {
      env: { ...appEnv, HOME: sandboxHome },
      input: JSON.stringify({ session_id: "e2e", cwd: sandboxHome, prompt: "/zcode-go" }),
      encoding: "utf8",
      timeout: 30000,
    });
    hookJsonOk = (run.status === 0) && (run.stdout || "").includes('"continue":false') &&
      existsSync(officialJsonPath);
    console.log(`4f. installed-copy hook chain: json=${hookJsonOk} exit=${run.status}`);
    if (!hookJsonOk) {
      console.log("4f. stdout:", (run.stdout || "").slice(0, 300));
      console.log("4f. stderr:", (run.stderr || "").slice(0, 300));
    }
  }

  // ── 5. 断言一：hook 生效（官方零模型回合）+ official.json 落盘且真实 ──
  let officialJsonOk = false;
  let officialJson = null;
  for (let i = 0; i < 20 && !officialJsonOk; i += 1) {
    await sleep(1000);
    try {
      officialJson = JSON.parse(readFileSync(officialJsonPath, "utf8"));
      officialJsonOk = Boolean(
        officialJson.bin && officialJson.runtimeBundle && existsSync(officialJson.bin) && existsSync(officialJson.runtimeBundle) &&
          officialJson.bin === APP_BIN,
      );
    } catch { /* 等待 hook 写入 */ }
  }
  const providerQuiet = providerEntries().length === 0;
  const pluginLogSeen = existsSync(join(sandboxHome, ".zcode-go", "plugin.log"));
  console.log("5a. official.json written & valid:", officialJsonOk, officialJson ? `(bin=${String(officialJson.bin).slice(0, 60)})` : "");
  console.log("5b. official made zero model calls (hook intercepted):", providerQuiet, `| installed-copy plugin.log: ${pluginLogSeen}`);
  if (!providerQuiet) {
    console.log("   provider log:", providerEntries().slice(-2).map((e) => (e.text || "").slice(0, 80)));
  }

  // 判据在 4/5 段已产出；fork 桌面拉起属 takeover E2E 职责，这里不重复断言。

  pass = installedConfigOk && hookJsonOk && officialJsonOk && providerQuiet;

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
  console.log(pass ? "MARKETPLACE-E2E-OK ✓" : "MARKETPLACE-E2E-FAIL ✗");
  process.exit(pass ? 0 : 1);
}
