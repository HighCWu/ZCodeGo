#!/usr/bin/env node
/**
 * zcode-go 静默 fork 第一批：direct fork silent 契约（fixture 从真实会话库拷贝行，
 * 数据形状与官方 hydrator 完全一致）。
 *
 * 契约：
 * - silent=true：不写任务索引（tasks db 可以不存在），子会话只含
 *   「边界摘要 + preservedSegment + 边界后」；
 * - id 全量重映射（子会话消息 id 与父会话零交集）；
 * - parent_id 安全体：子会话 session 行 parent_id = 父会话。
 * 运行：node --test packages/services/test/zcodeGoDirectForkSilent.test.mjs
 * （需真实 ~/.zcode/cli/db 可读；只读拷贝，不写真实库）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { forkCompactSessionDirect } from "../../desktop/src/main/zcodeGoDirectFork.ts";

const REAL_DB = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), "zg-silent-fork-"));
  const fixturePath = join(dir, "session.db");
  const real = new DatabaseSync(REAL_DB, { readOnly: true });
  const fx = new DatabaseSync(fixturePath);
  fx.exec("attach database ? as src", [REAL_DB]); // node:sqlite exec 无参绑——改用逐表拷贝
  fx.exec("detach database src");
  // 建 schema：从真实库取建表语句
  for (const table of ["session", "message", "part", "session_entry"]) {
    const sql = real
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table).sql;
    fx.exec(sql);
  }
  // 选一个小型真实会话做模板（消息数最少且 >4）
  const template = real
    .prepare(
      "SELECT m.session_id AS sid, count(*) AS c FROM message m GROUP BY m.session_id HAVING c >= 6 ORDER BY c ASC LIMIT 1",
    )
    .get();
  assert.ok(template, "真实库中需存在 ≥6 消息的会话");
  const sid = template.sid;
  // 拷贝 session 行（换 id）
  const S = "sess_zge2e_silentfork0";
  fx.exec("begin");
  const sessionRow = real.prepare("SELECT * FROM session WHERE id = ?").get(sid);
  const sessionCols = Object.keys(sessionRow).filter((c) => c !== "id");
  fx.prepare(
    `INSERT INTO session (id, ${sessionCols.join(", ")}) VALUES (?, ${sessionCols.map(() => "?").join(", ")})`,
  ).run(S, ...sessionCols.map((c) => sessionRow[c]));
  // 拷贝 message（换 id 保序）+ part
  const messages = real
    .prepare("SELECT * FROM message WHERE session_id = ? ORDER BY sequence")
    .all(sid);
  const idMap = new Map();
  messages.forEach((m, i) => {
    const newId = `msg_sf_${i}_${m.id.slice(-6)}`;
    idMap.set(m.id, newId);
    const cols = Object.keys(m).filter((c) => c !== "id" && c !== "session_id");
    fx.prepare(
      `INSERT INTO message (id, session_id, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})`,
    ).run(newId, S, ...cols.map((c) => m[c]));
  });
  for (const m of messages) {
    const parts = real.prepare("SELECT * FROM part WHERE message_id = ?").all(m.id);
    for (let j = 0; j < parts.length; j += 1) {
      const p = parts[j];
      const cols = Object.keys(p).filter(
        (c) => c !== "id" && c !== "session_id" && c !== "message_id",
      );
      fx.prepare(
        `INSERT INTO part (id, session_id, message_id, ${cols.join(", ")}) VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")})`,
      ).run(`part_sf_${j}_${p.id.slice(-8)}`, S, idMap.get(m.id), ...cols.map((c) => p[c]));
    }
  }
  // session_entry：runtime/model_selection 与 execution_state（fork 需复制）
  const entries = real
    .prepare("SELECT * FROM session_entry WHERE session_id = ?")
    .all(sid);
  for (let k = 0; k < entries.length; k += 1) {
    const e = entries[k];
    const cols = Object.keys(e).filter((c) => c !== "id" && c !== "session_id");
    fx.prepare(
      `INSERT INTO session_entry (id, session_id, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})`,
    ).run(`entry_sf_${k}`, S, ...cols.map((c) => e[c]));
  }
  fx.exec("commit");
  // 在第 3 条消息上注入活跃压缩边界（与 CLI isActiveCompactionBoundaryPart 同判据）
  const boundaryMessage = messages[2];
  const boundaryPayload = {
    type: "compaction",
    compactBoundary: {
      preservedSegment: {
        headMessageId: idMap.get(messages[1].id),
        tailMessageId: idMap.get(messages[3].id),
      },
    },
    summaryMessageId: idMap.get(messages[2].id),
  };
  fx.prepare(
    "INSERT INTO part (id, session_id, message_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, 0, 0, ?, 0)",
  ).run("part_sf_boundary", S, idMap.get(boundaryMessage.id), JSON.stringify(boundaryPayload));
  real.close();
  fx.close();
  return { dir, fixturePath, S, totalMessages: messages.length, idMap };
}

test("silent fork：只保留边界起内容 + id 重映射 + 不写任务索引", () => {
  if (!existsSync(REAL_DB)) {
    console.log("跳过：真实会话库不可用（CI 环境）");
    return;
  }
  const { dir, fixturePath, S, totalMessages, idMap } = buildFixture();
  try {
    // tasks 库不存在——silent 模式必须不碰它
    const tasksPath = join(dir, "tasks-index.sqlite");
    const result = forkCompactSessionDirect({
      parentSessionId: S,
      silent: true,
      sessionDbPath: fixturePath,
      tasksIndexDbPath: tasksPath,
    });
    assert.equal(result.ok, true, result.error ?? "fork 应成功");
    assert.equal(existsSync(tasksPath), false, "silent 模式不得创建/写任务索引");

    const fx = new DatabaseSync(fixturePath, { readOnly: true });
    const childMessages = fx
      .prepare("SELECT id FROM message WHERE session_id = ? ORDER BY sequence")
      .all(result.childSessionId)
      .map((r) => r.id);
    // 保留 = 边界消息(m2) + preserved(m1,m3) + 边界后(m4..) = total-1（仅剔除 m0）
    assert.equal(childMessages.length, totalMessages - 1);
    // id 重映射：与父会话零交集
    const parentIds = new Set([...idMap.values()]);
    for (const id of childMessages) assert.equal(parentIds.has(id), false);
    // parent_id 安全体
    const childSession = fx.prepare("SELECT parent_id FROM session WHERE id = ?").get(
      result.childSessionId,
    );
    assert.equal(childSession.parent_id, S);
    fx.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非 silent：任务库缺失时报错而非崩溃", () => {
  if (!existsSync(REAL_DB)) return;
  const { dir, fixturePath, S } = buildFixture();
  try {
    const result = forkCompactSessionDirect({
      parentSessionId: S,
      sessionDbPath: fixturePath,
      tasksIndexDbPath: join(dir, "missing.sqlite"),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /tasks index db not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
