#!/usr/bin/env node
/* oxlint-disable eslint(max-lines) -- zcode-go 机制/E2E/插件宿主文件：单文件收口（同 SessionPane 惯例）。 */
/**
 * zcode-go E2E：OPC 全栈闭环（公司包/看板语义/入站队列/模板包/Telegram 渠道桥）。
 *
 * 与 goal-verify-e2e 同一套 HOME 沙箱 + CDP 基建。OPC 不需要模型调用：
 * 全部断言经 CDP 在 renderer 上下文驱动 preload 暴露的 window.zcode.
 * zcodeGoOpcGetState / Apply / ConsumeInbox —— preload→IPC→main→.opc 文件→
 * 返回，全栈真实。Telegram 渠道桥指向脚本内起的 mock API（getUpdates）。
 *
 * 断言链：
 *   1. GetState 初始化默认公司（创始人）+ 模板包幂等填充（packImports 戳）；
 *   2. 招聘/建项/依赖传播/门控拒绝/升级接手/返工（reducer 全语义经真实 IPC）；
 *   3. 持久化：二次 GetState 与首次一致；
 *   4. 入站队列：drop 文件 → GetState 可见 → convert 建项 + 文件删除 →
 *      dismiss 仅删文件；Telegram 渠道桥把 mock 消息投递进同一队列；
 *   5. 重启不重放（offset 持久化）由重启断言覆盖（杀 app → 重启 → inbox 不回放）。
 *
 * 运行：pnpm e2e:opc（需 Xvfb 显示与已装配的 ~/.zcode-go/electron，同既有 E2E）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REAL_STATE_DIR = join(homedir(), ".zcode-go");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON =
  process.env.ZCODE_GO_E2E_APP_BIN ?? join(REAL_STATE_DIR, "electron", "zcode");
const CDP_PORT = 9345;
const PROFILE_TAG = "zg-opc-e2e-profile";
const E2E_DISPLAY = process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103";

const ws = join(tmpdir(), `zg-opc-e2e-${Date.now()}`);
// 前置清理：只杀带本 E2E profile 标记的残留实例（绝不碰真实桌面——
// 真实接管实例的 user-data-dir 不含 zg-opc-e2e-profile）。残留实例会占住
// CDP 端口并让新实例单实例锁让位，导致 CDP 连到旧实例。
{
  const { spawnSync: ps, execSync } = await import("node:child_process");
  // 残留实例的 utility 子进程 cmdline 被 Electron 改写为 /proc/self/exe，
  // pkill -f 按名称匹配不到——改按端口杀（fuser），再兜底按 profile 标记。
  try {
    execSync("fuser -k 9345/tcp 2>/dev/null || true", {
      shell: "/bin/bash",
      stdio: "ignore",
    });
  } catch {
    /* 端口无人占用 */
  }
  ps("pkill", ["-9", "-f", "zg-opc-e2e-profile"], { stdio: "ignore" });
  ps("pkill", ["-9", "-f", "ZCode Go E2E"], { stdio: "ignore" });
}
const sandboxHome = join(ws, "home");
const workspace = join(ws, "workspace");
const appLog = join(ws, "app.log");
const WORKSPACE = workspace;

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

// ── Telegram mock API（getUpdates；记录请求） ─────────────────────────────
let telegramHits = 0;
const mockApi = http.createServer((req, res) => {
  if (String(req.url).includes("/getUpdates")) {
    telegramHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        result: [
          {
            update_id: 1,
            message: { text: "来自 Telegram 的任务", chat: { id: 777 } },
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, result: [] }));
});

async function cdp() {
  const targets = await httpGet("/json/list");
  // 启动期可能闪现辅助 page target（销毁后 ws 消息无人应答，evaluate 全挂）：
  // 逐个探测「1+1」，取能成功 evaluate 的主窗口
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
    ws0.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
    const ev = (expr, timeoutMs = 8000) =>
      new Promise((resolve) => {
        const mid = ++id;
        const timer = setTimeout(() => {
          pending.delete(mid);
          resolve(null);
        }, timeoutMs);
        pending.set(mid, (m) => {
          clearTimeout(timer);
          if (m.result?.exceptionDetails) {
            resolve(null);
          } else resolve(m.result?.result?.value);
        });
        ws0.send(
          JSON.stringify({
            id: mid,
            method: "Runtime.evaluate",
            params: {
              expression: expr,
              returnByValue: true,
              awaitPromise: true,
            },
          }),
        );
      });
    const probe = await ev("1 + 1", 5000);
    if (probe !== 2) {
      ws0.close();
      continue;
    }
    const evLong = (expr, timeoutMs = 20000) =>
      new Promise((resolve) => {
        const mid = ++id;
        const timer = setTimeout(() => {
          pending.delete(mid);
          resolve(null);
        }, timeoutMs);
        pending.set(mid, (m) => {
          clearTimeout(timer);
          if (m.result?.exceptionDetails) {
            resolve(null);
          } else resolve(m.result?.result?.value);
        });
        ws0.send(
          JSON.stringify({
            id: mid,
            method: "Runtime.evaluate",
            params: {
              expression: expr,
              returnByValue: true,
              awaitPromise: true,
            },
          }),
        );
      });
    return { ev: evLong, close: () => ws0.close() };
  }
  return null;
}

