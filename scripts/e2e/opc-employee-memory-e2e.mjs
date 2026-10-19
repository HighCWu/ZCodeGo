#!/usr/bin/env node
/* oxlint-disable eslint(max-lines) -- zcode-go 机制/E2E/插件宿主文件：单文件收口（同 SessionPane 惯例）。 */
/**
 * zcode-go E2E：OPC 员工持久记忆（data dir 沙箱 + GetState 回读 + 重启持久）。
 *
 * 与 opc-e2e 同一套 HOME 沙箱 + CDP 基建（HOME=沙箱 → 员工 data dir 与
 * 主实例 ~/.zcode 物理隔离天然成立，绝不触碰真实机器的 ~/.zcode）。
 *
 * 断言链：
 *   1. GetState 触发批量初始化：员工记忆根目录
 *      .opc/employees/<id>/.zcode/cli/memories/projects/<slug>-<hash>/memory/
 *      创建（与 CLI resolveProjectMemoryRoot 无 identity 分支同款：slug=目录
 *      名、hash=sha256(绝对路径)[:16]）；employeeMemoryPaths 回读该相对路径；
 *   2. GetState 回读：新员工 memoryIndex/personaDigest 为 null、principles
 *      为空数组（绑定就绪、内容为空的初始态）；
 *   3. 沙箱语义：CLI 视角（员工 data 根）写入 MEMORY.md，GetState 回读含该
 *      内容（main 与 CLI 同一物理落点——全链闭合）；
 *   4. 重启持久：杀 app 重启（同 profile）→ 记忆根仍在 → GetState 索引仍在
 *      （数据在 .opc，不随进程丢失）；
 *   5. 隔离：两名员工的记忆根互不相扰（各自 hash 独立）。
 *
 * 运行：node scripts/e2e/opc-employee-memory-e2e.mjs（需 Xvfb 显示与已装配
 * 的 ~/.zcode-go/electron，同既有 E2E；CI 由 official-e2e.yml 循环拉起）。
 */
