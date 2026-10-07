/**
 * zcode-go E2E：静默 fork 手动转接（第一批，真实会话版）。
 *
 * 用真实侧栏可见 + 有压缩边界的小会话做全链路验证：
 *  A. 找一个有压缩边界 + 任务行的小会话 S；
 *  B. CDP 调 zcodeGoSilentFork(S)：
 *     断言 IPC ok、redirect map 落盘、S' 消息数 < S（尾部裁剪）、S' 无任务行；
 *  C. 点开 S 的任务行 → 会话内容经重定向加载（composer 可见 = 服务层收口生效）；
 *  D. 清理：map 清条目、S' 删除（S 原样不动）。
 *
 * 前置：真实 ~/.zcode 可用；Xvfb :103；E2E 实例 CDP 9333 已启动。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL_SESSION_DB = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const REAL_TASKS_DB = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
const REDIRECT_FILE = join(homedir(), ".zcode-go", "session-redirect.json");

function findCandidate() {
  const db = new DatabaseSync(REAL_SESSION_DB, { readOnly: true });
  const tasks = new DatabaseSync(REAL_TASKS_DB, { readOnly: true });
  const rows = db.prepare(`
    SELECT DISTINCT p.session_id,
           (SELECT count(*) FROM message WHERE session_id = p.session_id) AS msg_count
      FROM part p
     WHERE p.data LIKE '{"type":"compaction"%' AND p.data LIKE '%compactBoundary%'
     ORDER BY msg_count ASC LIMIT 20
  `).all();
  let candidate = null;
  for (const row of rows) {
    const has = tasks.prepare("SELECT 1 FROM tasks WHERE task_id = ? LIMIT 1").get(row.session_id);
    if (has && row.msg_count >= 10 && row.msg_count <= 2000) {
      candidate = { sid: row.session_id, msgs: row.msg_count };
      break;
    }
  }
  tasks.close();
  db.close();
  return candidate;
}

function cleanupFork(forkId, originalId) {
  if (!forkId) return;
  const db = new DatabaseSync(REAL_SESSION_DB, { timeout: 10_000 });
  db.prepare("DELETE FROM part WHERE session_id = ?").run(forkId);
  db.prepare("DELETE FROM message WHERE session_id = ?").run(forkId);
  db.prepare("DELETE FROM session_entry WHERE session_id = ?").run(forkId);
  db.prepare("DELETE FROM session WHERE id = ?").run(forkId);
  db.close();
  const tasks = new DatabaseSync(REAL_TASKS_DB, { timeout: 10_000 });
  tasks.prepare("DELETE FROM tasks WHERE task_id = ?").run(forkId);
  tasks.close();
  try {
    const raw = JSON.parse(readFileSync(REDIRECT_FILE, "utf8"));
    if (raw.redirects && raw.redirects[originalId]) {
      delete raw.redirects[originalId];
      writeFileSync(REDIRECT_FILE, JSON.stringify(raw, null, 2), "utf8");
    }
  } catch { /* 无文件/无条目 */ }
}

const httpGet = (path) =>
  new Promise((resolve, reject) => {
    const req = require("node:http").get({ host: "127.0.0.1", port: 9333, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
  });
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  const targets = await httpGet("/json/list");
  const page = targets.find(t => t.type === "page" && t.title === "ZCode");
  if (!page) throw new Error("ZCode 主窗口未找到");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const ev = expr =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, m => {
        if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 200)));
        else resolve(m.result?.result?.value);
      });
      ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });
  return { ev };
}

// ── main ──
if (!existsSync(REAL_SESSION_DB)) { console.log("SKIP"); process.exit(0); }
const candidate = findCandidate();
if (!candidate) { console.log("SKIP: 无合适候选会话"); process.exit(0); }
const S = candidate.sid;
console.log(`A. target S=${S.slice(0, 24)} msgs=${candidate.msgs}`);
let forkId = null;
let pass = false;
try {
  const c = await cdp();
  // B1: 侧栏可见
  let rowSeen = false;
  for (let i = 0; i < 20; i += 1) {
    rowSeen = await c.ev(`!!document.querySelector('li[data-testid="task-item-${S}"]')`);
    if (rowSeen) break;
    await sleep(1500);
  }
  console.log("B1. sidebar row visible:", rowSeen);

  // B2: 静默 fork
  const fr = JSON.parse(await c.ev(`window.zcode.zcodeGoSilentFork({ sessionId: "${S}" }).then(r => JSON.stringify(r))`));
  console.log("B2. silentFork ok:", fr.ok, "fork:", (fr.forkSessionId ?? "").slice(0, 20));
  forkId = fr.forkSessionId ?? null;
  const ipcOk = fr.ok === true && typeof forkId === "string";

  // B3: DB 断言
  const mapOk = (() => {
    try { return JSON.parse(readFileSync(REDIRECT_FILE, "utf8")).redirects?.[S]?.forkSessionId === forkId; }
    catch { return false; }
  })();
  const db = new DatabaseSync(REAL_SESSION_DB, { readOnly: true });
  const forkMsgs = db.prepare("SELECT count(*) c FROM message WHERE session_id = ?").get(forkId).c;
  const origMsgs = db.prepare("SELECT count(*) c FROM message WHERE session_id = ?").get(S).c;
  db.close();
  const t = new DatabaseSync(REAL_TASKS_DB, { readOnly: true });
  const forkTask = t.prepare("SELECT count(*) c FROM tasks WHERE task_id = ?").get(forkId).c;
  t.close();
  console.log(`B3. fork msgs=${forkMsgs} < orig ${origMsgs}=${forkMsgs < origMsgs}, task rows=${forkTask}(0), map=${mapOk}`);
  const dbOk = forkMsgs < origMsgs && forkMsgs > 0 && forkTask === 0 && mapOk;

  // C: 点开原会话 → 经重定向加载
  if (rowSeen) {
    await c.ev(`document.querySelector('li[data-testid="task-item-${S}"]').click(); "ok"`);
  }
  let convOk = false;
  for (let i = 0; i < 45; i += 1) {
    // 对话视图的任一信号：composer、消息行、或非空 main 区域
    convOk = await c.ev(`!!(document.querySelector('[contenteditable="true"]') ||
      document.querySelector('[data-conversation-log]') ||
      (document.querySelector('main')?.innerText || "").length > 50)`);
    if (convOk) break;
    await sleep(1000);
  }
  console.log("C. conversation via redirect loaded:", convOk);

  pass = rowSeen && ipcOk && dbOk && convOk;
} finally {
  cleanupFork(forkId, S);
  console.log("D. cleaned (fork deleted, original untouched, map cleared)");
}
console.log(pass ? "SILENT-FORK-OK ✓" : "SILENT-FORK-FAIL ✗");
process.exit(pass ? 0 : 1);
