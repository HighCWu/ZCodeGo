import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { openSessionHistoryLazyReader } from "../src/zcode-session/sessionHistoryLazyReader.js";
import {
  SYNTHETIC_TAIL_MESSAGES,
  projectHistoryRows,
  synthesizeConversationSnapshot,
} from "../src/zcode-session/zcodeGoHistorySynthesis.js";
import {
  attachRealSubscription,
  beginSyntheticHistorySubscription,
  endSyntheticSubscription,
  resetSyntheticHistoryForTest,
  rewriteSyntheticFrame,
  syntheticRowsRange,
} from "../src/zcode-session/zcodeGoSyntheticHistory.js";

/**
 * zcode-go 懒读取完整链契约：part→行投影、合成快照 schema 合法性、
 * 回填分页、订阅接管（放行门槛/真实订阅号重写/退订生命周期）。
 */

interface SeedMsg {
  id: string;
  sequence: number;
  time: number;
  role: "user" | "assistant";
  parts: string[];
}

function seed(db: DatabaseSync, sessionId: string, msgs: SeedMsg[]): void {
  db.prepare("insert into session (id) values (?)").run(sessionId);
  const insM = db.prepare(
    "insert into message (id, session_id, time_created, time_updated, data, sequence) values (?,?,?,?,?,?)",
  );
  const insP = db.prepare(
    "insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) values (?,?,?,?,?,?,?)",
  );
  for (const m of msgs) {
    insM.run(m.id, sessionId, m.time, m.time, JSON.stringify({ role: m.role }), m.sequence);
    m.parts.forEach((data, i) => {
      insP.run(`p_${m.id}_${i}`, sessionId, m.id, m.time + i, m.time + i, data, i);
    });
  }
}

function createDb(dir: string): string {
  const dbPath = join(dir, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table session (id text primary key);
    create table message (
      id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text, sequence integer);
    create table part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer, time_updated integer, data text, sequence integer);
    create index message_session_time_idx on message(session_id, time_created, id);
    create index part_message_idx on part(message_id, id);
  `);
  db.close();
  return dbPath;
}

/** 巨会话样本：user text / assistant text / reasoning / tool×2 / compaction。 */
function giantMessages(count: number): SeedMsg[] {
  const msgs: SeedMsg[] = [];
  for (let i = 1; i <= count; i += 1) {
    if (i % 2 === 1) {
      msgs.push({
        id: `mu${i}`,
        sequence: i,
        time: 1000 + i,
        role: "user",
        parts: [JSON.stringify({ type: "text", text: `用户消息 ${i}` })],
      });
    } else {
      msgs.push({
        id: `ma${i}`,
        sequence: i,
        time: 1000 + i,
        role: "assistant",
        parts: [
          JSON.stringify({ type: "reasoning", text: `思考 ${i}` }),
          JSON.stringify({ type: "text", text: `回复 ${i}` }),
          JSON.stringify({
            type: "tool",
            callID: `c${i}`,
            tool: "Bash",
            state: { status: i % 6 === 0 ? "failed" : "completed", input: { command: "ls" } },
          }),
          ...(i % 10 === 0 ? [JSON.stringify({ type: "compaction", compactBoundary: {} })] : []),
          JSON.stringify({ type: "step-start" }),
        ],
      });
    }
  }
  return msgs;
}

function withEnv<T>(dbDir: string, fn: () => T | Promise<T>): T | Promise<T> {
  const prevBase = process.env.ZCODE_DATA_BASE_DIR;
  const prevState = process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
  process.env.ZCODE_DATA_BASE_DIR = dbDir;
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = dbDir;
  resetSyntheticHistoryForTest();
  try {
    return fn();
  } finally {
    resetSyntheticHistoryForTest();
    if (prevBase === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
    else process.env.ZCODE_DATA_BASE_DIR = prevBase;
    if (prevState === undefined) delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    else process.env.ZCODE_GO_STATE_DIR_OVERRIDE = prevState;
  }
}

test("行投影：类型/角色映射、rowId 单调、step 不投影、tool 失败映射 error", () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-synth-"));
  const dbPath = createDb(dir);
  const db = new DatabaseSync(dbPath);
  seed(db, "sess_synth", giantMessages(6));
  db.close();
  const reader = openSessionHistoryLazyReader(dbPath);
  const window = reader.readTailWindow("sess_synth", 60);
  const rows = projectHistoryRows(window);
  reader.close();

  const kinds = rows.map((r) => r.kind);
  assert.ok(kinds.includes("userInput"), "user text → userInput");
  assert.ok(kinds.includes("assistantText"), "assistant text → assistantText");
  assert.ok(kinds.includes("reasoning"), "reasoning → reasoning");
  const toolRows = rows.filter((r) => r.kind === "toolCall");
  assert.equal(toolRows.length, 3, "3 个 tool part → 3 行");
  assert.ok(!kinds.includes("turnHeader") && !rows.some((r) => r.kind === "subagent"), "未支持类型不投影");
  const failed = toolRows.find((r) => r.status === "error");
  assert.ok(failed, "i%6==0 的 tool 映射 error");
  const ok2 = toolRows.find((r) => r.status === "success");
  assert.ok(ok2, "completed → success");
  // rowId 单调
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i]!.rowId > rows[i - 1]!.rowId, "rowId 升序");
  }
  // step-start 不投影（每条 assistant 都带）
  assert.ok(rows.length < 6 /* msgs */ * 4 /* parts */, "step part 已被跳过");
});

test("合成快照：schema parse 通过 + 尾窗口正确 + firstRowId 支持翻页判定", () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-synth2-"));
  const dbPath = createDb(dir);
  const db = new DatabaseSync(dbPath);
  seed(db, "sess_synth2", giantMessages(100));
  db.close();
  const reader = openSessionHistoryLazyReader(dbPath);
  const window = reader.readTailWindow("sess_synth2", SYNTHETIC_TAIL_MESSAGES);
  const snapshot = synthesizeConversationSnapshot("sess_synth2", window, "");
  reader.close();

  const parsed = conversationSnapshotSchema.safeParse(snapshot);
  assert.ok(parsed.success, `快照应 schema 合法：${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  assert.ok(snapshot.rows.window.length > 0, "尾窗有行");
  assert.equal(snapshot.rows.firstRowId, 1000, "firstRowId=全序首行（翻页判定用）");
  assert.ok(snapshot.logEpoch === "zcode-go-synthetic", "合成 epoch 标识");
});

