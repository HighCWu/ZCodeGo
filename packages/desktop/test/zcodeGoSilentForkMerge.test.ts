import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkCompactSessionDirect } from "../src/main/zcodeGoDirectFork.js";
import {
  runZcodeGoSilentForkMergePass,
  stopZcodeGoSilentForkMergeWorkerForTest,
  syncZcodeGoSilentForkEntry,
} from "../src/main/zcodeGoSilentForkMerge.js";
import {
  resetZcodeGoSessionRedirectCacheForTest,
  setZcodeGoSessionRedirect,
} from "../../services/src/zcode-agent/zcodeGoSessionRedirect.js";

/**
 * zcode-go 静默 fork 第三批：双向归并契约。
 *
 * 1. 迟到注入：fork 快照后落进 S 的行 → 原样 id 注入 S' 尾部（part 粒度补齐）；
 * 2. 增量归并：S' 新活行（非 msg_zgk_ 前缀）→ 复制回 S，sequence 续排，幂等；
 * 3. 回流去重：注入行（原样 id）随后归并方向天然跳过（id 已在 S）；
 * 4. rewind 兜底：S' 删行后 rowid 回退复用的新行由全量扫描捕获。
 */

interface SeedMessage {
  id: string;
  timeCreated: number;
  data?: string;
  parts?: Array<{ id: string; data?: string; late?: boolean }>;
}

function seedMessage(db: DatabaseSync, sessionId: string, message: SeedMessage): void {
  db.prepare(
    "insert into message (id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?)",
  ).run(
    message.id,
    sessionId,
    message.timeCreated,
    message.timeCreated,
    message.data ?? "{}",
    null,
  );
  // 测试库 sequence 由重新排序查询兜底：插入时先空，最后统一编号
  for (const part of message.parts ?? []) {
    db.prepare(
      "insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, 0, ?, ?)",
    ).run(part.id, sessionId, message.id, message.timeCreated, part.data ?? "{}", null);
  }
}

function renumber(db: DatabaseSync, sessionId: string): void {
  db.exec(
    `create temp table if not exists renum(id text primary key, seq integer);
     delete from renum;
     insert into renum select id, row_number() over (order by time_created, rowid) from message where session_id = '${sessionId}';
     update message set sequence = (select seq from renum where renum.id = message.id) where session_id = '${sessionId}';
     drop table renum;`,
  );
}

