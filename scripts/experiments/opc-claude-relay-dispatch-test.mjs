#!/usr/bin/env node
/* oxlint-disable eslint(max-lines) -- 一次性真实端点派发验收试验（单文件收口）。 */
/**
 * zcode-go 真实端点派发验收试验：Anthropic 兼容聚合端点 + 员工独立模型选择。
 *
 * 与桌面派发 E2E 同链路，但 provider 指向真实聚合端点（api.790053500.com，
 * anthropic-messages 协议，API key 取自 ~/.claude/settings.json 的
 * ANTHROPIC_AUTH_TOKEN）——验证员工独立模型 + 派发全链对真实端点的可用性。
 * 不触碰 OAuth 凭据（无 safeStorage/keyring 依赖，Xvfb 可跑）。
 *
 * 隔离与安全：HOME=沙箱；API key 只写入沙箱配置；试验结束删除沙箱。
 * 运行：node scripts/experiments/opc-claude-relay-dispatch-test.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const ELECTRON =
  process.env.ZCODE_GO_E2E_APP_BIN ?? join(homedir(), ".zcode-go", "electron", "zcode");
const CDP_PORT = 9352;
const PROFILE_TAG = "opc-claude-relay-test";

// 端点/key/模型均可经环境变量覆盖（默认取 ~/.claude/settings.json 的 relay 配置）；
// key 走环境变量时不落仓库。
const claudeSettings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
const AUTH_TOKEN = process.env.OPC_KEY ?? claudeSettings?.env?.ANTHROPIC_AUTH_TOKEN;
const BASE_URL = process.env.OPC_ENDPOINT ?? claudeSettings?.env?.ANTHROPIC_BASE_URL;
const PROVIDER_ID = process.env.OPC_PROVIDER_ID ?? "claude-relay";
const MODEL_ID = process.env.OPC_MODEL ?? "claude-opus-5-5";
if (!AUTH_TOKEN || !BASE_URL) {
  console.error("❌ ~/.claude/settings.json 缺少 env.ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL");
  process.exit(1);
}
const endpointHost = new URL(BASE_URL).hostname;

const ws = join(tmpdir(), `opc-claude-relay-${Date.now()}`);
const sandboxHome = join(ws, "home");
const WORKSPACE = join(ws, "workspace");
const appLog = join(ws, "app.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = await import("node:http");
const httpGet = (path, port = CDP_PORT) =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
  });

function fail(message) {
  // 不直接 exit(1)：跳过 finally 会导致 app 进程树泄漏（残留实例占用 CDP
  // 端口污染后续运行）与沙箱（含 API key 拷贝）不清理。
  throw new Error(message);
}
function assert(condition, message) {
  if (!condition) fail(message);
  console.log(`✓ ${message}`);
}

function memoryProjectDirName(workspacePath) {
  const normalized = workspacePath;
  const keySource =
    process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug =
    basename(normalized)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project";
  return `${slug}-${hash}`;
}
function sandboxMemoryRoot(workspacePath, employeeId) {
  return join(
    workspacePath,
    ".opc",
    "employees",
    employeeId,
    ".zcode",
    "cli",
    "memories",
    "projects",
    memoryProjectDirName(workspacePath),
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

// ── 0. 沙箱 + 端点配置（API key 来自 ~/.claude/settings.json） ─────────────
mkdirSync(join(sandboxHome, ".zcode", "v2"), { recursive: true });
mkdirSync(join(sandboxHome, ".zcode-go"), { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });

const officialJson = join(homedir(), ".zcode-go", "official.json");
if (existsSync(officialJson)) {
  copyFileSync(officialJson, join(sandboxHome, ".zcode-go", "official.json"));
}
// runtime/provider 种子（同 fake E2E：冷启动无 Active 缓存会导致发送全拒）
const realProviderRuntime = join(homedir(), ".zcode", "v2", "runtime", "provider");
if (existsSync(realProviderRuntime)) {
  cpSync(realProviderRuntime, join(sandboxHome, ".zcode", "v2", "runtime", "provider"), {
    recursive: true,
  });
}

// provider 配置：单一 anthropic-messages 聚合 provider
writeFileSync(
  join(sandboxHome, ".zcode", "v2", "provider_config.json"),
  JSON.stringify({
    schemaVersion: 1,
    config: {
      providerOrder: ["claude-relay"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: PROVIDER_ID,
            templateId: "anthropic",
            providerName: "claude-relay",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: AUTH_TOKEN },
              api: { type: "anthropic-messages", baseUrl: BASE_URL },
              personalModelIds: [MODEL_ID],
              modelOrder: [MODEL_ID],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [],
      },
    },
  }),
);
assert(Boolean(AUTH_TOKEN) && Boolean(BASE_URL), `端点配置就绪（${endpointHost}，${PROVIDER_ID}/${MODEL_ID}）`);

// ── 启动 app ────────────────────────────────────────────────────────────────
mkdirSync(join(sandboxHome, ".zcode-go", PROFILE_TAG), { recursive: true });
const appArgs = [
  ELECTRON,
  "--lang=zh-CN",
  `--open-workspace=${WORKSPACE}`,
  `--user-data-dir=${join(sandboxHome, ".zcode-go", PROFILE_TAG)}`,
  `--remote-debugging-port=${CDP_PORT}`,
  ...(process.platform === "linux" ? ["--no-sandbox"] : ["--disable-gpu"]),
];
const appEnv = {
  PATH: process.env.PATH,
  LANG: process.env.LANG ?? "zh_CN.UTF-8",
  HOME: sandboxHome,
  ...(process.platform === "linux"
    ? {
        DISPLAY: process.env.ZCODE_GO_E2E_DISPLAY?.trim() || ":103",
        ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
      }
    : {}),
  ZCODE_DESKTOP_APPLICATION_NAME: "OPC Claude Relay Test",
};
let appProc = null;
const logFs = await import("node:fs/promises");
async function startApp() {
  appProc = spawn(ELECTRON, appArgs, {
    env: appEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  appProc.stdout.on("data", (c) => void logFs.appendFile(appLog, c).catch(() => {}));
  appProc.stderr.on("data", (c) => void logFs.appendFile(appLog, c).catch(() => {}));
  let ready = false;
  for (let i = 0; i < 30 && !ready; i += 1) {
    ready = await httpGet("/json/version").then(() => true).catch(() => false);
    if (!ready) await sleep(2000);
  }
  if (!ready) throw new Error("CDP 端口未就绪");
  // 等页面 JS 可响应（渲染器可能仍在加载）
  for (let i = 0; i < 15; i += 1) {
    const c = await cdp().catch(() => null);
    if (c) {
      c.close();
      return;
    }
    await sleep(1500);
  }
  throw new Error("CDP 页面未就绪");
}
async function killApp() {
  try {
    appProc?.kill("SIGTERM");
  } catch {
    /* 尽力而为 */
  }
  await sleep(1500);
  try {
    appProc?.kill("SIGKILL");
  } catch {
    /* 已退出 */
  }
}