import { spawn } from "node:child_process";
import {
  createHash,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REAL_STATE_DIR = join(homedir(), ".zcode-go");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON =
  process.env.ZCODE_GO_E2E_APP_BIN ?? join(REAL_STATE_DIR, "electron", "zcode");
const CDP_PORT = 9347;
const PROFILE_TAG = "zg-opc-empmem-e2e-profile";
const E2E_DISPLAY = process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103";

const ws = join(tmpdir(), `zg-opc-empmem-e2e-${Date.now()}`);
{
  const { spawnSync: ps, execSync } = await import("node:child_process");
  try {
    execSync("fuser -k 9347/tcp 2>/dev/null || true", {
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
const WORKSPACE = workspace;
const appLog = join(ws, "app.log");

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

// 与 shared opc-employee-memory.ts / CLI project-root.ts 同算法
function memoryIdentity(workspacePath, employeeId) {
  return `opc-employee/${workspacePath}::${employeeId}`;
}
function memoryHash(workspacePath) {
  return createHash("sha256").update(resolve(workspacePath)).digest("hex").slice(0, 16);
}
function sandboxMemoryRoot(workspacePath, employeeId) {
  // 与 CLI resolveProjectMemoryRoot（无 identity 输入分支）同款：v4 子进程
  // 的 runtime 不携带员工 identity，记忆根按「路径键」解析——slug=目录名、
  // hash=sha256(绝对路径)[:16]。隔离由每员工独立 storage root 物理保证。
  const slug = basename(workspacePath).toLowerCase() || "project";
  return join(
    workspacePath,
    ".opc",
    "employees",
    employeeId,
    ".zcode",
    "cli",
    "memories",
    "projects",
    `${slug}-${memoryHash(workspacePath)}`,
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
    ws0.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
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
    return { ev, close: () => ws0.close() };
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

// ── 启动 app（HOME=沙箱） ─────────────────────────────────────────────────
mkdirSync(sandboxHome, { recursive: true });
if (process.platform === "win32") {
  mkdirSync(join(sandboxHome, "AppData", "Roaming"), { recursive: true });
  mkdirSync(join(sandboxHome, "AppData", "Local"), { recursive: true });
}
mkdirSync(join(sandboxHome, ".zcode-go"), { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });

const appArgs = [
  ELECTRON,
  `--user-data-dir=${join(sandboxHome, ".zcode-go", PROFILE_TAG)}`,
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

// 等 CDP 就绪（首连成功即继续）
{
  let ready = false;
  for (let i = 0; i < 30 && !ready; i += 1) {
    ready = await httpGet("/json/version").then(() => true).catch(() => false);
    if (!ready) await sleep(2000);
  }
  assert(ready, "CDP 端口就绪");
}

// ── 1. 招聘两名员工 → GetState 触发批量绑定 ────────────────────────────────
let st = await getState();
assert(st && st.ok && st.state, "GetState 初始化（沙箱 HOME）");
{
  // 绑定在 GetState handler 内完成——但首次 GetState 时可能尚无员工，
  // 先 hire 再 GetState（第二次 GetState 覆盖新员工的绑定）
}
let hire = await (async () => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const c = await cdp().catch(() => null);
    if (!c) {
      await sleep(2000);
      continue;
    }
    const r = await c
      .ev(
        `window.zcode.zcodeGoOpcApply({ workspacePath: ${JSON.stringify(WORKSPACE)}, mutations: [
          { kind: "employee.hire", templateId: "custom", roleId: null, custom: { name: "老王", category: "engineering" } },
          { kind: "employee.hire", templateId: "custom", roleId: null, custom: { name: "李四", category: "engineering" } }
        ] }).then(r => JSON.stringify(r)).catch(e => "THROW: " + String(e).slice(0, 150))`,
        25000,
      )
      .catch(() => null);
    c.close();
    if (r) return JSON.parse(r);
    await sleep(2000);
  }
  return null;
})();
assert(hire && hire.ok, "招聘老王/李四（Apply 经真实 IPC）");
const laowangId = hire.state.employees.find((e) => e.name === "老王").id;
const lisiId = hire.state.employees.find((e) => e.name === "李四").id;

st = await getState();
assert(st && st.ok, "二次 GetState（绑定后的回读）");

// ── 2. 绑定落点断言（fs + 回读路径） ──────────────────────────────────────
for (const [name, id] of [
  ["老王", laowangId],
  ["李四", lisiId],
]) {
  const root = sandboxMemoryRoot(WORKSPACE, id);
  assert(existsSync(root), `${name} 记忆根已创建（员工 data dir 内）：${root}`);
  // symlink 时代已退役：主 HOME 的 ~/.zcode 下不再产生员工链接
  assert(
    !existsSync(join(sandboxHome, ".zcode", "cli", "memories", "projects", `project-${memoryHash(WORKSPACE, id)}`)),
    `${name} 主 HOME 无员工记忆链接（链接形态已退役）`,
  );
  assert(
    typeof st.employeeMemoryPaths?.[id] === "string" &&
      st.employeeMemoryPaths[id].endsWith(
        `/.zcode/cli/memories/projects/workspace-${memoryHash(WORKSPACE)}/memory`,
      ),
    `${name} employeeMemoryPaths 回读记忆根相对路径`,
  );
}



// ── 3. GetState 回读断言（初始态） ────────────────────────────────────────
for (const [name, id] of [
  ["老王", laowangId],
  ["李四", lisiId],
]) {
  assert(
    st.employeeMemoryIndexes && st.employeeMemoryIndexes[id] === null,
    `${name} 初始 memoryIndex 为 null（绑定就绪、内容为空）`,
  );
  assert(
    st.employeePersonaDigests && st.employeePersonaDigests[id] === null,
    `${name} 初始 personaDigest 为 null`,
  );
  assert(
    st.employeePrinciples && Array.isArray(st.employeePrinciples[id]) && st.employeePrinciples[id].length === 0,
    `${name} 初始 principles 为空数组`,
  );
}

// ── 4. 沙箱语义：CLI 视角（员工 data 根）写入 → GetState 回读 ─────────────
{
  const root = sandboxMemoryRoot(WORKSPACE, laowangId);
  writeFileSync(join(root, "MEMORY.md"), "- [供应商延期](vendor-delay.md) — 先冻结需求\n", "utf8");
  st = await getState();
  assert(
    st.employeeMemoryIndexes[laowangId]?.includes("先冻结需求"),
    "GetState 回读的索引含写入内容（main 与 CLI 同一物理落点——全链闭合）",
  );
  // 李四未写，索引仍为 null
  assert(
    st.employeeMemoryIndexes[lisiId] === null,
    "李四索引保持 null（员工间隔离）",
  );
}

// ── 5. 重启持久：杀 app → 重启 → 记忆根仍在、索引仍在 ────────────────────
appProc.kill("SIGTERM");
await sleep(3000);
try {
  appProc.kill("SIGKILL");
} catch {
  /* 已退出 */
}
appProc = spawn(ELECTRON, appArgs, {
  env: appEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
appProc.stdout.on("data", appendLog);
appProc.stderr.on("data", appendLog);
{
  let ready = false;
  for (let i = 0; i < 30 && !ready; i += 1) {
    ready = await httpGet("/json/version").then(() => true).catch(() => false);
    if (!ready) await sleep(2000);
  }
  assert(ready, "重启后 CDP 端口就绪");
}
st = await getState();
assert(st && st.ok, "重启后 GetState");
assert(
  st.employeeMemoryIndexes[laowangId]?.includes("先冻结需求"),
  "重启后索引仍在（数据在 .opc 的员工 data dir 内，不随进程丢失）",
);
{
  const root = sandboxMemoryRoot(WORKSPACE, laowangId);
  assert(existsSync(root), "重启后记忆根目录仍在（幂等 ensure）");
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
console.log("\n✅ opc-employee-memory E2E 全部通过");
appProc.kill("SIGTERM");
await sleep(1000);
try {
  appProc.kill("SIGKILL");
} catch {
  /* 已退出 */
}
// rmSync(ws, { recursive: true, force: true }); // 诊断期保留现场
process.exit(0);