function createTestDb(dir: string): string {
  const dbPath = join(dir, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table session (
      id text primary key, project_id text, workspace_id text, parent_id text,
      slug text, directory text, path text, title text, version text,
      permission text, time_created integer, time_updated integer,
      task_type text, title_source text
    );
    create table message (
      id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text not null, sequence integer
    );
    create table part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null,
      sequence integer
    );
    create table session_entry (
      id text primary key, session_id text not null, type text not null,
      time_created integer not null, time_updated integer not null, data text not null
    );
    create index message_session_time_idx on message(session_id, time_created);
    create index part_message_idx on part(message_id);
  `);
  db.prepare("insert into session (id, directory, time_created, time_updated) values (?, ?, ?, ?)").run(
    "sess_merge_S",
    "/tmp/ws",
    1000,
    1000,
  );
  db.close();
  return dbPath;
}

test("迟到注入 + 增量归并 + 回流去重 + rewind 兜底 全链", () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-sf-merge-"));
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = dir;
  resetZcodeGoSessionRedirectCacheForTest();
  stopZcodeGoSilentForkMergeWorkerForTest();
  try {
    const dbPath = createTestDb(dir);
    const db = new DatabaseSync(dbPath);

    // ── 种子：S 带 8 条消息（含一个 compaction 边界在中间）──
    const messages: SeedMessage[] = Array.from({ length: 8 }, (_, i) => ({
      id: `msg_seed_${i}`,
      timeCreated: 2000 + i * 10,
      parts: [{ id: `part_seed_${i}` }],
    }));
    // 第 4 条消息挂活跃压缩边界 part
    messages[4].parts = [
      { id: "part_seed_4" },
      {
        id: "part_boundary_4",
        data: JSON.stringify({
          type: "compaction",
          compactBoundary: { preservedSegment: { headMessageId: "msg_seed_2", tailMessageId: "msg_seed_3" } },
        }),
      },
    ];
    for (const message of messages) seedMessage(db, "sess_merge_S", message);
    renumber(db, "sess_merge_S");

    // ── fork（silent）──
    const fork = forkCompactSessionDirect({
      parentSessionId: "sess_merge_S",
      silent: true,
      sessionDbPath: dbPath,
      log: () => {},
    });
    assert.ok(fork.ok, `fork 应成功：${fork.error ?? ""}`);
    const F = fork.childSessionId!;
    // 保留集 = 边界（含 preservedSegment 2-3）+ 边界后 4-7 → 2,3,4,5,6,7 共 6 条
    assert.equal(fork.copiedMessages, 6, "保留集为 preservedSegment + 边界后");
    assert.ok(
      typeof fork.parentMaxMessageRowid === "number" && typeof fork.childMaxMessageRowid === "number",
      "水位线已返回",
    );

    setZcodeGoSessionRedirect("sess_merge_S", {
      forkSessionId: F,
      createdAt: Date.now(),
      createdBy: "auto-compaction",
      parentMaxMessageRowid: fork.parentMaxMessageRowid,
      childMaxMessageRowid: fork.childMaxMessageRowid,
    });

    // ── 场景 1：迟到写入落进 S（bg 输出；先消息后 part 分两步）──
    seedMessage(db, "sess_merge_S", {
      id: "msg_late_bg",
      timeCreated: 9000,
      parts: [{ id: "part_late_bg_1", data: JSON.stringify({ type: "shellOutput" }) }],
    });
    renumber(db, "sess_merge_S");

    const pass1 = runZcodeGoSilentForkMergePass({ sessionDbPath: dbPath, log: () => {} });
    assert.equal(pass1.injectedMessages, 1, "迟到消息注入 S'");
    const injected = db
      .prepare("select sequence from message where id = ? and session_id = ?")
      .get("msg_zgk_inj_msg_late_bg", F) as { sequence: number } | undefined;
    assert.ok(injected, "注入行在 S'（确定性派生 id）");
    assert.equal(injected!.sequence, 7, "注入行排 S' 序列尾部（6 条后 +1）");

    // part 粒度补齐：bg 流后续追加 part
    db.prepare(
      "insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, 0, ?, ?)",
    ).run("part_late_bg_2", "sess_merge_S", "msg_late_bg", 9500, JSON.stringify({ type: "shellOutput" }), 1);
    const pass2 = runZcodeGoSilentForkMergePass({ sessionDbPath: dbPath, log: () => {} });
    assert.equal(pass2.injectedMessages, 0, "消息已在，不重复注入");
    const partCount = (
      db.prepare("select count(*) c from part where session_id = ? and message_id = ?").get(F, "msg_zgk_inj_msg_late_bg") as {
        c: number;
      }
    ).c;
    assert.equal(partCount, 2, "后到 part 已补齐");

    // ── 场景 2：S' 活会话新行（模拟 agent 写入，非 msg_zgk_ 前缀 id）──
    seedMessage(db, F, {
      id: "msg_live_user",
      timeCreated: 10000,
      data: JSON.stringify({ role: "user", parentID: "msg_zgk_nonexistent" }),
      parts: [{ id: "part_live_user_1", data: JSON.stringify({ type: "text" }) }],
    });
    renumber(db, F);
    const pass3 = runZcodeGoSilentForkMergePass({ sessionDbPath: dbPath, log: () => {} });
    assert.equal(pass3.mergedMessages, 1, "S' 新活行归并回 S");
    const merged = db
      .prepare("select sequence, data from message where id = ? and session_id = ?")
      .get("msg_zgk_mb_msg_live_user", "sess_merge_S") as { sequence: number; data: string } | undefined;
    assert.ok(merged, "归并行在 S");
    assert.equal(merged!.sequence, 10, "归并行排 S 序列尾部（9 行后续排）");
    assert.ok(!JSON.parse(merged!.data).parentID, "悬空 parentID 已置空");

    // 注入行回流：msg_zgk_inj_ 前缀被归并方向排除（内容本就来自 S）→ 无重复
    const sCount = (
      db.prepare("select count(*) c from message where session_id = ? and id = ?").get("sess_merge_S", "msg_late_bg") as {
        c: number;
      }
    ).c;
    assert.equal(sCount, 1, "注入行不回流（前缀排除）");

    // ── 幂等：重跑无变化 ──
    const pass4 = runZcodeGoSilentForkMergePass({ sessionDbPath: dbPath, log: () => {} });
    assert.equal(pass4.injectedMessages + pass4.mergedMessages, 0, "幂等重跑零变化");

    // ── 场景 3：rewind —— S' 删除活行后新行复用低 rowid，全量扫描兜底捕获 ──
    db.prepare("delete from part where session_id = ? and message_id = ?").run(F, "msg_live_user");
    db.prepare("delete from message where session_id = ? and id = ?").run(F, "msg_live_user");
    seedMessage(db, F, {
      id: "msg_live_after_rewind",
      timeCreated: 11000,
      parts: [{ id: "part_rewind_1" }],
    });
    renumber(db, F);
    // 常规 pass（rowid 提示之后无新行 → 0）；全量 pass 捕获
    const regular = syncZcodeGoSilentForkEntry({
      sessionDb: db as never,
      originalSessionId: "sess_merge_S",
      entry: {
        forkSessionId: F,
        createdAt: Date.now(),
        createdBy: "auto-compaction",
        parentMaxMessageRowid: fork.parentMaxMessageRowid,
        childMaxMessageRowid: fork.childMaxMessageRowid,
      },
      mergeRowidHint: 999999,
      fullScan: false,
      log: () => {},
    });
    assert.equal(regular.mergedMessages, 0, "rowid 提示之后无新行");
    const full = syncZcodeGoSilentForkEntry({
      sessionDb: db as never,
      originalSessionId: "sess_merge_S",
      entry: {
        forkSessionId: F,
        createdAt: Date.now(),
        createdBy: "auto-compaction",
        parentMaxMessageRowid: fork.parentMaxMessageRowid,
        childMaxMessageRowid: fork.childMaxMessageRowid,
      },
      mergeRowidHint: 999999,
      fullScan: true,
      log: () => {},
    });
    assert.equal(full.mergedMessages, 1, "全量扫描捕获 rewind 复用行");
    const rewindRow = db
      .prepare("select 1 from message where session_id = ? and id = ?")
      .get("sess_merge_S", "msg_zgk_mb_msg_live_after_rewind");
    assert.ok(rewindRow, "rewind 后新行已归并回 S");
    // rewind 删除的旧行仍在 S（档案不丢）
    const kept = db
      .prepare("select 1 from message where session_id = ? and id = ?")
      .get("sess_merge_S", "msg_zgk_mb_msg_live_user");
    assert.ok(kept, "rewind 删除前的行在 S 档案保留");

    db.close();
  } finally {
    delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    resetZcodeGoSessionRedirectCacheForTest();
    stopZcodeGoSilentForkMergeWorkerForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});