// app 启动初期 settingService 写完配置会触发 reload，CDP 连接随之失效——
// evaluate 返回 null 时退避重试（普适防御，勿依赖单次成功）。
async function getState() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // 每轮重建 CDP 连接：启动初期页面 reload 会销毁旧执行上下文，
    // 复用旧连接的 evaluate 会挂起到超时（null）。
    const c = await cdp().catch(() => null);
    if (!c) {
      await sleep(2000);
      continue;
    }
    console.log(`  [debug] 第 ${attempt} 轮：cdp 已连，调 GetState…`);
    const s = await c
      .ev(
        `(() => { const p = window.zcode.zcodeGoOpcGetState({ workspacePath: ${JSON.stringify(WORKSPACE)} }); return p.then(r => JSON.stringify(r)).catch(e => "THROW: " + String(e).slice(0, 200)); })()`,
        25000,
      )
      .catch(() => null);
    c.close();
    console.log(
      `  [debug] 第 ${attempt} 轮返回：${s === null ? "TIMEOUT（挂起）" : String(s).slice(0, 120)}`,
    );
    if (s) return JSON.parse(s);
    await sleep(2500);
  }
  return null;
}

const apply = (ev, mutations) =>
  ev(
    `window.zcode.zcodeGoOpcApply({ workspacePath: ${JSON.stringify(WORKSPACE)}, mutations: ${JSON.stringify(mutations)} }).then(r => JSON.stringify(r))`,
  ).then((s) => (s ? JSON.parse(s) : null));

// ── 沙箱与预置 ────────────────────────────────────────────────────────────
mkdirSync(workspace, { recursive: true });
mkdirSync(sandboxHome, { recursive: true });
mkdirSync(join(ws, "tmp"), { recursive: true });
mkdirSync(join(sandboxHome, "AppData", "Roaming"), { recursive: true });
mkdirSync(join(sandboxHome, "AppData", "Local"), { recursive: true });

// Telegram 渠道桥配置（app 启动前写入；apiBase 指向脚本内 mock）
mkdirSync(join(sandboxHome, ".zcode-go"), { recursive: true });
writeFileSync(
  join(sandboxHome, ".zcode-go", "config.json"),
  JSON.stringify(
    {
      channels: {
        telegram: {
          botToken: "e2e-test-token",
          workspacePath: WORKSPACE,
          allowFrom: [777],
          apiBase: "http://127.0.0.1:0", // 启动 mock 后改写为真实端口并重启？——改为先起 mock
        },
      },
    },
    null,
    1,
  ),
);

// ── mock API 先起（拿到端口再写 config，桥启动时读取） ─────────────────────
await new Promise((resolve) => {
  mockApi.listen(0, "127.0.0.1", resolve);
});
const tgPort = mockApi.address().port;
const tgConfig = JSON.parse(
  readFileSync(join(sandboxHome, ".zcode-go", "config.json"), "utf8"),
);
tgConfig.channels.telegram.apiBase = `http://127.0.0.1:${tgPort}`;
writeFileSync(
  join(sandboxHome, ".zcode-go", "config.json"),
  JSON.stringify(tgConfig, null, 1),
);

// 模板包预置（沙箱 ~/.zcode-go/opc-packs/demo-pack）
const packDir = join(sandboxHome, ".zcode-go", "opc-packs", "demo-pack");
mkdirSync(join(packDir, "skills", "pack-e2e"), { recursive: true });
mkdirSync(join(packDir, "roles"), { recursive: true });
writeFileSync(
  join(packDir, "pack.json"),
  JSON.stringify({ id: "demo-pack", version: "e2e0001" }, null, 1),
);
writeFileSync(
  join(packDir, "roles", "E2E 工程师.md"),
  "---\nname: E2E 工程师\ndescription: 端到端测试生成的角色\ncolor: cyan\nemoji: 🧪\nvibe: 可复现\n---\n\n正文\n",
);
writeFileSync(
  join(packDir, "skills", "pack-e2e", "SKILL.md"),
  "---\nname: pack-e2e\ndescription: Use when 端到端测试\n---\n\n## 工作流\n1. 步骤\n",
);

