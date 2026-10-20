#!/usr/bin/env node
/* oxlint-disable eslint(max-lines) -- zcode-go 机制/E2E/插件宿主文件：单文件收口（同 SessionPane 惯例）。 */
/**
 * zcode-go E2E：OPC 员工派发全链（data dir 沙箱 + 假 Provider 真实派发，零配额）。
 *
 * 与 goal-verify-e2e 同一套假 Provider 基建：官方运行时无需任何凭据即可建会话、
 * 提交 prompt——本用例把「员工派发」从 GetState 绑定层推进到真实 agent 进程层：
 *
 * 断言链：
 *   1. 一键编排按钮派发就绪工作项 → 编排器 createTask（员工 identity）+ sendPrompt；
 *   2. 假 Provider 收到委派请求：prompt 含员工名、记忆锚点（main 从员工 data dir
 *      内记忆根回读的索引 → 注入委派 prompt——记忆读取全链闭合）；
 *   3. 员工 agent 进程 env 三键（linux /proc）：ZCODE_DATA_BASE_DIR /
 *      ZCODE_STORAGE_DIR / ZCODE_SESSION_DB_PATH 全部指向员工 data 根；
 *   4. 会话正文落员工库 <ws>/.opc/employees/<id>/.zcode/cli/db/db.sqlite，
 *      主实例沙箱 HOME 的 db 无该会话（物理隔离）；
 *   5. tasks-index（host 单例）任务行 workspace_identity = 员工 identity
 *      （主实例任务列表不被员工行污染）；
 *   6. 员工 provider_config.json 副本在派发时生成（共享文件同步语义）。
 *
 * 运行：node scripts/e2e/opc-employee-dispatch-e2e.mjs（需 Xvfb 显示与已装配
 * 的 ~/.zcode-go/electron；CI 由 official-e2e.yml 循环拉起）。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const REAL_STATE_DIR = join(homedir(), ".zcode-go");
const ELECTRON =
  process.env.ZCODE_GO_E2E_APP_BIN ?? join(REAL_STATE_DIR, "electron", "zcode");
const CDP_PORT = 9348;
const PROFILE_TAG = "zg-opc-dispatch-e2e-profile";

let ws = join(tmpdir(), `zg-opc-dispatch-e2e-${Date.now()}`);
{
  const { spawnSync: ps, execSync } = await import("node:child_process");
  try {
    execSync("fuser -k 9348/tcp 2>/dev/null || true", {
      shell: "/bin/bash",
      stdio: "ignore",
    });
  } catch {
    /* 端口无人占用 */
  }
  ps("pkill", ["-9", "-f", PROFILE_TAG], { stdio: "ignore" });
  ps("pkill", ["-9", "-f", "ZCode Go E2E"], { stdio: "ignore" });
}
const sandboxHome = join(ws, "home");
const workspace = join(ws, "workspace");
let WORKSPACE = workspace;
const appLog = join(ws, "app.log");
const providerLog = join(ws, "provider.jsonl");
const portFile = join(ws, "provider.port");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = await import("node:http");
const httpGet = (path, host = "127.0.0.1", port = CDP_PORT) =>
  new Promise((resolve, reject) => {
    const req = http.get({ host, port, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
  });

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}
function assert(condition, message) {
  if (!condition) fail(message);
  console.log(`✓ ${message}`);
}

function memoryIdentity(workspacePath, employeeId) {
  return `opc-employee/${workspacePath}::${employeeId}`;
}
function memoryHash(workspacePath) {
  // 与桌面 main 同款：win32 需小写化（路径键大小写不敏感语义）
  const normalized = resolve(workspacePath);
  const keySource = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256")
    .update(keySource)
    .digest("hex")
    .slice(0, 16);
}
function sandboxMemoryRoot(workspacePath, employeeId) {
  // 与桌面 main / CLI resolveProjectMemoryRoot（identity 分支）同款：
  // project-<sha256(opc-employee/<ws>::<empId>)[:16]>——位置无关键，员工在
  // 本地/远程任意位置执行都解析到同一记忆根。隔离由每员工独立 storage
  // root 物理保证。
  const identity = `opc-employee/${workspacePath}::${employeeId}`;
  return join(
    workspacePath,
    ".opc",
    "employees",
    employeeId,
    ".zcode",
    "cli",
    "memories",
    "projects",
    `project-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    "memory",
  );
}

async function cdp() {
  const targets = await httpGet("/json/list");
  const pages = targets.filter((t) => t.type === "page");
  for (const page of pages) {
    const ws0 = new WebSocket(page.webSocketDebuggerUrl);
    const opened = await new Promise((res) => {
      ws0.onopen = () => res(true);
      ws0.onerror = () => res(false);
    });
    if (!opened) {
      ws0.close();
      continue;
    }
    let id = 0;
    const pending = new Map();
    const consoleLines = [];
    ws0.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ");
        if (text) consoleLines.push(text.slice(0, 4000));
        if (consoleLines.length > 200) consoleLines.splice(0, consoleLines.length - 200);
      }
    };
    ws0.send(
      JSON.stringify({ id: ++id, method: "Runtime.enable", params: {} }),
    );
    const ev = (expr, timeoutMs = 20000) =>
      new Promise((resolve) => {
        const mid = ++id;
        const timer = setTimeout(() => {
          pending.delete(mid);
          resolve(null);
        }, timeoutMs);
        pending.set(mid, (m) => {
          clearTimeout(timer);
          if (m.result?.exceptionDetails) resolve(null);
          else resolve(m.result?.result?.value);
        });
        ws0.send(
          JSON.stringify({
            id: mid,
            method: "Runtime.evaluate",
            params: { expression: expr, returnByValue: true, awaitPromise: true },
          }),
        );
      });
    const probe = await ev("1 + 1", 5000);
    if (probe !== 2) {
      ws0.close();
      continue;
    }
    return { ev, close: () => ws0.close(), consoleLines };
  }
  return null;
}

// app 启动初期 settingService 写配置会触发 reload，CDP 连接随之失效——
// evaluate 返回 null 时退避重试（普适防御，同 opc-e2e）。
async function getState() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const c = await cdp().catch(() => null);
    if (!c) {
      await sleep(2000);
      continue;
    }
    const s = await c
      .ev(
        `(() => { const p = window.zcode.zcodeGoOpcGetState({ workspacePath: ${JSON.stringify(WORKSPACE)} }); return p.then(r => JSON.stringify(r)).catch(e => "THROW: " + String(e).slice(0, 200)); })()`,
        30000,
      )
      .catch(() => null);
    c.close();
    if (s) return JSON.parse(s);
    await sleep(2500);
  }
  return null;
}

async function applyMutations(mutations) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const c = await cdp().catch(() => null);
    if (!c) {
      await sleep(2000);
      continue;
    }
    const r = await c
      .ev(
        `window.zcode.zcodeGoOpcApply({ workspacePath: ${JSON.stringify(WORKSPACE)}, mutations: ${JSON.stringify(mutations)} }).then(r => JSON.stringify(r)).catch(e => "THROW: " + String(e).slice(0, 150))`,
        25000,
      )
      .catch(() => null);
    c.close();
    if (r) return JSON.parse(r);
    await sleep(2000);
  }
  return null;
}

// ── 0. HOME 沙箱 + 假 Provider（goal-verify 同款） ─────────────────────────
mkdirSync(join(sandboxHome, ".zcode", "v2"), { recursive: true });
mkdirSync(join(sandboxHome, ".zcode-go"), { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });
// Windows CI 的 tmp 路径含 8.3 短名（RUNNER~1）：app 内部规范化会展开，
// E2E 侧必须用同一规范化串，否则记忆根 hash/路径断言三方分叉。
WORKSPACE = realpathSync(WORKSPACE);

const realOfficial = join(REAL_STATE_DIR, "official.json");
if (process.env.ZCODE_OFFICIAL_BIN) {
  const bin = process.env.ZCODE_OFFICIAL_BIN;
  const runtimeBundle =
    process.platform === "darwin"
      ? join(dirname(dirname(bin)), "Resources", "glm", "zcode.cjs")
      : join(dirname(bin), "resources", "glm", "zcode.cjs");
  writeFileSync(
    join(sandboxHome, ".zcode-go", "official.json"),
    JSON.stringify({
      platform: process.platform,
      bin,
      runtimeBundle,
      discoveredAt: Date.now(),
    }),
  );
} else if (existsSync(realOfficial)) {
  copyFileSync(realOfficial, join(sandboxHome, ".zcode-go", "official.json"));
} else {
  fail("official.json 不可得（本地 ~/.zcode-go/official.json 或 env ZCODE_OFFICIAL_BIN）");
}
// builtin Active 物化种子：新沙箱无历史缓存，冷启动 CDN 追不上会导致发送全拒。
const realProviderRuntime = join(homedir(), ".zcode", "v2", "runtime", "provider");
if (existsSync(realProviderRuntime)) {
  cpSync(realProviderRuntime, join(sandboxHome, ".zcode", "v2", "runtime", "provider"), {
    recursive: true,
  });
  // 给拷入的 builtin 配置注入一条无站点约束的 gpt-6-astra 档位规则：真机
  // 规则带官方站点约束，对 E2E 假 provider 不命中，导致该模型对在子进程
  // 注册表无档位表（会话钉定选型后子进程校验失败、轮次静默中止）。
  const injectRule = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        injectRule(p);
      } else if (name === "zcode-builtin.json") {
        try {
          const conf = JSON.parse(readFileSync(p, "utf8"));
          const rules = conf?.config?.modelConfigRules?.modelRules;
          if (Array.isArray(rules) && !rules.some((r) => r?.modelMatch === "^gpt-6-astra(?:[.\\-:/\\[].*)?$")) {
            rules.unshift({
              modelMatch: "^gpt-6-astra(?:[.\\-:/\\[].*)?$",
              config: {
                enabled: true,
                properties: {
                  requiresMfjsToolSchema: false,
                  contextWindow: 128000,
                  inputFormat: {
                    supportsText: true,
                    supportsImage: false,
                    supportsVideo: false,
                    supportsAudio: false,
                    supportsPdf: false,
                  },
                  outputFormat: { supportsText: true },
                  supportsToolCall: true,
                  supportsJsonSchemaOutput: false,
                  supportsNativeWebSearch: false,
                  supportsMidConversationSystem: false,
                },
                optionSpecs: {
                  reasoningLevel: {
                    values: ["low", "medium", "high", "xhigh", "max"],
                    map: "{}",
                  },
                  maxOutputTokens: { max: 128000 },
                },
              },
            });
            writeFileSync(p, JSON.stringify(conf));
          }
        } catch {
          /* 单文件损坏跳过 */
        }
      }
    }
  };
  injectRule(join(sandboxHome, ".zcode", "v2", "runtime", "provider"));
}

const routesPath = join(ws, "routes.json");
writeFileSync(
  routesPath,
  JSON.stringify([
    // 委派 prompt 命中：回一句收尾文本（无工具调用，一轮即完成）
    { match: "(?i)dispatch-e2e|任务", content: "已收到任务并完成：e2e 派发链路验证通过。" },
  ]),
);
const providerProc = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("fake-provider.mjs", import.meta.url)),
    "--port-file",
    portFile,
    "--script",
    routesPath,
    "--log",
    providerLog,
  ],
  { stdio: "ignore" },
);
let fakePort = 0;
for (let i = 0; i < 50 && !fakePort; i += 1) {
  try {
    fakePort = Number(readFileSync(portFile, "utf8").trim()) || 0;
  } catch {
    /* 等待 */
  }
  if (!fakePort) await sleep(200);
}
if (!fakePort) fail("假 Provider 未就绪");
writeFileSync(
  join(sandboxHome, ".zcode", "v2", "provider_config.json"),
  JSON.stringify({
    schemaVersion: 1,
    config: {
      providerOrder: ["zcode-go-fake"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: "zcode-go-fake",
            templateId: "openai",
            providerName: "zcode-go-fake",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "sk-zcode-go-e2e" },
              api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${fakePort}/v1` },
              personalModelIds: ["fake-model", "gpt-6-astra"],
              modelOrder: ["fake-model", "gpt-6-astra"],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            providerId: "zcode-go-fake",
            modelId: "fake-model",
            config: { enabled: true, properties: {"requiresMfjsToolSchema": false, "contextWindow": 128000, "inputFormat": {"supportsText": true, "supportsImage": false, "supportsVideo": false, "supportsAudio": false, "supportsPdf": false}, "outputFormat": {"supportsText": true}, "supportsToolCall": true, "supportsJsonSchemaOutput": false, "supportsNativeWebSearch": false, "supportsMidConversationSystem": false}, optionSpecs: {"reasoningLevel": {"values": ["low", "medium", "high", "xhigh", "max"], "map": "{}"}, "maxOutputTokens": {"max": 128000}} },
          },
          {
            providerId: "zcode-go-fake",
            modelId: "gpt-6-astra",
            config: { enabled: true, properties: {"requiresMfjsToolSchema": false, "contextWindow": 128000, "inputFormat": {"supportsText": true, "supportsImage": false, "supportsVideo": false, "supportsAudio": false, "supportsPdf": false}, "outputFormat": {"supportsText": true}, "supportsToolCall": true, "supportsJsonSchemaOutput": false, "supportsNativeWebSearch": false, "supportsMidConversationSystem": false}, optionSpecs: {"reasoningLevel": {"values": ["low", "medium", "high", "xhigh", "max"], "map": "{}"}, "maxOutputTokens": {"max": 128000}} },
          },
        ],
        manualProviderModelRules: [],
      },
    },
  }),
);
console.log(`0a. sandbox=${sandboxHome} fake provider port=${fakePort}`);

