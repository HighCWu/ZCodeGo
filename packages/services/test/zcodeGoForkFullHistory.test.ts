import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceForkFullHistorySegment,
  collectForkFullHistoryParams,
  getForkFullHistoryTask,
  registerForkFullHistoryTask,
  waitForForkFullHistoryDone,
  type EnrichDb,
} from "../src/zcode-session/zcodeGoForkFullHistory.js";

/**
 * zcode-go hover fork 流式全量契约（用户定稿）：
 * - forkAssistant（边界后内容）完成后登记任务：游标=boundaryRowid、preserved
 *   区间按 S 的 rowid 圈定、boundaryTotal=边界前非 preserved 总数；
 * - 分段倒序推进：每段从 lastSRowid 往前取，注入 child 头部（zgk 新 id、
 *   nextLowerSeq 递减），preserved 段跳过；全部注入后 status=done；
 * - waitForForkFullHistoryDone：done/absent 判定（rowsRange 放行依据）。
 */

function createDb(dir: string): string {
  const dbPath = join(dir, ".zcode", "cli", "db", "db.sqlite");
  mkdirSync(join(dir, ".zcode", "cli", "db"), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table session (id text primary key, parent_id text);
    create table message (
      id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text, sequence integer);
    create table part (
      id text primary key, session_id text not null, message_id text not null,
      time_created integer, time_updated integer, data text, sequence integer);
  `);
  db.close();
  return dbPath;
}

function open(dbPath: string): EnrichDb {
  return new DatabaseSync(dbPath) as unknown as EnrichDb;
}

test("流式全量：登记→分段倒序推进→done，child 最终序=S 全量序", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-forkfull-"));
  process.env.ZCODE_DATA_BASE_DIR = dir;
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = join(dir, "zcode-go");
  const dbPath = createDb(dir);
  const S = "sess_s000000000000000";
  const CHILD = "sess_c000000000000000";
  try {
    const db = open(dbPath);
    db.prepare("insert into session (id) values (?)").run(S);
    db.prepare("insert into session (id, parent_id) values (?, ?)").run(CHILD, S);
    const insMsg = db.prepare(
      "insert into message (id, session_id, time_created, time_updated, data, sequence) values (?, ?, 0, 0, ?, ?)",
    );
    const insPart = db.prepare(
      "insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) values (?, ?, ?, 0, 0, ?, ?)",
    );
    // S 全量 seq1..8；seq4=活跃边界（preserved 3..4）；1..2=被 F-trim 的边界前段
    for (let i = 1; i <= 8; i += 1) {
      insMsg.run(`msg_s_${i}`, S, JSON.stringify({ i }), i);
      insPart.run(`part_s_${i}`, S, `msg_s_${i}`, JSON.stringify({ p: i }), 0);
    }
    insPart.run(
      "part_s_boundary",
      S,
      "msg_s_4",
      JSON.stringify({ type: "compaction", compactBoundary: { preservedSegment: { headMessageId: "msg_s_3", tailMessageId: "msg_s_4" } } }),
      0,
    );
    // child（forkAssistant 复制 F 后已 trim）：内容 3..8，child-local id，序 1..6
    const childBoundary = JSON.stringify({ type: "compaction", compactBoundary: { preservedSegment: { headMessageId: "msg_c_3", tailMessageId: "msg_c_4" } } });
    for (let i = 3; i <= 8; i += 1) {
      insMsg.run(`msg_c_${i}`, CHILD, JSON.stringify({ i }), i - 2);
      if (i === 4) insPart.run("part_c_b", CHILD, "msg_c_4", childBoundary, 0);
      else insPart.run(`part_c_${i}`, CHILD, `msg_c_${i}`, JSON.stringify({ p: i }), 0);
    }

    // 登记（采集边界/游标/总量）
    const collected = collectForkFullHistoryParams(S, CHILD);
    assert.equal(collected.ok, true, `采集失败: ${collected.error}`);
    const task = registerForkFullHistoryTask({ childSessionId: CHILD, originalSessionId: S, ...collected.params! });
    assert.equal(task.boundaryTotal, 2, "边界前非 preserved 应为 2 条（seq1..2）");
    assert.equal(task.nextLowerSeq, 0, "child 尾序 1 → 注入上界 0");

    // 分段推进（段内注入 2 条一次完成；0=完成）
    const inserted = advanceForkFullHistorySegment(task, db as unknown as EnrichDb);
    assert.equal(inserted, 2);
    assert.equal(task.status, "done");
    assert.equal(advanceForkFullHistorySegment(task, db as unknown as EnrichDb), 0, "done 后再推进=0");

    // child 最终序 = S 全量序 1..8；注入段 zgk 新 id；preserved/边界后段 id 不变
    const rows = db
      .prepare("select id, sequence, data from message where session_id = ? order by sequence")
      .all(CHILD) as unknown as Array<{ id: string; sequence: number; data: string }>;
    assert.deepEqual(rows.map((r) => JSON.parse(r.data).i), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(rows[0].id.startsWith("msg_zgk_"));
    assert.ok(rows[1].id.startsWith("msg_zgk_"));
    assert.deepEqual(rows.slice(2).map((r) => r.id), ["msg_c_3", "msg_c_4", "msg_c_5", "msg_c_6", "msg_c_7", "msg_c_8"]);
    // part 随注入（8 条：6 原有 + 2 注入）
    const partCount = db.prepare("select count(*) c from part where session_id = ?").get(CHILD) as unknown as { c: number };
    assert.equal(partCount.c, 8);

    // waitFor 判定（async）
    assert.equal(await waitForForkFullHistoryDone(CHILD, db as unknown as EnrichDb), "done");
    assert.equal(await waitForForkFullHistoryDone("sess_absent", db as unknown as EnrichDb), "absent");
    db.close();
  } finally {
    delete process.env.ZCODE_DATA_BASE_DIR;
    delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S 无压缩边界：collect 报 no-boundary（不建任务，child 内容已全）", () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-forkfull-nob-"));
  process.env.ZCODE_DATA_BASE_DIR = dir;
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = join(dir, "zcode-go");
  const dbPath = createDb(dir);
  const S = "sess_s2";
  const CHILD = "sess_c2";
  try {
    const db = open(dbPath);
    db.prepare("insert into session (id) values (?)").run(S);
    db.prepare("insert into session (id, parent_id) values (?, ?)").run(CHILD, S);
    const insMsg = db.prepare(
      "insert into message (id, session_id, time_created, time_updated, data, sequence) values (?, ?, 0, 0, ?, ?)",
    );
    for (let i = 1; i <= 3; i += 1) insMsg.run(`msg_s_${i}`, S, "{}", i);
    for (let i = 1; i <= 3; i += 1) insMsg.run(`msg_c_${i}`, CHILD, "{}", i);
    db.close();
    const collected = collectForkFullHistoryParams(S, CHILD);
    assert.equal(collected.ok, false);
    assert.equal(collected.error, "no compaction boundary in original session");
    assert.equal(getForkFullHistoryTask(CHILD), null);
  } finally {
    delete process.env.ZCODE_DATA_BASE_DIR;
    delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});
