/**
 * G-only 定位脚本：20000 规模端到端，每阶段 stderr 打点（找挂点用）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  advanceForkFullHistorySegment,
  collectForkFullHistoryParams,
  registerForkFullHistoryTask,
} from "../../packages/services/src/zcode-session/zcodeGoForkFullHistory.js";
import { forkCompactSessionDirect } from "../../packages/desktop/src/main/zcodeGoDirectFork.js";

const TOTAL = Number(process.env.ZCODE_GO_HARNESS_TOTAL ?? 20000);
const BOUNDARY = Math.floor(TOTAL * 0.8);

function step(msg: string): void {
  console.error(`[${(performance.now() / 1000).toFixed(1)}s] ${msg}`);
}

const home = join(tmpdir(), `zg-g-only-${Date.now()}`);
mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
process.env.ZCODE_DATA_BASE_DIR = home;
step(`home=${home} TOTAL=${TOTAL} BOUNDARY=${BOUNDARY}`);

// seed（单事务）
const dbSeed = new DatabaseSync(join(home, ".zcode", "cli", "db", "db.sqlite"));
dbSeed.exec(`
  create table session (id text primary key, project_id text, workspace_id text, parent_id text,
    slug text, directory text, path text, title text, version text, share_url text,
    summary_additions integer, summary_deletions integer, summary_files integer,
    summary_diffs integer, revert text, permission text, time_created integer,
    time_updated integer, time_compacting integer, time_archived integer, task_type text,
    title_source text, title_message_id text, time_title_updated integer, trace_id text);
  create table message (id text primary key, session_id text not null, time_created integer not null,
    time_updated integer not null, data text, sequence integer);
  create table part (id text primary key, session_id text not null, message_id text not null,
    time_created integer, time_updated integer, data text, sequence integer);
  create table session_entry (id text primary key, session_id text not null, type text not null,
    time_created integer, time_updated integer, data text);
`);
const S = "sess_s_g";
dbSeed.prepare("insert into session (id, title) values (?, ?)").run(S, "G");
const insMsg = dbSeed.prepare(
  "insert into message (id, session_id, time_created, time_updated, data, sequence) values (?, ?, 0, 0, ?, ?)",
);
const insPart = dbSeed.prepare(
  "insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) values (?, ?, ?, 0, 0, ?, ?)",
);
dbSeed.exec("begin immediate");
const payload = JSON.stringify({ text: `消息内容 `.repeat(10) });
for (let i = 1; i <= TOTAL; i += 1) {
  const id = `msg_s_${String(i).padStart(6, "0")}`;
  insMsg.run(id, S, payload, i);
  insPart.run(`part_s_${id}`, S, id, JSON.stringify({ p: i, text: `part ${i} `.repeat(4) }), 0);
  if (i === BOUNDARY) {
    insPart.run(
      `part_s_boundary`,
      S,
      id,
      JSON.stringify({
        type: "compaction",
        compactBoundary: {
          preservedSegment: {
            headMessageId: `msg_s_${String(BOUNDARY - 1).padStart(6, "0")}`,
            tailMessageId: id,
          },
        },
      }),
      0,
    );
  }
}
dbSeed.exec("commit");
dbSeed.close();
step(`seed done (${TOTAL} msg)`);

// 官方形态：全量复制 + 水合 + 首条消息
{
  const db = new DatabaseSync(join(home, ".zcode", "cli", "db", "db.sqlite"), { timeout: 10_000 });
  let t0 = performance.now();
  db.exec("begin immediate");
  db.prepare("insert into session (id, parent_id, title) values (?, ?, ?)").run("sess_child_off", S, "Fork");
  db.prepare(
    "insert into message (id, session_id, time_created, time_updated, data, sequence) " +
      "select 'msg_off_' || id, 'sess_child_off', time_created, time_updated, data, sequence from message where session_id = ?",
  ).run(S);
  db.prepare(
    "insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) " +
      "select 'part_off_' || id, 'sess_child_off', 'msg_off_' || message_id, time_created, time_updated, data, sequence from part where session_id = ?",
  ).run(S);
  db.exec("commit");
  step(`官方 fork 可用: ${(performance.now() - t0).toFixed(0)}ms`);
  t0 = performance.now();
  const rows = db
    .prepare("select m.data, p.data as pdata from message m left join part p on p.message_id = m.id where m.session_id = ? order by m.sequence")
    .all("sess_child_off") as unknown as Array<{ data: string; pdata: string | null }>;
  for (const r of rows) {
    JSON.parse(r.data);
    if (r.pdata) JSON.parse(r.pdata);
  }
  step(`官方 runtime 水合(全量 ${rows.length} 行): ${(performance.now() - t0).toFixed(0)}ms`);
  t0 = performance.now();
  db.prepare(
    "insert into message (id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?)",
  ).run("msg_off_new", "sess_child_off", Date.now(), Date.now(), JSON.stringify({ role: "user" }), TOTAL + 1);
  step(`官方首条消息投递: ${(performance.now() - t0).toFixed(2)}ms`);
  db.close();
}

// 我们：direct 精简 fork ×2 + redirect + backfill
const tFork0 = performance.now();
const endpoint = forkCompactSessionDirect({
  parentSessionId: S,
  silent: true,
  sessionDbPath: join(home, ".zcode", "cli", "db", "db.sqlite"),
});
step(`F' 精简端点 fork: ${(performance.now() - tFork0).toFixed(0)}ms`);
const tF1 = performance.now();
const visible = forkCompactSessionDirect({
  parentSessionId: S,
  silent: false,
  sessionDbPath: join(home, ".zcode", "cli", "db", "db.sqlite"),
});
step(`F 可见副本 fork: ${(performance.now() - tF1).toFixed(0)}ms`);
const F = visible.childSessionId!;
const { setZcodeGoSessionRedirect } = await import(
  "../../packages/services/src/zcode-agent/zcodeGoSessionRedirect.js"
);
setZcodeGoSessionRedirect(F, {
  forkSessionId: endpoint.childSessionId!,
  createdAt: Date.now(),
  createdBy: "manual",
  hover: true,
});
step("redirect F→F' (hover) 落盘");
const collected = collectForkFullHistoryParams(S, F);
if (!collected.ok) throw new Error(`collect: ${collected.error}`);
const task = registerForkFullHistoryTask({ childSessionId: F, originalSessionId: S, ...collected.params! });
step(`backfill 任务登记: boundaryTotal=${task.boundaryTotal}`);
const db = new DatabaseSync(join(home, ".zcode", "cli", "db", "db.sqlite"), { timeout: 10_000 });
const tBackfill0 = performance.now();
let lastLog = task.injected;
for (;;) {
  advanceForkFullHistorySegment(task, db);
  if (task.injected - lastLog >= 2000) {
    lastLog = task.injected;
    step(`补齐进度 ${task.injected}/${task.boundaryTotal}`);
  }
  if (task.status === "done") break;
}
step(`全量补齐完成: ${(performance.now() - tBackfill0).toFixed(0)}ms`);
const tHy = performance.now();
const rows = db
  .prepare("select data from message where session_id = ? order by sequence")
  .all(F) as unknown as Array<{ data: string }>;
for (const r of rows) JSON.parse(r.data);
step(`F runtime 水合(全量 ${rows.length} 行): ${(performance.now() - tHy).toFixed(0)}ms`);
db.close();
rmSync(home, { recursive: true, force: true });
console.log("G-ONLY-OK");