// ── 启动 app（HOME=沙箱，独立 display） ────────────────────────────────────
if (process.platform === "win32") {
  mkdirSync(join(sandboxHome, "AppData", "Roaming"), { recursive: true });
  mkdirSync(join(sandboxHome, "AppData", "Local"), { recursive: true });
}
const appArgs = [
  ELECTRON,
  "--lang=zh-CN",
  // 直接打开目标工作区：面板的 workspacePath 来自 app 当前激活工作区，
  // 默认会话工作区（onboarding 后）与 E2E 工作区不同会导致编排错位。
  `--open-workspace=${WORKSPACE}`,
  `--user-data-dir=${join(sandboxHome, ".zcode-go", PROFILE_TAG)}`,
  `--remote-debugging-port=${CDP_PORT}`,
  ...(process.platform === "linux" ? ["--no-sandbox"] : ["--disable-gpu"]),
];
mkdirSync(join(sandboxHome, ".zcode-go", PROFILE_TAG), { recursive: true });
// 受控 env（不整包继承：宿主 shell 的 ZCODE_* 会击穿沙箱语义，goal-verify 同款）
const appEnv = {
  PATH: process.env.PATH,
  LANG: process.env.LANG ?? "zh_CN.UTF-8",
  HOME: sandboxHome,
  ...(process.platform === "linux"
    ? {
        DISPLAY: process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103",
        ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
      }
    : {
        USERPROFILE: sandboxHome,
        APPDATA: join(sandboxHome, "AppData", "Roaming"),
        LOCALAPPDATA: join(sandboxHome, "AppData", "Local"),
      }),
  ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Go E2E",
  // 子进程 stderr 逐行取证（identity 轮次静默问题的诊断通道）；
  // development 运行时打开子进程 debug 级轮次轨迹。
  ZCODE_AGENT_STDERR_LOG: "1",
  ZCODE_RUNTIME_ENV: "development",
};
let appProc = spawn(ELECTRON, appArgs, {
  env: appEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
const logFs = await import("node:fs/promises");
async function appendLog(c) {
  await logFs.appendFile(appLog, c).catch(() => {});
}
appProc.stdout.on("data", appendLog);
appProc.stderr.on("data", appendLog);

function killApp() {
  try {
    appProc.kill("SIGTERM");
  } catch {
    /* 尽力而为 */
  }
}

try {
  {
    let ready = false;
    for (let i = 0; i < 30 && !ready; i += 1) {
      ready = await httpGet("/json/version").then(() => true).catch(() => false);
      if (!ready) await sleep(2000);
    }
    assert(ready, "CDP 端口就绪");
    // 切 OPC 界面模式（与侧栏模式切换同一持久化键）并 reload：面板预热挂在
    // isOpcMode 门控下，非 OPC 模式打开面板时 store 无 workspacePath、兜底
    // initialize 不生效，一键编排按钮会因无状态而禁用。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const c = await cdp().catch(() => null);
      if (!c) {
        await sleep(2000);
        continue;
      }
      const reloaded = await c.ev(
        "localStorage.setItem('zcode-interface-mode', 'opc'); location.reload(); true",
        10000,
      );
      c.close();
      if (reloaded) break;
      await sleep(2000);
    }
    // 等 reload 后 CDP 恢复
    let readyAgain = false;
    for (let i = 0; i < 30 && !readyAgain; i += 1) {
      readyAgain = await httpGet("/json/version").then(() => true).catch(() => false);
      if (readyAgain) {
        const c = await cdp().catch(() => null);
        if (c) {
          c.close();
        } else {
          readyAgain = false;
        }
      }
      if (!readyAgain) await sleep(2000);
    }
    assert(readyAgain, "OPC 模式 reload 完成");
  }

  // ── 0b. 过 onboarding（API key，goal-verify 同款）→ composer 就绪 ─────────
  {
    let composerOk = false;
    for (let i = 0; i < 60 && !composerOk; i += 1) {
      const c = await cdp().catch(() => null);
      if (!c) {
        await sleep(1500);
        continue;
      }
      const r = await c.ev(
        `(() => {
          if (document.querySelector('[contenteditable="true"]')) return "composer";
          const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
          const apikey = btns.find(b => /使用 API key|Use API key/i.test(b.innerText || ""));
          if (apikey) { apikey.click(); return "apikey"; }
          const next = btns.find(b => ["继续", "Continue"].includes((b.innerText || "").trim()));
          if (next) { next.click(); return "continue"; }
          const skip = btns.find(b => ["跳过", "Skip"].includes((b.innerText || "").trim()));
          if (skip) { skip.click(); return "skip"; }
          return "wait";
        })()`,
        15000,
      );
      if (r === "apikey") {
        await sleep(1200);
        await c.ev(
          `(() => {
            const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null);
            const inp = inputs[0];
            if (!inp) return "no-input";
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(inp, "sk-zcode-go-e2e");
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            return "filled";
          })()`,
          10000,
        );
        await sleep(400);
        await c.ev(
          `Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && ["继续","Continue"].includes((b.innerText || "").trim()))?.click(); "ok"`,
          10000,
        );
      }
      if (r === "composer") composerOk = true;
      c.close();
      if (!composerOk) await sleep(1200);
    }
    assert(composerOk, "onboarding 通过（composer 就绪，激活工作区 = E2E 工作区）");
  }

  // ── 1. 初始化 + 招聘 + 预置记忆锚点 ──────────────────────────────────────
  let st = await getState();
  assert(st && st.ok && st.state, "GetState 初始化（沙箱 HOME）");
  const hire = await applyMutations([
    {
      kind: "employee.hire",
      templateId: "custom",
      roleId: null,
      custom: { name: "老王", category: "engineering" },
    },
  ]);
  assert(hire && hire.ok, "招聘老王（Apply 经真实 IPC）");
  const laowangId = hire.state.employees.find((e) => e.name === "老王").id;

  st = await getState();
  assert(st && st.ok, "二次 GetState（记忆根绑定）");
  const memoryRoot = sandboxMemoryRoot(WORKSPACE, laowangId);
  assert(existsSync(memoryRoot), `记忆根已创建：${memoryRoot}`);
  assert(
    typeof st.employeeMemoryPaths?.[laowangId] === "string",
    "employeeMemoryPaths 回读记忆根显示路径",
  );
  // 预置记忆锚点：委派 prompt 必须含它（main 回读 → 注入链闭合）
  writeFileSync(
    join(memoryRoot, "MEMORY.md"),
    "- [派发锚点](anchor.md) — dispatch-e2e-hook\n",
    "utf8",
  );

  // ── 2. 建工作项（分配老王 → ready） ──────────────────────────────────────
  const created = await applyMutations([
    {
      kind: "workitem.create",
      title: "dispatch-e2e 验证项",
      detail: "验证员工 data dir 沙箱派发全链",
      assigneeId: laowangId,
    },
  ]);
  assert(created && created.ok, "创建工作项");
  const workItemId = created.state.workItems.find((w) => w.title.includes("dispatch-e2e")).id;
  const readied = await applyMutations([
    { kind: "workitem.status", workItemId, status: "ready" },
  ]);
  assert(readied && readied.ok, "工作项置为 ready");

  // ── 3+4. 点编排 → 轮询落账（app.log 的编排日志为点击生效信号，必要时重试）──
  {
    const monitor = await cdp();
    assert(monitor, "CDP 监控连接建立");
    let dispatched = null;
    try {
      const clickOnce = async () =>
        monitor.ev(
          `(() => {
            window.dispatchEvent(new CustomEvent("zcode-go:opc-open", { detail: { tab: "kanban" } }));
            return new Promise((resolve) => setTimeout(() => {
              const fn = window.__zcodeOpcOrchestrateE2E;
              if (typeof fn !== "function") { resolve(false); return; }
              fn();
              resolve(true);
            }, 2500));
          })()`,
          20000,
        );
      const logHas = (needle) => {
        try {
          return readFileSync(appLog, "utf8").includes(needle);
        } catch {
          return false;
        }
      };
      let attempts = 0;
      for (let waited = 0; waited < 150_000 && !dispatched; waited += 5000) {
        if (waited % 20_000 === 0) {
          attempts += 1;
          const clickMark = `orchestrate-click-${attempts}`;
          const before = (() => {
            try {
              return readFileSync(appLog, "utf8").length;
            } catch {
              return 0;
            }
          })();
          const handleOk = await clickOnce();
          console.error(`[click] attempt ${attempts}: handle=${handleOk}`);
          if (!logHas("编排完成")) {
            // 点击可能未生效：等编排日志出现（handleOrchestrate 同步落日志）
            for (let i = 0; i < 6; i += 1) {
              await sleep(2000);
              if (logHas("编排完成")) break;
            }
          }
          if (!logHas("编排完成")) {
            console.error(`[click] 第 ${attempts} 次点击未触发编排（log 大小 ${before}）`);
          }
        }
        const st = await monitor.ev(
          `(() => { const p = window.zcode.zcodeGoOpcGetState({ workspacePath: ${JSON.stringify(WORKSPACE)} }); return p.then(r => JSON.stringify(r)).catch(e => "THROW: " + String(e).slice(0, 200)); })()`,
          30000,
        ).catch(() => null);
        const parsed = st ? JSON.parse(st) : null;
        const it = parsed?.state?.workItems?.find((w) => w.id === workItemId);
        if (it?.sessionId) dispatched = it;
      }
      if (!dispatched) {
        const lines = (monitor.consoleLines ?? []).slice(-30).join("\n");
        console.error(`console tail:\n${lines}`);
      }
      assert(dispatched, "工作项已派发（sessionId 落账）");
    } finally {
      monitor.close();
    }
  }
  const sessionId = (await getState())?.state?.workItems?.find((w) => w.id === workItemId)
    ?.sessionId;

  // ── 5. 假 Provider 收到委派请求（prompt 含员工名 + 记忆锚点） ─────────────
  {
    let entries = [];
    for (let i = 0; i < 30 && entries.length === 0; i += 1) {
      try {
        entries = readFileSync(providerLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        entries = [];
      }
      if (entries.length === 0) await sleep(2000);
    }
    assert(entries.length > 0, "假 Provider 收到模型请求（真实 agent 推理链）");
    const promptText = entries.map((e) => e.text ?? "").join("\n");
    assert(promptText.includes("老王"), "委派 prompt 含员工名（角色注入）");
    assert(
      promptText.includes("dispatch-e2e-hook"),
      "委派 prompt 含记忆锚点（main 从员工 data dir 内记忆根回读 → 注入闭合）",
    );
    assert(
      promptText.includes("持久记忆"),
      "委派 prompt 含持久记忆段（memoryDirDisplay 注入）",
    );
  }

  // ── 6. 员工 agent 进程 env 三键（linux /proc） ────────────────────────────
  if (process.platform === "linux") {
    const expectedDataDir = join(WORKSPACE, ".opc", "employees", laowangId);
    let found = null;
    for (let i = 0; i < 10 && !found; i += 1) {
      for (const pid of await import("node:fs/promises").then((m) => m.readdir("/proc"))) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const env = readFileSync(`/proc/${pid}/environ`, "utf8");
          if (!env.includes(`ZCODE_DATA_BASE_DIR=${expectedDataDir}`)) continue;
          const has = (k, v) => env.includes(`${k}=${v}`);
          if (
            has("ZCODE_STORAGE_DIR", join(expectedDataDir, ".zcode")) &&
            has(
              "ZCODE_SESSION_DB_PATH",
              join(expectedDataDir, ".zcode", "cli", "db", "db.sqlite"),
            )
          ) {
            found = pid;
            break;
          }
          fail(`员工 agent env 三键不全：pid=${pid}`);
        } catch {
          /* 进程已退出或无权限 */
        }
      }
      if (!found) await sleep(2000);
    }
    assert(found, `员工 agent 进程 env 三键指向员工 data 根（pid=${found}）`);
  }

  // ── 7. 会话正文落员工库；主实例沙箱 db 无该会话 ───────────────────────────
  {
    const employeeDb = join(
      WORKSPACE,
      ".opc",
      "employees",
      laowangId,
      ".zcode",
      "cli",
      "db",
      "db.sqlite",
    );
    let inEmployee = false;
    for (let i = 0; i < 20 && !inEmployee; i += 1) {
      if (existsSync(employeeDb)) {
        try {
          const db = new DatabaseSync(employeeDb, { readOnly: true });
          const row = db.prepare("select id from session where id = ?").get(sessionId);
          db.close();
          inEmployee = Boolean(row);
        } catch {
          inEmployee = false;
        }
      }
      if (!inEmployee) await sleep(1500);
    }
    assert(inEmployee, `会话正文落员工库（session ${sessionId}）`);
    const mainDb = join(sandboxHome, ".zcode", "cli", "db", "db.sqlite");
    let leaked = false;
    if (existsSync(mainDb)) {
      const db = new DatabaseSync(mainDb, { readOnly: true });
      const row = db.prepare("select id from session where id = ?").get(sessionId);
      db.close();
      leaked = Boolean(row);
    }
    assert(!leaked, "主实例沙箱 db 不含员工会话（物理隔离）");
  }

  // ── 7.5 工作项收口：review → done（触发反思轮）──
  // 转换表：in_progress → review → done（直接 in_progress → done 被 reducer
  // 判非法静默 no-op，响应 ok 但状态不变——必须断言响应内的实际状态）。
  {
    const reviewApply = await applyMutations([
      { kind: "workitem.status", workItemId, status: "review" },
    ]);
    assert(
      reviewApply &&
        reviewApply.ok &&
        reviewApply.state?.workItems?.find((w) => w.id === workItemId)
          ?.status === "review",
      "工作项转 review（验收门）",
    );
    const doneApply = await applyMutations([
      { kind: "workitem.status", workItemId, status: "done" },
    ]);
    assert(
      doneApply &&
        doneApply.ok &&
        doneApply.state?.workItems?.find((w) => w.id === workItemId)
          ?.status === "done",
      "工作项转 done（触发反思轮）",
    );
  }

  // ── 7.6 人格画像重置验收（mutation → main fs 副作用 → GetState 回读归零）──
  // 主档冻结门控：busy（in_progress+sessionId）时 reducer 静默拒绝重置——
  // 本段必须在 done 之后（解冻）、反思派发之前（避免 persona 写入竞态）。
  {
    const memoryRoot2 = sandboxMemoryRoot(WORKSPACE, laowangId);
    writeFileSync(join(memoryRoot2, "persona.md"), "早期误反馈固化的倾向\n", "utf8");
    let stPersona = await getState();
    assert(
      stPersona.employeePersonaDigests?.[laowangId]?.includes("早期误反馈"),
      "personaDigest 回读画像（重置前）",
    );
    const reset = await applyMutations([
      { kind: "employee.resetPersona", employeeId: laowangId },
    ]);
    assert(reset && reset.ok, "employee.resetPersona（Apply 经真实 IPC）");
    assert(
      !existsSync(join(memoryRoot2, "persona.md")),
      "persona.md 已删除（记忆事实文件保留）",
    );
    stPersona = await getState();
    assert(
      stPersona.employeePersonaDigests?.[laowangId] === null,
      "GetState 回读 personaDigest 归 null（重置生效）",
    );
    assert(
      existsSync(join(memoryRoot2, "MEMORY.md")),
      "记忆事实（MEMORY.md）保留",
    );
  }

  // ── 7.7 L2 反思轮验收：done → 员工身份反思会话出现 ──
  {
    const employeeDb = join(
      WORKSPACE,
      ".opc",
      "employees",
      laowangId,
      ".zcode",
      "cli",
      "db",
      "db.sqlite",
    );
    let reflected = false;
    for (let i = 0; i < 24 && !reflected; i += 1) {
      await sleep(5000);
      if (!existsSync(employeeDb)) continue;
      try {
        const db = new DatabaseSync(employeeDb, { readOnly: true });
        const rows = db
          .prepare(
            "select session_id, substr(text, 1, 200) as head from input_history where text like '%记忆反思轮%'",
          )
          .all();
        db.close();
        if (rows.length > 0) reflected = true;
      } catch {
        /* 库忙 */
      }
    }
    assert(reflected, "反思会话已派发（input_history 含记忆反思轮 prompt）");
  }

  // ── 8. tasks-index：任务行 identity = 员工键（主列表不被污染） ─────────────
  {
    const indexDb = join(sandboxHome, ".zcode", "v2", "tasks-index.sqlite");
    let identityRow = null;
    for (let i = 0; i < 15 && !identityRow; i += 1) {
      if (existsSync(indexDb)) {
        try {
          const db = new DatabaseSync(indexDb, { readOnly: true });
          const row = db
            .prepare("select workspace_identity from tasks where task_id = ?")
            .get(sessionId);
          db.close();
          if (row) identityRow = row;
        } catch {
          /* syncer 尚未写入或库锁 */
        }
      }
      if (!identityRow) await sleep(2000);
    }
    assert(identityRow, "tasks-index 已含员工任务行");
    assert(
      identityRow.workspace_identity === memoryIdentity(WORKSPACE, laowangId),
      `任务行 workspace_identity = 员工键（实际 ${identityRow.workspace_identity}）`,
    );
  }

  // ── 9. 员工 provider_config 副本（共享文件同步语义） ──────────────────────
  {
    const copy = join(
      WORKSPACE,
      ".opc",
      "employees",
      laowangId,
      ".zcode",
      "v2",
      "provider_config.json",
    );
    assert(existsSync(copy), "员工 v2 provider_config.json 副本已生成");
    const parsed = JSON.parse(readFileSync(copy, "utf8"));
    assert(
      JSON.stringify(parsed).includes("zcode-go-fake"),
      "副本内容来自主副本（fake provider 配置同步到位）",
    );
  }

  console.log("\n✅ opc-employee-dispatch E2E 全部通过");
} catch (error) {
  console.error(`❌ E2E 异常:`, error);
  process.exitCode = 1;
} finally {
  killApp();
  providerProc.kill("SIGTERM");
  await sleep(1000);
  try {
    appProc.kill("SIGKILL");
  } catch {
    /* 已退出 */
  }
  try {
    providerProc.kill("SIGKILL");
  } catch {
    /* 已退出 */
  }
  // rmSync(ws, { recursive: true, force: true }); // 诊断期保留现场
}
