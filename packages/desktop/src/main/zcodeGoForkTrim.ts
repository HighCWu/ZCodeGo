/**
 * zcode-go「分叉压缩历史会话」的子会话裁剪（fork-then-trim）。
 *
 * 官方 forkAssistant 把父会话全部 message+part 逐字复制进子会话（含全部压缩边界，
 * id 已由官方完整重映射为子会话本地——db 实证），子会话因此物理携带全部历史。官方
 * 协议面没有任何删消息入口（removeMessage 仅导入清理/停轮回滚/压缩回滚三个内部调
 * 用方），无法从 host 走协议裁剪；而「分叉压缩历史」的产品语义要求子会话不含压缩
 * 前内容。故 fork ack 之后由桌面主进程对子会话存储做一次外科手术：
 *
 *   删除 = 最后一个活跃压缩边界之前的全部消息（含 part 行）
 *   保留 = 边界摘要消息本身 + compactBoundary.preservedSegment 区间（它们是模型
 *          上下文的组成部分，hydrator 会重插） + 边界后全部消息
 *   另删 = session_target 行 + target_completion_verification 验证历史条目
 *          （官方 fork 会复制父会话目标与全部迭代验证史，db 实证 1,397 条，UI 渲染
 *            为一长串「第 N 次迭代 · 目标未完成」——分叉是全新续接会话，不继承）
 *
 * 裁剪只动惰性数据，不动模型可见前缀 → 送模型的内容与父会话逐字节一致，前缀缓
 * 存不受影响。子会话订阅发生在裁剪之后，CLI 从存储看到的就是裁剪后的形态。
 *
 * 安全体：① 仅当子会话 parent_id 与分叉父会话一致才动手；② begin immediate 事务
 * + busy timeout 与运行中的官方 CLI 共存；③ 任何异常即放弃（子会话保持官方全量形
 * 态，功能不受影响）；④ 无压缩边界的子会话只清 goal 不动消息。
 *
 * 库路径与官方 getDefaultSessionDbPath 同源：~/.zcode/cli/db/db.sqlite（node:sqlite）。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 不能静态 import "node:sqlite"：tsup 会把 node: 前缀剥成裸包名（产物实测
// `from "sqlite"`），主进程启动即 ERR_MODULE_NOT_FOUND。getBuiltinModule 是
// 运行时同步取内建模块，打包器无法触碰（官方 CLI 对 node:sea 同款用法）。
type NodeSqliteDatabase = {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
};

function loadSqlite(): { DatabaseSync: new (path: string, options?: { timeout?: number }) => NodeSqliteDatabase } {
  const builtin = (
    process as unknown as {
      getBuiltinModule?: (id: string) => {
        DatabaseSync: new (path: string, options?: { timeout?: number }) => NodeSqliteDatabase;
      };
    }
  ).getBuiltinModule?.("node:sqlite");
  if (builtin) return builtin;
  throw new Error("node:sqlite unavailable in this runtime");
}

export interface TrimForkedSessionResult {
  ok: boolean;
  childSessionId: string;
  removedMessages: number;
  keptMessages: number;
  error?: string;
}

interface MessageRow {
  id: string;
  sequence: number;
}

/** 与 CLI isActiveCompactionBoundaryPart 同判据：type=compaction 且带 compactBoundary（或无 timelineStatus）。 */
function isActiveCompactionBoundaryPayload(payload: Record<string, unknown>): boolean {
  if (payload.type !== "compaction") return false;
  return payload.compactBoundary !== undefined || payload.timelineStatus === undefined;
}

function sessionDbPath(): string {
  return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}

