/**
 * zcode-go E2E：静默 fork 手动转接（第一批）。
 *
 * 流程：
 *  A. 种子：从真实库克隆一个小会话为合成会话 S（真实消息形状）+ 注入压缩边界
 *     + tasks-index 行（侧栏可见）；
 *  B. 启动 E2E 实例 → CDP 调 zcodeGoSilentFork(S)：
 *     断言 IPC ok、redirect map 落盘、S' 只含边界起内容、S' 无任务行；
 *  C. 点开 S 的任务行 → 会话内容经重定向加载（对话文本可见 = 服务层收口生效）；
 *  D. 清理：map 清条目、S/S'/任务行删除（finally 兜底）。
 *
 * 注意：S 会短暂出现在用户真实侧栏（几分钟），清理后消失。
 * 前置：真实 ~/.zcode 可用；Xvfb :103。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL_SESSION_DB = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const REAL_TASKS_DB = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
const REDIRECT_FILE = join(homedir(), ".zcode-go", "session-redirect.json");
const S = "sess_zge2e_silentfork0";

function seed() {
  const real = new DatabaseSync(REAL_SESSION_DB, { readOnly: true });
  const db = new DatabaseSync(REAL_SESSION_DB, { timeout: 10_000 });
  const tasks = new DatabaseSync(REAL_TASKS_DB, { timeout: 10_000 });
  const tasksProbe = new DatabaseSync(REAL_TASKS_DB, { readOnly: true });
  const template = (() => {
    const candidates = real
      .prepare(
        "SELECT m.session_id AS sid, count(*) AS c FROM message m GROUP BY m.session_id HAVING c >= 6 ORDER BY c ASC LIMIT 40",
      )
      .all();
    for (const cand of candidates) {
      if (tasksProbe.prepare("SELECT 1 FROM tasks WHERE task_id = ? LIMIT 1").get(cand.sid)) {
        return cand;
      }
    }
    return null;
  })();
  tasksProbe.close();
  if (!template) throw new Error("无可克隆模板会话");
  const sid = template.sid;
  const messages = real.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY sequence").all(sid);
  const tailParts = real
    .prepare(
      "SELECT p.data FROM part p JOIN message m ON m.id = p.message_id WHERE m.session_id = ? ORDER BY m.sequence DESC, p.sequence DESC LIMIT 12",
    )
    .all(sid);
  let tailProbe = "";
  for (const row of tailParts) {
    try {
      const payload = JSON.parse(row.data);
      const text = String(payload.text ?? payload.content ?? payload.summary ?? "").trim();
      if (text) {
        tailProbe = text.slice(0, Math.min(12, text.length));
        break;
      }
    } catch { /* 非 JSON part 跳过 */ }
  }

  db.exec("begin immediate");
  try {
    const sessionRow = real.prepare("SELECT * FROM session WHERE id = ?").get(sid);
    const sessionCols = Object.keys(sessionRow).filter((c) => c !== "id");
    db.prepare(
      `INSERT INTO session (id, ${sessionCols.join(", ")}) VALUES (?, ${sessionCols.map(() => "?").join(", ")})`,
    ).run(S, ...sessionCols.map((c) => sessionRow[c]));
    const idMap = new Map();
    messages.forEach((m, i) => {
      const newId = `msg_zge2e_${i}`;
      idMap.set(m.id, newId);
      const cols = Object.keys(m).filter((c) => c !== "id" && c !== "session_id");
      db.prepare(
        `INSERT INTO message (id, session_id, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})`,
      ).run(newId, S, ...cols.map((c) => m[c]));
    });
    for (const m of messages) {
      const parts = real.prepare("SELECT * FROM part WHERE message_id = ?").all(m.id);
      for (let j = 0; j < parts.length; j += 1) {
        const p = parts[j];
        const cols = Object.keys(p).filter((c) => c !== "id" && c !== "session_id" && c !== "message_id");
        db.prepare(
          `INSERT INTO part (id, session_id, message_id, ${cols.join(", ")}) VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")})`,
        ).run(`part_zge2e_${j}_${m.id.slice(-6)}`, S, idMap.get(m.id), ...cols.map((c) => p[c]));
      }
    }
    const entries = real.prepare("SELECT * FROM session_entry WHERE session_id = ?").all(sid);
    for (let k = 0; k < entries.length; k += 1) {
      const e = entries[k];
      const cols = Object.keys(e).filter((c) => c !== "id" && c !== "session_id");
      db.prepare(
        `INSERT INTO session_entry (id, session_id, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})`,
      ).run(`entry_zge2e_${k}`, S, ...cols.map((c) => e[c]));
    }
    // 压缩边界在 messages[2]
    db.prepare(
      "INSERT INTO part (id, session_id, message_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, 0, 0, ?, 0)",
    ).run(
      "part_zge2e_boundary",
      S,
      idMap.get(messages[2].id),
      JSON.stringify({
        type: "compaction",
        compactBoundary: {
          preservedSegment: {
            headMessageId: idMap.get(messages[1].id),
            tailMessageId: idMap.get(messages[3].id),
          },
        },
        summaryMessageId: idMap.get(messages[2].id),
      }),
    );
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }

  // tasks-index 行：克隆模板会话的任务行（workspace_key 同源）
  const templateTask = tasks.prepare("SELECT * FROM tasks WHERE task_id = ?").get(sid);
  if (templateTask) {
    // 整列克隆（仅换 task_id/title/updated_at）——meta_json 保留模板原样：
    // 读取侧按 zod 校验行合法性，手写的最小 meta 会被判非法而隐藏。
    const cols = Object.keys(templateTask).filter((c) => c !== "task_id" && c !== "title");
    tasks.exec("begin immediate");
    try {
      tasks.prepare(
        `INSERT INTO tasks (task_id, title, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})
         ON CONFLICT(workspace_key, task_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      ).run(
        S,
        "ZG静默fork E2E",
        ...cols.map((c) => (c === "updated_at" ? Date.now() : templateTask[c])),
      );
      tasks.exec("commit");
    } catch (e) {
      tasks.exec("rollback");
      throw e;
    }
  }
  real.close();
  db.close();
  tasks.close();
  return { totalMessages: messages.length, tailProbe, hadTaskRow: Boolean(templateTask) };
}

function cleanup(forkId) {
  const db = new DatabaseSync(REAL_SESSION_DB, { timeout: 10_000 });
  const tasks = new DatabaseSync(REAL_TASKS_DB, { timeout: 10_000 });
  for (const sid of [S, forkId].filter(Boolean)) {
    db.prepare("DELETE FROM part WHERE session_id = ?").run(sid);
    db.prepare("DELETE FROM message WHERE session_id = ?").run(sid);
    db.prepare("DELETE FROM session_entry WHERE session_id = ?").run(sid);
    db.prepare("DELETE FROM session WHERE id = ?").run(sid);
    tasks.prepare("DELETE FROM tasks WHERE task_id = ?").run(sid);
  }
  db.close();
  tasks.close();
  try {
    const raw = JSON.parse(readFileSync(REDIRECT_FILE, "utf8"));
    if (raw.redirects && raw.redirects[S]) {
      delete raw.redirects[S];
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
  const page = targets.find((t) => t.type === "page" && t.title === "ZCode");
  if (!page) throw new Error("ZCode 主窗口未找到");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = (expr) =>
    call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then(
      (m) => {
        if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 200));
        return m.result?.result?.value;
      },
    );
  return { ev };
}

// ── main ──
if (!existsSync(REAL_SESSION_DB)) {
  console.log("SKIP: 真实库不可用");
  process.exit(0);
}
cleanup(null); // 上次残留兜底
const { totalMessages, tailProbe, hadTaskRow } = seed();
console.log(`A. seeded S=${S} msgs=${totalMessages} tailProbe=${tailProbe} taskRow=${hadTaskRow}`);
// 应用必须在种子之后启动（侧栏行来自启动期索引装载）
const { spawn } = await import("node:child_process");
const { createWriteStream } = await import("node:fs");
const app = spawn(
  "/home/whc/.zcode-go/electron/zcode",
  ["--user-data-dir=/tmp/zgbridge/second-profile", "--remote-debugging-port=9333"],
  {
    env: {
      ...process.env,
      ZCODE_GO_TAKEOVER: "1",
      ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Go E2E",
      DISPLAY: ":103",
    },
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const appLog = createWriteStream("/tmp/zgbridge/sf-app.log");
app.stdout.pipe(appLog);
app.stderr.pipe(appLog);
let forkId = null;
let pass = false;
try {
  let c = null;
  for (let i = 0; i < 45 && !c; i += 1) {
    await sleep(1500);
    c = await cdp().catch(() => null);
  }
  if (!c) throw new Error("应用 67s 内未就绪（CDP）");
  // 等任务列表出现种子行
  let rowSeen = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1500);
    rowSeen = await c.ev(`!!document.querySelector('li[data-testid="task-item-${S}"]')`);
    if (rowSeen) break;
  }
  console.log("B1. sidebar row visible:", rowSeen);

  // 静默 fork
  const forkResult = await c.ev(
    `window.zcode.zcodeGoSilentFork({ sessionId: "${S}" }).then(r => JSON.stringify(r))`,
  );
  const parsed = JSON.parse(forkResult);
  console.log("B2. silentFork result:", forkResult);
  forkId = parsed.forkSessionId ?? null;
  const ipcOk = parsed.ok === true && typeof forkId === "string";

  // map 文件
  const mapOk = (() => {
    try {
      const raw = JSON.parse(readFileSync(REDIRECT_FILE, "utf8"));
      return raw.redirects?.[S]?.forkSessionId === forkId;
    } catch {
      return false;
    }
  })();

  // DB 断言
  const db = new DatabaseSync(REAL_SESSION_DB, { readOnly: true });
  const forkMsgCount = db.prepare("SELECT count(*) c FROM message WHERE session_id = ?").get(forkId).c;
  const forkTaskRow = (() => {
    const t = new DatabaseSync(REAL_TASKS_DB, { readOnly: true });
    const r = t.prepare("SELECT count(*) c FROM tasks WHERE task_id = ?").get(forkId).c;
    t.close();
    return r;
  })();
  db.close();
  console.log(`B3. fork msgs=${forkMsgCount} (期望 ${totalMessages - 1}), fork task rows=${forkTaskRow} (期望 0)`);
  const dbOk = forkMsgCount === totalMessages - 1 && forkTaskRow === 0;

  // 点开 S → 会话内容经重定向加载
  if (!rowSeen) throw new Error("侧栏未见种子行（B1 失败，跳过 C）");
  await c.ev(`document.querySelector('li[data-testid="task-item-${S}"]').click(); "ok"`);
  let convOk = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    const needle = JSON.stringify(tailProbe);
    convOk = await c.ev(
      tailProbe
        ? `document.body.innerText.includes(${needle})`
        : `!!document.querySelector('[contenteditable="true"]')`,
    );
    if (convOk) break;
  }
  console.log("C. conversation via redirect loaded:", convOk);

  pass = rowSeen && ipcOk && mapOk && dbOk && convOk;
} finally {
  try { app.kill("SIGTERM"); } catch { /* 尽力而为 */ }
  await sleep(1500);
  cleanup(forkId);
  console.log("D. cleaned (S/S'/task rows/map)");
}
console.log(pass ? "SILENT-FORK-OK ✓" : "SILENT-FORK-FAIL ✗");
process.exit(pass ? 0 : 1);