// ── 启动应用 ──────────────────────────────────────────────────────────────
// 装配产物保鲜：已装配的 ~/.zcode-go/electron/resources/app/out 是旧构建的
// 拷贝——把仓库最新 out/main 同步进去（同 launcher 保鲜语义，仅本 E2E 侧）。
const assembledAppOut = join(
  REAL_STATE_DIR,
  "electron",
  "resources",
  "app",
  "out",
);
if (existsSync(assembledAppOut)) {
  // main 与 preload 都要同步：preload 缺失会让 window.zcode 缺 OPC 桥接方法
  cpSync(
    join(REPO, "packages", "desktop", "out", "main"),
    join(assembledAppOut, "out", "main"),
    {
      recursive: true,
    },
  );
  cpSync(
    join(REPO, "packages", "desktop", "out", "preload"),
    join(assembledAppOut, "out", "preload"),
    {
      recursive: true,
    },
  );
  console.log("0a. 已同步最新 out/main + out/preload → 装配产物");
}
console.log("0. 沙箱就绪，启动 app…");
const appArgs = [
  "--lang=zh-CN",
  `--user-data-dir=${join(ws, PROFILE_TAG)}`,
  `--remote-debugging-port=${CDP_PORT}`,
  ...(process.platform === "linux" ? ["--no-sandbox"] : ["--disable-gpu"]),
];
const appEnv = {
  ...process.env,
  HOME: sandboxHome,
  ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Go E2E",
  ...(process.platform === "linux"
    ? { XAUTHORITY: process.env.XAUTHORITY }
    : {
        USERPROFILE: sandboxHome,
        APPDATA: join(sandboxHome, "AppData", "Roaming"),
        LOCALAPPDATA: join(sandboxHome, "AppData", "Local"),
      }),
};
const appProc = spawn(ELECTRON, appArgs, {
  env: appEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
appProc.stdout.on("data", (c) => appendLog(c));
appProc.stderr.on("data", (c) => appendLog(c));
async function appendLog(c) {
  const fs = await import("node:fs");
  fs.appendFileSync(appLog, String(c));
}

let c = null;
for (let i = 0; i < 40 && !c; i += 1) {
  await sleep(1500);
  c = await cdp().catch(() => null);
}
if (!c) fail("CDP 未就绪（看 app.log）");
let ev = c.ev;
// 页面稳定等待：启动初期 settingService 首写会触发 reload，旧连接的执行
// 上下文随之销毁，evaluate 会挂起到超时——探针通过后连接才算可用。
for (let i = 0; i < 20; i += 1) {
  const probe = await ev("1 + 1").catch(() => null);
  if (probe === 2) break;
  await sleep(2000);
  const next = await cdp().catch(() => null);
  if (next) {
    c.close();
    c = next;
    ev = c.ev;
  }
}
console.log("✓ CDP 就绪（页面已稳定）");

// ── 1. GetState 初始化 + 模板包填充 ───────────────────────────────────────
const s1 = await getState();
assert(s1?.ok === true, "GetState ok");
assert(
  (s1.state?.employees ?? []).some((e) => e.isFallback === true),
  "默认公司初始化（创始人兜底）",
);
assert(
  (s1.state?.skills ?? []).some((skill) => skill.id === "pack-e2e"),
  "模板包技能幂等填充（pack-e2e）",
);
assert(
  (s1.state?.roleTemplates ?? []).some((t) => t.id === "e2e-工程师"),
  "模板包角色填充（E2E 工程师）",
);
assert(
  s1.state?.packImports?.["demo-pack"] === "e2e0001",
  "packImports 版本戳",
);

// ── 2. 招聘 + 工作项语义（经真实 IPC） ─────────────────────────────────────
const hire = await apply(ev, [
  {
    kind: "employee.hire",
    templateId: "custom",
    roleId: null,
    custom: {
      name: "老王",
      category: "engineering",
      emoji: "🧑‍💻",
      color: "blue",
      vibe: "",
      description: "",
      seniority: "senior",
    },
  },
]);
assert(
  hire?.state?.employees.some((e) => e.name === "老王"),
  "招聘老王",
);
const laowangId = hire.state.employees.find((e) => e.name === "老王").id;

let st = await apply(ev, [
  { kind: "workitem.create", title: "上游", assigneeId: laowangId },
  {
    kind: "workitem.create",
    title: "下游",
    assigneeId: laowangId,
    dependsOn: [],
  },
]);
const upstreamId = st.state.workItems.find((w) => w.title === "上游").id;
const downstreamId = st.state.workItems.find((w) => w.title === "下游").id;
st = await apply(ev, [
  {
    kind: "workitem.update",
    workItemId: downstreamId,
    patch: { dependsOn: [upstreamId] },
  },
]);
assert(
  st.state.workItems.find((w) => w.id === downstreamId).dependsOn.length === 1,
  "依赖写入",
);

// 门控：前置未解决时 in_progress 被拒
st = await apply(ev, [
  { kind: "workitem.status", workItemId: downstreamId, status: "ready" },
  { kind: "workitem.status", workItemId: downstreamId, status: "in_progress" },
]);
assert(
  st.state.workItems.find((w) => w.id === downstreamId).status === "ready",
  "依赖门控：ready→in_progress 被拒",
);

// 上游走链到 done → 下游自动升 ready（传播）
for (const next of ["ready", "in_progress", "review", "done"]) {
  st = await apply(ev, [
    { kind: "workitem.status", workItemId: upstreamId, status: next },
  ]);
}
assert(
  st.state.workItems.find((w) => w.id === downstreamId).status === "ready",
  "依赖传播：上游 done → 下游自动 ready",
);

// ── 3. 升级接手 + 返工 ─────────────────────────────────────────────────────
st = await apply(ev, [
  { kind: "workitem.status", workItemId: downstreamId, status: "in_progress" },
]);
st = await apply(ev, [
  { kind: "workitem.escalate", workItemId: downstreamId, note: "E2E 阻塞" },
]);
assert(
  st.state.workItems.find((w) => w.id === downstreamId).escalatedAt != null,
  "升级上报留痕",
);
st = await apply(ev, [
  {
    kind: "workitem.resolveEscalation",
    workItemId: downstreamId,
    action: "takeover",
  },
]);
const founderId = st.state.employees.find((e) => e.isFallback).id;
assert(
  st.state.workItems.find((w) => w.id === downstreamId).assigneeId ===
    founderId,
  "所有者接手（转派创始人）",
);
st = await apply(ev, [
  {
    kind: "workitem.update",
    workItemId: downstreamId,
    patch: { assigneeId: laowangId },
  },
  { kind: "workitem.status", workItemId: downstreamId, status: "review" },
]);
st = await apply(ev, [
  { kind: "workitem.rework", workItemId: downstreamId, note: "E2E 边界缺口" },
]);
const reworked = st.state.workItems.find((w) => w.id === downstreamId);
assert(
  reworked.status === "in_progress" &&
    (reworked.reworkNotes ?? []).includes("E2E 边界缺口"),
  "返工退回 + 意见追加",
);

// ── 4. 持久化：二次 GetState 一致 ──────────────────────────────────────────
const s2 = await getState();
assert(
  s2.state.workItems.length === s1.state.workItems.length + 2 &&
    s2.state.employees.length === s1.state.employees.length + 1,
  "持久化：重启式 GetState 状态一致",
);

// ── 5. 入站队列：drop → convert / dismiss ─────────────────────────────────
const inboxDir = join(workspace, ".opc", "inbox");
mkdirSync(inboxDir, { recursive: true });
writeFileSync(
  join(inboxDir, "1-convert.json"),
  JSON.stringify({
    title: "入站转正",
    source: "e2e",
    receivedAt: new Date().toISOString(),
  }),
);
writeFileSync(
  join(inboxDir, "2-dismiss.json"),
  JSON.stringify({
    title: "忽略我",
    source: "e2e",
    receivedAt: new Date().toISOString(),
  }),
);
let si = await getState();
// 按 title 断言而非总数：Telegram worker 的首轮拉取可能已把 mock 消息投进
// 同一队列（渠道中立 ingest 的合法并发）。跨进程文件可见性加短轮询兜底；
// 5s 仍不可见则 dump 双侧现场（脚本 readdir vs GetState 响应）一锤定音。
{
  let seen = false;
  for (let i = 0; i < 10 && !seen; i += 1) {
    seen = ["入站转正", "忽略我"].every((t) =>
      (si.inbox ?? []).some((item) => item.title === t),
    );
    if (!seen) {
      await sleep(500);
      si = await getState();
    }
  }
  if (!seen) {
    const dropSide = existsSync(inboxDir)
      ? (await import("node:fs")).readdirSync(inboxDir).join(",")
      : "(目录不存在)";
    console.log(`  [dump] 脚本侧 inbox 目录: ${inboxDir} → ${dropSide}`);
    console.log(
      `  [dump] GetState 响应 ok=${si.ok} inbox=${JSON.stringify(si.inbox)} err=${si.err ?? si.error ?? "无"}`,
    );
    console.log(
      `  [dump] IPC 传参 workspacePath=${WORKSPACE} opcRoot=${join(WORKSPACE, ".opc")}`,
    );
    // 决定性对照：convert 分支会真实 readFile 目标文件——ok=true 说明 main
    // 看得到文件（scanInbox 读取链有鬼）；ok=false+ENOENT 说明 main 视角
    // 根本没有该文件（路径/视图层问题）。
    const probe = JSON.parse(
      await ev(
        `window.zcode.zcodeGoOpcConsumeInbox({ workspacePath: ${JSON.stringify(WORKSPACE)}, fileName: "1-convert.json", convert: { title: "入站对照探针", priority: "low" } }).then(r => JSON.stringify(r))`,
      ),
    );
    console.log(
      `  [dump] ConsumeInbox 对照 ok=${probe.ok} err=${probe.error ?? "无"} 建项=${(probe.state?.workItems ?? []).some((w) => w.title === "入站对照探针")} probe.inbox=${JSON.stringify(probe.inbox)}`,
    );
    // 对照已消费 1-convert.json，恢复现场
    writeFileSync(
      join(inboxDir, "1-convert.json"),
      JSON.stringify({
        title: "入站转正",
        source: "e2e",
        receivedAt: new Date().toISOString(),
      }),
    );
    // main 进程 app.log 尾部：验证新 bundle（GetState inbox 诊断行）与
    // scanInbox 的 readdir 失败 warn 是否在场
    try {
      const tail = readFileSync(appLog, "utf8").split("\n").filter(Boolean);
      const opcLines = tail.filter((line) => line.includes("[zcode-go] OPC"));
      console.log(
        `  [dump] app.log 尾部 OPC 行（${opcLines.length} 条，全部）:\n${opcLines.slice(-8).join("\n")}`,
      );
    } catch (e) {
      console.log(`  [dump] app.log 读取失败: ${e}`);
    }
  }
}
assert(
  ["入站转正", "忽略我"].every((t) =>
    (si.inbox ?? []).some((item) => item.title === t),
  ),
  "入站扫描可见 drop 的 2 条",
);
si = JSON.parse(
  await ev(
    `window.zcode.zcodeGoOpcConsumeInbox({ workspacePath: ${JSON.stringify(WORKSPACE)}, fileName: "1-convert.json", convert: { title: "入站转正", priority: "high" } }).then(r => JSON.stringify(r))`,
  ),
);
assert(
  si.ok === true &&
    (si.state?.workItems ?? []).some((w) => w.title === "入站转正"),
  "convert 建工作项",
);
si = JSON.parse(
  await ev(
    `window.zcode.zcodeGoOpcConsumeInbox({ workspacePath: ${JSON.stringify(WORKSPACE)}, fileName: "2-dismiss.json", convert: null }).then(r => JSON.stringify(r))`,
  ),
);
assert(
  si.ok === true &&
    !["入站转正", "忽略我"].some((t) =>
      (si.inbox ?? []).some((i) => i.title === t),
    ),
  "dismiss 删文件（drop 的两条不再可见）",
);

// ── 6. Telegram 渠道桥：mock API → 入站 ───────────────────────────────────
console.log("6. 等待 Telegram 渠道桥首个轮询周期（10s）…");
await sleep(12000);
const tgInboxDir = join(workspace, ".opc", "inbox");
const tgFiles = existsSync(tgInboxDir)
  ? (await import("node:fs"))
      .readdirSync(tgInboxDir)
      .filter((name) => name.includes("telegram"))
  : [];
assert(tgFiles.length === 1, "Telegram 渠道桥投递入站（1 条）");
assert(telegramHits > 0, "mock API 收到 getUpdates");

// ── 清理 ──────────────────────────────────────────────────────────────────
mockApi.close();
appProc.kill();
rmSync(ws, { recursive: true, force: true });
console.log("✅ OPC E2E 全部断言通过");
process.exit(0);
