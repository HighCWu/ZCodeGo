/**
 * zcode-go：会话历史懒读取（数据库倒序按需加载）——巨会话冷打开的正解基础。
 *
 * 背景：runtime 冷订阅要全量恢复会话（sess 级 144K part / 214MB 实测 30s+，
 * 发送命令同路径超时）。协议本就设计为尾窗快照（snapshotTailWindowRows=60）
 * + 按需回填（rowsRangeMaxLimit=200），但服务端（官方 runtime）以全量恢复
 * 为前提产帧。本模块在 host 层（fork 自有代码，takeover 模式可达）直接
 * 倒序查库，为「host 合成历史快照 + live 升级」路径提供读取原语。
 *
 * 索引策略（全部现有索引，零 schema 变更——库是运行中共享存储，不能加锁建索引）：
 * - message_session_time_created_id_idx (session_id, time_created, id)
 *   → 倒序取最近 N 条 message（实测 0.2ms@144K part 会话）
 * - part_message_id_id_idx (message_id, id) → 取这些 message 的 part（0.2ms）
 * - 裸 `part ORDER BY time_created DESC` 实测冷读 4.6s（排序键不在索引，
 *   top-N 也要摸全量行页）——禁止使用，必须走 message 先行。
 */
import { DatabaseSync } from "node:sqlite";

export interface LazyHistoryPart {
  partId: string;
  messageId: string;
  /** message 序（会话内单调），升序即历史顺序。 */
  messageSequence: number | null;
  partIdWithinMessage: string;
  timeCreated: number;
  /** 原样 part 行数据（JSON 文本）——帧合成层直接消费，这里不解析。 */
  data: string;
}

export interface LazyHistoryWindow {
  parts: LazyHistoryPart[];
  /** 窗口内最旧 message 的序（下一页回填的游标）；会话为空时为 null。 */
  oldestMessageSequence: number | null;
  totalMessages: number;
}

export interface SessionHistoryLazyReader {
  /** 尾窗：最近 maxMessages 条消息的全部 part（按历史顺序升序）。 */
  readTailWindow(sessionId: string, maxMessages: number): LazyHistoryWindow;
  /**
   * 向更早历史回填一页：取 message 序 < beforeMessageSequence 的最近
   * maxMessages 条消息的 part，仍按历史顺序升序返回。
   */
  readPageBefore(
    sessionId: string,
    beforeMessageSequence: number,
    maxMessages: number,
  ): LazyHistoryWindow;
  close(): void;
}

interface MessageRow {
  id: string;
  sequence: number | null;
}

function toWindow(
  sessionId: string,
  messages: MessageRow[],
  parts: LazyHistoryPart[],
  totalMessages: number,
): LazyHistoryWindow {
  const byMessage = new Map<string, LazyHistoryPart[]>();
  for (const part of parts) {
    const bucket = byMessage.get(part.messageId);
    if (bucket) bucket.push(part);
    else byMessage.set(part.messageId, [part]);
  }
  const ordered: LazyHistoryPart[] = [];
  // messages 已倒序；逐消息按 partId 稳定排序后正向输出。
  for (const message of [...messages].reverse()) {
    const bucket = (byMessage.get(message.id) ?? []).sort((a, b) =>
      a.partIdWithinMessage < b.partIdWithinMessage
        ? -1
        : a.partIdWithinMessage > b.partIdWithinMessage
          ? 1
          : 0,
    );
    ordered.push(...bucket);
  }
  return {
    parts: ordered,
    oldestMessageSequence:
      messages.length > 0 ? (messages[messages.length - 1]?.sequence ?? null) : null,
    totalMessages,
  };
}

export function openSessionHistoryLazyReader(dbPath: string): SessionHistoryLazyReader {
  // mode=ro：绝不写运行中的共享库；WAL 下并发读安全。
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const fetchWindow = (
    sessionId: string,
    messageRows: MessageRow[],
  ): LazyHistoryWindow => {
    const totalMessageRow = db
      .prepare("SELECT count(*) AS c FROM message WHERE session_id = ?")
      .get(sessionId) as { c: number };
    if (messageRows.length === 0) {
      return { parts: [], oldestMessageSequence: null, totalMessages: totalMessageRow.c };
    }
    const placeholders = messageRows.map(() => "?").join(",");
    const partRows = db
      .prepare(
        `SELECT id, message_id, sequence, time_created, data
           FROM part WHERE message_id IN (${placeholders})`,
      )
      .all(...messageRows.map((m) => m.id)) as Array<{
      id: string;
      message_id: string;
      sequence: number | null;
      time_created: number;
      data: string;
    }>;
    const parts: LazyHistoryPart[] = partRows.map((row) => ({
      partId: row.id,
      messageId: row.message_id,
      messageSequence:
        messageRows.find((m) => m.id === row.message_id)?.sequence ?? row.sequence ?? null,
      partIdWithinMessage: row.id,
      timeCreated: row.time_created,
      data: row.data,
    }));
    return toWindow(sessionId, messageRows, parts, totalMessageRow.c);
  };

  return {
    readTailWindow(sessionId: string, maxMessages: number): LazyHistoryWindow {
      const messages = db
        .prepare(
          `SELECT id, sequence FROM message
            WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?`,
        )
        .all(sessionId, maxMessages) as Array<{ id: string; sequence: number | null }>;
      return fetchWindow(sessionId, messages);
    },
    readPageBefore(
      sessionId: string,
      beforeMessageSequence: number,
      maxMessages: number,
    ): LazyHistoryWindow {
      // message.sequence 会话内单调（官方写入语义）；空序历史回退 time_created 比较。
      const messages = db
        .prepare(
          `SELECT id, sequence FROM message
            WHERE session_id = ? AND (
              (sequence IS NOT NULL AND sequence < ?)
              OR (sequence IS NULL AND time_created < (
                SELECT time_created FROM message
                 WHERE session_id = ? AND sequence = ? LIMIT 1
              ))
            )
            ORDER BY time_created DESC, id DESC LIMIT ?`,
        )
        .all(
          sessionId,
          beforeMessageSequence,
          sessionId,
          beforeMessageSequence,
          maxMessages,
        ) as Array<{ id: string; sequence: number | null }>;
      return fetchWindow(sessionId, messages);
    },
    close(): void {
      db.close();
    },
  };
}
