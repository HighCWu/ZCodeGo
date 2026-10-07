import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionHistoryLazyReader } from "../src/zcode-session/sessionHistoryLazyReader.js";

/**
 * zcode-go：会话历史懒读取契约（数据库倒序按需加载的基础原语）。
 *
 * 场景对齐巨会话实测：144K part / 214MB 的会话冷恢复 30s+；本读取器经
 * message(session_id, time_created) 索引倒序 + part(message_id) 索引取件，
 * 尾窗/回填均在毫秒级（索引策略见模块头注——禁止裸 part 排序，实测 4.6s）。
 * 运行：npx tsx --test packages/services/test/sessionHistoryLazyReader.test.ts
 */

interface SeedMessage {
  id: string;
  sequence: number | null;
  timeCreated: number;
  parts: number;
}

function seedSession(db: DatabaseSync, sessionId: string, messages: SeedMessage[]): void {
  db.prepare("INSERT INTO session (id) VALUES (?)").run(sessionId);
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, '{}', ?)",
  );
  const insertPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, 0, ?, ?)",
  );
  for (const message of messages) {
    insertMessage.run(message.id, sessionId, message.timeCreated, message.timeCreated, message.sequence);
    for (let i = 0; i < message.parts; i += 1) {
      insertPart.run(
        `${message.id}-p${i}`,
        message.id,
        sessionId,
        message.timeCreated,
        JSON.stringify({ role: "assistant", idx: i, of: message.id }),
        message.sequence,
      );
    }
  }
}

function createTestDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zg-lazy-reader-"));
  const dbPath = join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id text primary key);
    CREATE TABLE message (
      id text primary key,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );
    CREATE TABLE part (
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      sequence integer
    );
    CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
    CREATE INDEX part_message_id_id_idx ON part(message_id, id);
  `);
  // 20 条消息（每条 3 part），sequence 与时间同向单调
  const messages: SeedMessage[] = Array.from({ length: 20 }, (_, i) => ({
    id: `m${String(i).padStart(2, "0")}`,
    sequence: i + 1,
    timeCreated: 1000 + i * 10,
    parts: 3,
  }));
  seedSession(db, "sess-lazy", messages);
  // 空 sequence 的历史遗留会话
  seedSession(
    db,
    "sess-legacy",
    Array.from({ length: 5 }, (_, i) => ({
      id: `legacy${i}`,
      sequence: null,
      timeCreated: 500 + i * 10,
      parts: 1,
    })),
  );
  db.close();
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("尾窗：最近 N 条消息的全部 part，历史顺序升序", () => {
  const { dbPath, cleanup } = createTestDb();
  try {
    const reader = openSessionHistoryLazyReader(dbPath);
    const window = reader.readTailWindow("sess-lazy", 4);
    // 种子为 m00..m19（sequence 1..20）；最近 4 条 = m16..m19，各 3 part 升序
    assert.equal(window.parts.length, 12);
    assert.deepEqual(
      window.parts.map((p) => p.messageId),
      ["m16", "m16", "m16", "m17", "m17", "m17", "m18", "m18", "m18", "m19", "m19", "m19"],
    );
    assert.equal(window.oldestMessageSequence, 17);
    assert.equal(window.totalMessages, 20);
    reader.close();
  } finally {
    cleanup();
  }
});

test("回填：message 序游标向更早翻页，仍升序返回", () => {
  const { dbPath, cleanup } = createTestDb();
  try {
    const reader = openSessionHistoryLazyReader(dbPath);
    const page = reader.readPageBefore("sess-lazy", 18, 4);
    // sequence<m18 即 seq≤17；最近 4 条 = m13..m16（m17 的 sequence 是 18）
    assert.deepEqual(
      page.parts.map((p) => p.messageId).filter((m, i, a) => i % 3 === 0),
      ["m13", "m14", "m15", "m16"],
    );
    assert.equal(page.oldestMessageSequence, 14);
    // 翻到头：sequence < 2 只剩 m00（sequence=1）
    const first = reader.readPageBefore("sess-lazy", 2, 4);
    assert.deepEqual(
      first.parts.map((p) => p.messageId),
      ["m00", "m00", "m00"],
    );
    assert.equal(first.oldestMessageSequence, 1);
    reader.close();
  } finally {
    cleanup();
  }
});

test("legacy（sequence 为空）会话回退 time_created 语义；空会话返回空窗", () => {
  const { dbPath, cleanup } = createTestDb();
  try {
    const reader = openSessionHistoryLazyReader(dbPath);
    const window = reader.readTailWindow("sess-legacy", 2);
    assert.deepEqual(
      window.parts.map((p) => p.messageId),
      ["legacy3", "legacy4"],
    );
    assert.equal(window.oldestMessageSequence, null);
    assert.equal(window.totalMessages, 5);
    const empty = reader.readTailWindow("sess-none", 10);
    assert.deepEqual(empty, { parts: [], oldestMessageSequence: null, totalMessages: 0 });
    reader.close();
  } finally {
    cleanup();
  }
});