test("订阅接管全链：放行门槛 + 后台订阅号重写 + 回填 + 退订", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-synth3-"));
  // 模块读 <dataRoot>/.zcode/cli/db/db.sqlite（ZCODE_DATA_BASE_DIR=dataRoot）
  mkdirSync(join(dir, ".zcode", "cli", "db"), { recursive: true });
  const dbPath = createDb(join(dir, ".zcode", "cli", "db"));
  const db = new DatabaseSync(dbPath);
  seed(db, "sess_takeover", giantMessages(200));
  db.close();
  // 配置 minMessages=100
  writeFileSync(join(dir, "config.json"), JSON.stringify({ lazyHistory: { minMessages: 100 } }));

  await withEnv(dir, async () => {
    // 门槛：远程 identity 不放行
    assert.equal(
      beginSyntheticHistorySubscription({
        sessionId: "sess_takeover",
        workspacePath: "/w",
        workspaceIdentity: "remote-x",
      }),
      null,
      "远程会话不放行",
    );
    // 小会话（<100）不放行
    assert.equal(
      beginSyntheticHistorySubscription({ sessionId: "sess_missing", workspacePath: "/w" }),
      null,
      "小会话不放行",
    );
    // 正常接管
    const begun = beginSyntheticHistorySubscription({ sessionId: "sess_takeover", workspacePath: "/w" });
    assert.ok(begun, "巨会话接管成立");
    const synthId = begun.subscriptionId;

    // 后台真实订阅完成 → 重写登记
    attachRealSubscription(synthId, "real-sub-1", async () => ({}));
    const frame = {
      wireVersion: 3,
      kind: "complete",
      topic: "conversation/sess_takeover",
      subscriptionId: "real-sub-1",
      frame: { topic: "conversation/sess_takeover", subscriptionId: "real-sub-1", payload: {} },
    };
    const rewritten = rewriteSyntheticFrame(frame as never) as typeof frame;
    assert.equal(rewritten.subscriptionId, synthId, "外层订阅号重写");
    assert.equal(
      (rewritten.frame as { subscriptionId: string }).subscriptionId,
      synthId,
      "内层订阅号重写",
    );
    // 非匹配订阅号不动
    const other = rewriteSyntheticFrame({
      topic: "conversation/sess_takeover",
      subscriptionId: "real-sub-OTHER",
    } as never) as { subscriptionId: string };
    assert.equal(other.subscriptionId, "real-sub-OTHER", "非匹配不动");
    // live 记录后再次订阅不再接管
    assert.equal(
      beginSyntheticHistorySubscription({ sessionId: "sess_takeover", workspacePath: "/w" }),
      null,
      "live 后不再合成",
    );

    // 回填：中页（limit 50，sequence<150）→ hasMore=true
    const mid = syntheticRowsRange({ sessionId: "sess_takeover", beforeRowId: 150 * 1000, limit: 50 });
    assert.ok(mid, "回填直答");
    assert.ok(mid.rows.length > 0, "回填有行");
    assert.ok(mid.hasMore, "中页还有更早历史");
    const firstMid = mid.rows[0] as { rowId: number };
    assert.ok(firstMid.rowId < 150 * 1000, "页内行都早于游标");
    // 全量页（不 limit）翻到 sequence 1 → hasMore=false
    const full = syntheticRowsRange({ sessionId: "sess_takeover", beforeRowId: 150 * 1000 });
    assert.ok(full && full.rows.length > 0, "全量页有行");
    assert.equal(full!.hasMore, false, "翻到顶后 hasMore=false");

    // 退订：清映射
    endSyntheticSubscription(synthId, async () => ({}));
    assert.equal(syntheticRowsRange({ sessionId: "sess_takeover" }), null, "退订后回填回落正常路径");
    const after = rewriteSyntheticFrame({
      topic: "conversation/sess_takeover",
      subscriptionId: "real-sub-1",
    } as never) as { subscriptionId: string };
    assert.equal(after.subscriptionId, "real-sub-1", "退订后不再重写");
  });
  rmSync(dir, { recursive: true, force: true });
  void dbPath;
});