export function trimForkedSessionHistory(input: {
  childSessionId: string;
  parentSessionId: string;
}): TrimForkedSessionResult {
  const { childSessionId, parentSessionId } = input;
  const base: TrimForkedSessionResult = {
    ok: false,
    childSessionId,
    removedMessages: 0,
    keptMessages: 0,
  };
  const dbPath = sessionDbPath();
  if (!existsSync(dbPath)) return { ...base, error: "session db not found" };
  if (!childSessionId.startsWith("sess_") || !parentSessionId.startsWith("sess_")) {
    return { ...base, error: "invalid session id" };
  }

  let db: NodeSqliteDatabase;
  try {
    db = new (loadSqlite().DatabaseSync)(dbPath, { timeout: 10_000 });
  } catch (error) {
    return { ...base, error: `open failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    // 安全体 ①：只裁「parent_id 与分叉父会话一致」的子会话。
    const child = db.prepare("select parent_id from session where id = ?").get(childSessionId) as
      | { parent_id: string | null }
      | undefined;
    if (!child || child.parent_id !== parentSessionId) {
      return { ...base, error: "not a fork child of the given parent" };
    }

    const messages = db
      .prepare("select id, sequence from message where session_id = ? order by sequence")
      .all(childSessionId) as unknown as MessageRow[];

    // 找最后一个活跃压缩边界（子会话 id 已被官方重映射，全部 child-local）。
    const compactionParts = db
      .prepare(
        "select p.message_id as mid, p.data as data, m.sequence as seq " +
          "from part p join message m on m.id = p.message_id and m.session_id = p.session_id " +
          "where p.session_id = ? and p.data like '{\"type\":\"compaction\"%' " +
          "order by m.sequence desc",
      )
      .all(childSessionId) as unknown as Array<{ mid: string; data: string; seq: number }>;
    let boundarySeq = -1;
    let preservedHead: string | undefined;
    let preservedTail: string | undefined;
    for (const part of compactionParts) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(part.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!isActiveCompactionBoundaryPayload(payload)) continue;
      boundarySeq = part.seq;
      const boundary = payload.compactBoundary as
        | { preservedSegment?: { headMessageId?: string; tailMessageId?: string } }
        | undefined;
      preservedHead = boundary?.preservedSegment?.headMessageId;
      preservedTail = boundary?.preservedSegment?.tailMessageId;
      break;
    }

    let toDelete: MessageRow[] = [];
    if (boundarySeq >= 0) {
      // preservedSegment 区间按 sequence 圈定（与 CLI compactPreservedSegmentMessages 同构）。
      let headSeq = Number.MAX_SAFE_INTEGER;
      let tailSeq = -1;
      for (const message of messages) {
        if (message.id === preservedHead) headSeq = Math.min(headSeq, message.sequence);
        if (message.id === preservedTail) tailSeq = Math.max(tailSeq, message.sequence);
      }
      const inPreservedSegment =
        headSeq <= tailSeq
          ? (message: MessageRow) => message.sequence >= headSeq && message.sequence <= tailSeq
          : () => false;

      toDelete = messages.filter(
        (message) => message.sequence < boundarySeq && !inPreservedSegment(message),
      );
    }

    // node:sqlite 无 transaction 辅助，手动事务（与官方 store 的 begin immediate 同款）。
    // goal 清理始终执行（与消息裁剪解耦）：分叉是全新续接会话，不继承父会话的
    // 目标迭代史。runtime/model_selection、runtime/execution_state 保留。
    db.exec("begin immediate");
    try {
      const deletePart = db.prepare("delete from part where session_id = ? and message_id = ?");
      const deleteMessage = db.prepare("delete from message where session_id = ? and id = ?");
      for (const row of toDelete) {
        deletePart.run(childSessionId, row.id);
        deleteMessage.run(childSessionId, row.id);
      }
      db.prepare("delete from session_target where session_id = ?").run(childSessionId);
      db.prepare("delete from session_entry where session_id = ? and type = ?").run(
        childSessionId,
        "target_completion_verification",
      );
      db.exec("commit");
    } catch (transactionError) {
      try {
        db.exec("rollback");
      } catch {
        /* 尽力而为 */
      }
      throw transactionError;
    }

    return {
      ok: true,
      childSessionId,
      removedMessages: toDelete.length,
      keptMessages: messages.length - toDelete.length,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db.close();
  }
}