let employeeId = null;
let sessionId = null;

try {
  await startApp();
  {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const c = await cdp().catch(() => null);
      if (!c) {
        await sleep(2000);
        continue;
      }
      const ok = await c.ev(
        "localStorage.setItem('zcode-interface-mode', 'opc'); location.reload(); true",
        10000,
      );
      c.close();
      if (ok) break;
      await sleep(2000);
    }
    let readyAgain = false;
    for (let i = 0; i < 30 && !readyAgain; i += 1) {
      readyAgain = await httpGet("/json/version").then(() => true).catch(() => false);
      if (readyAgain) {
        const c = await cdp().catch(() => null);
        if (c) c.close();
        else readyAgain = false;
      }
      if (!readyAgain) await sleep(2000);
    }
    assert(readyAgain, "OPC 模式 reload 完成");
  }

  // ── 1. 过 onboarding（API key 随意填，goal-verify 同款；不影响 claude-relay 派发） ──
  {
    let onboarded = false;
    const rHistory = [];
    for (let i = 0; i < 40 && !onboarded; i += 1) {
      const c = await cdp().catch(() => null);
      if (!c) {
        await sleep(1500);
        continue;
      }
      const r = await c.ev(
        `(() => {
          if (document.querySelector('[contenteditable="true"]')) return "composer";
          const btns = Array.from(document.querySelectorAll("button")).filter((b) => b.offsetParent !== null);
          const apikey = btns.find((b) => /使用 API key|Use API key/i.test(b.innerText || ""));
          if (apikey) { apikey.click(); return "apikey"; }
          const next = btns.find((b) => ["继续", "Continue"].includes((b.innerText || "").trim()));
          if (next) { next.click(); return "continue"; }
          const skip = btns.find((b) => ["跳过", "Skip"].includes((b.innerText || "").trim()));
          if (skip) { skip.click(); return "skip"; }
          // 启动期偶现「数据准备进程意外退出」可重试对话框（worker 实际已 ready，
          // 渲染器错过启动状态事件）：点重试即恢复。
          const retry = btns.find((b) => /重试|Retry/.test(b.innerText || ""));
          if (retry) { retry.click(); return "retry-dialog"; }
          return "wait|" + (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 100);
        })()`,
        15000,
      );
      if (r === "apikey") {
        await sleep(1200);
        await c.ev(
          `(() => {
            const inputs = Array.from(document.querySelectorAll("input")).filter((el) => el.offsetParent !== null);
            const inp = inputs[0];
            if (!inp) return "no-input";
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(inp, "sk-claude-relay-test");
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            return "filled";
          })()`,
          10000,
        );
        await sleep(400);
        await c.ev(
          `Array.from(document.querySelectorAll("button")).find((b) => b.offsetParent !== null && ["继续", "Continue"].includes((b.innerText || "").trim()))?.click(); "ok"`,
          10000,
        );
      }
      rHistory.push(`${i}:${r ?? "null"}`);
      if (r === "composer") onboarded = true;
      c.close();
      // transport_closed 对话框按设计不可重试（服务已部分装配）：重启 app 恢复
      //（worker 实际已 ready，渲染器错过启动状态事件；重启后重新等 composer）
      if (r && String(r).includes("数据准备进程意外退出")) {
        console.error(`[restart@${i}] 启动对话框出现，重启 app 恢复`);
        await killApp();
        await startApp();
        rHistory.push(`${i}:restarted`);
        continue;
      }
      if (!onboarded && (i === 8 || i === 20 || i === 30)) {
        console.error(`[r-history@${i}]`, rHistory.slice(-12).join(" "));
      }
      if (!onboarded && i === 30) {
        const dump = await c
          .ev(
            `JSON.stringify({ body: (document.body.innerText || "").slice(0, 240), btns: [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null).map((b) => (b.innerText || "").slice(0, 14)).slice(0, 12) })`,
            10000,
          )
          .catch((e) => "dump-failed:" + String(e).slice(0, 80));
        console.error(`[diag@30]`, String(dump).slice(0, 480));
      }
      if (!onboarded) await sleep(1500);
    }
    assert(onboarded, "onboarding 通过（composer 就绪）");
  }

  // ── 2. composer 就绪 ──
  {
    let composerOk = false;
    for (let i = 0; i < 40 && !composerOk; i += 1) {
      const c = await cdp().catch(() => null);
      if (!c) {
        await sleep(1500);
        continue;
      }
      const r = await c.ev(
        `JSON.stringify({ composer: !!document.querySelector('[contenteditable="true"]') })`,
        10000,
      );
      c.close();
      composerOk = (JSON.parse(r ?? "{}")?.composer ?? false) === true;
      if (!composerOk) await sleep(1500);
    }
    assert(composerOk, "composer 就绪");
  }

  // ── 2. OPC 招聘 + 员工钉定 claude-opus-5-5 ──
  let st = await getState();
  assert(st && st.ok && st.state, "GetState 初始化");
  const hire = await applyMutations([
    {
      kind: "employee.hire",
      templateId: "custom",
      roleId: null,
      custom: { name: "老王", category: "engineering" },
    },
  ]);
  assert(hire && hire.ok, "招聘老王");
  employeeId = hire.state.employees.find((e) => e.name === "老王").id;
  const pinned = await applyMutations([
    {
      kind: "employee.update",
      employeeId,
      patch: { modelSelection: { providerId: PROVIDER_ID, modelId: MODEL_ID } },
    },
  ]);
  assert(pinned && pinned.ok, `员工钉定 ${PROVIDER_ID}/${MODEL_ID}（员工独立模型选择）`);

  st = await getState();
  assert(st && st.ok, "二次 GetState（记忆根绑定）");
  const memoryRoot = sandboxMemoryRoot(WORKSPACE, employeeId);
  assert(existsSync(memoryRoot), `记忆根已创建：${memoryRoot}`);
  writeFileSync(
    join(memoryRoot, "MEMORY.md"),
    "- [relay 派发锚点](anchor.md) — claude-relay-hook\n",
    "utf8",
  );

  // ── 3. 建工作项 → 编排派发 ──
  const created = await applyMutations([
    {
      kind: "workitem.create",
      title: "claude-relay-dispatch 验收项",
      detail:
        "真实端点派发验收：这是一个验收任务。请直接回复「验收完成」四个字，并在回复的最后一行单独输出完成标记：<!-- zcode-go:opc-done marker -->。除此之外不要做任何其它事情，不要读写任何文件。",
      assigneeId: employeeId,
    },
  ]);
  assert(created && created.ok, "创建工作项");
  const workItemId = created.state.workItems.find((w) =>
    w.title.includes("claude-relay-dispatch"),
  ).id;
  const readied = await applyMutations([
    { kind: "workitem.status", workItemId, status: "ready" },
  ]);
  assert(readied && readied.ok, "工作项置为 ready");

  {
    const monitor = await cdp();
    assert(monitor, "CDP 监控连接建立");
    let dispatched = null;
    try {
      for (let attempt = 0; attempt < 10 && !dispatched; attempt += 1) {
        await monitor.ev(
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
        for (let i = 0; i < 12 && !dispatched; i += 1) {
          await sleep(5000);
          const s = await monitor
            .ev(
              `(() => { const p = window.zcode.zcodeGoOpcGetState({ workspacePath: ${JSON.stringify(WORKSPACE)} }); return p.then(r => JSON.stringify(r)).catch(e => null); })()`,
              30000,
            )
            .catch(() => null);
          const it = s
            ? (JSON.parse(s)?.state?.workItems ?? []).find((w) => w.id === workItemId)
            : null;
          if (it?.sessionId) dispatched = it;
        }
      }
      assert(dispatched, "工作项已派发（sessionId 落账）");
    } finally {
      monitor.close();
    }
    sessionId = dispatched.sessionId;
  }

  // ── 3.5 usage 落库等待（轮次收尾后聚合落账，约 20s）──
  {
    const employeeDb = join(
      WORKSPACE, ".opc", "employees", employeeId, ".zcode", "cli", "db", "db.sqlite",
    );
    const usageRows = () => {
      try {
        const db = new DatabaseSync(employeeDb, { readOnly: true });
        const rows = db
          .prepare("select status, model_id, input_tokens, output_tokens from model_usage")
          .all();
        db.close();
        return rows;
      } catch {
        return [];
      }
    };
    let usageOk = false;
    for (let i = 0; i < 12 && !usageOk; i += 1) {
      await sleep(10000);
      usageOk = usageRows().some(
        (r) => r.status === "completed" && r.model_id === MODEL_ID && r.input_tokens > 0,
      );
    }
    const rows = usageRows();
    const completedRow = rows.find((r) => r.status === "completed");
    assert(Boolean(completedRow), "model_usage 有 completed 行（usage 链路复用 zcode 原版）");
    assert(
      completedRow && completedRow.model_id === MODEL_ID,
      `model_usage 模型 = ${MODEL_ID}（实际 ${completedRow?.model_id}）`,
    );
  }

  // ── 4. 等真实端点轮次完成 ──
  {
    const employeeDb = join(
      WORKSPACE,
      ".opc",
      "employees",
      employeeId,
      ".zcode",
      "cli",
      "db",
      "db.sqlite",
    );
    let reply = null;
    for (let i = 0; i < 48 && !reply; i += 1) {
      await sleep(5000);
      if (!existsSync(employeeDb)) continue;
      try {
        const db = new DatabaseSync(employeeDb, { readOnly: true });
        // 回复正文在 part 表（message 表只是信封投影）
        const rows = db.prepare("select data from part where data like '%验收完成%'").all();
        db.close();
        if (rows.length > 0) reply = String(rows[0].data);
      } catch {
        /* 库忙 */
      }
    }
    assert(reply, "真实端点轮次完成（assistant 回复含「验收完成」落员工库）");
    console.log(`  回复摘要: ${reply.slice(0, 200).replace(/\\n/g, " ")}`);
  }

  // ── 5. 断言：模型身份与隔离 ──
  {
    const employeeDb = join(
      WORKSPACE,
      ".opc",
      "employees",
      employeeId,
      ".zcode",
      "cli",
      "db",
      "db.sqlite",
    );
    const db = new DatabaseSync(employeeDb, { readOnly: true });
    const stamp = db
      .prepare("select data from session_entry where type = 'runtime/model_selection'")
      .get();
    assert(
      stamp && String(stamp.data).includes(MODEL_ID),
      `会话盖章模型 = ${MODEL_ID}`,
    );
    let usage = "[]";
    try {
      usage = JSON.stringify(db.prepare("select * from model_usage").all());
    } catch {
      /* 表可能为空 */
    }
    db.close();
    // 聚合端点可能不回传 usage 字段（模型用量统计为空）——员工独立模型的
    // 权威证据是会话盖章断言（上一条），这里仅在 usage 有值时才校验模型名。
    if (usage !== "[]") {
      assert(usage.includes(MODEL_ID), "model_usage 记录该模型");
    } else {
      console.log("ℹ️ model_usage 为空（端点未回传 usage），以会话盖章为准");
    }
    const mainDb = join(sandboxHome, ".zcode", "cli", "db", "db.sqlite");
    let leaked = false;
    if (existsSync(mainDb)) {
      const db2 = new DatabaseSync(mainDb, { readOnly: true });
      const row = db2.prepare("select id from session where id = ?").get(sessionId);
      db2.close();
      leaked = Boolean(row);
    }
    assert(!leaked, "主实例沙箱 db 不含员工会话（物理隔离）");
  }

  console.log("\n✅ 真实端点（anthropic relay）派发验收通过");
} catch (error) {
  console.error("❌ 试验异常:", error);
  process.exitCode = 1;
} finally {
  await killApp();
  if (process.env.OPC_KEEP === "1") {
    console.error(`⚠️ OPC_KEEP=1：沙箱保留现场 ${ws}（内含 API key 拷贝，看完即删）`);
  } else {
    try {
      rmSync(ws, { recursive: true, force: true });
      console.log("🧹 沙箱已删除（API key 拷贝不残留）");
    } catch (error) {
      console.error(`⚠️ 沙箱删除失败，请手动删除：${ws}`, error);
    }
  }
}
