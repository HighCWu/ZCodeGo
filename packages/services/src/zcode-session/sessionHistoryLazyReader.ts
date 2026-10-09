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
// 静态 import node:sqlite 会被 esbuild 外置成裸包名 "sqlite"（对已知内建
// 剥 node: 前缀）——运行时 ERR_MODULE_NOT_FOUND。与 desktop 侧 merge 模块
// 同款：getBuiltinModule 字符串查找（type-only import 只留类型）。
import type { DatabaseSync } from "node:sqlite";

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;

function loadDatabaseSync(): DatabaseSyncCtor {
  const builtin = (
    process as unknown as {
      getBuiltinModule?: (id: string) => { DatabaseSync?: DatabaseSyncCtor } | undefined;
    }
  ).getBuiltinModule?.("node:sqlite");
  if (!builtin?.DatabaseSync) {
    throw new Error("node:sqlite unavailable in this runtime");
  }
  return builtin.DatabaseSync;
}

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

export interface LazyHistoryMessage {
  id: string;
  sequence: number | null;
  /** message.data 的 role（user/assistant 等）；解析失败为 null。 */
  role: string | null;
  timeCreated: number;
}

export interface LazyHistoryWindow {
  parts: LazyHistoryPart[];
  /** 窗口内消息元信息（历史顺序升序）；行投影消费 role/timeCreated。 */
  messages: LazyHistoryMessage[];
  /** 窗口内最旧 message 的序（下一页回填的游标）；会话为空时为 null。 */
  oldestMessageSequence: number | null;
  totalMessages: number;
}

export interface SessionHistoryLazyReader {
  /** 尾窗：最近 maxMessages 条消息的全部 part（按历史顺序升序）。 */
  readTailWindow(sessionId: string, maxMessages: number): LazyHistoryWindow;
  /**
   * 向更早历史回填一页：取 message 序 < beforeMessageSequence 的最近
   * maxMessages 条消息的全部 part，仍按历史顺序升序返回。
   */
  readPageBefore(
    sessionId: string,
    beforeMessageSequence: number,
    maxMessages: number,
  ): LazyHistoryWindow;
  /** 会话消息总数（巨会话判定/滚动条估计）；库/会话缺失返回 0。 */
  countMessages(sessionId: string): number;
  /**
   * 会话的模型选择（合成快照 config 投影用）：优先 runtime/model_selection
   * entry（runtime 恢复器同款，包装/裸两种形状都认），回退末条 assistant 消息
   * 的 modelId/provider 字段。无法判定返回 null。
   */
  readModelSelection(sessionId: string): {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  } | null;
  close(): void;
}

interface RawMessageRow {
  id: string;
  sequence: number | null;
  time_created: number;
  data: string | null;
}

interface MessageRow {
  id: string;
  sequence: number | null;
  timeCreated: number;
  role: string | null;
}

function parseRole(data: string | null | undefined): string | null {
  if (!data) return null;
  try {
    const role = (JSON.parse(data) as { role?: unknown }).role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

function toWindow(
  messageRows: MessageRow[],
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
  // messageRows 已倒序；逐消息按 partId 稳定排序后正向输出。
  for (const message of [...messageRows].reverse()) {
    const bucket = (byMessage.get(message.id) ?? []).sort((a, b) =>
      a.partIdWithinMessage < b.partIdWithinMessage
        ? -1
        : a.partIdWithinMessage > b.partIdWithinMessage
          ? 1
          : 0,
    );
    ordered.push(...bucket);
  }
  const messagesAsc = [...messageRows]
    .sort((a, b) => a.timeCreated - b.timeCreated || (a.id < b.id ? -1 : 1))
    .map((m) => ({ id: m.id, sequence: m.sequence, role: m.role, timeCreated: m.timeCreated }));
  return {
    parts: ordered,
    messages: messagesAsc,
    oldestMessageSequence:
      messageRows.length > 0 ? (messageRows[messageRows.length - 1]?.sequence ?? null) : null,
    totalMessages,
  };
}

const MESSAGE_COLUMNS = "id, sequence, time_created, data";

export function openSessionHistoryLazyReader(dbPath: string): SessionHistoryLazyReader {
  // mode=ro：绝不写运行中的共享库；WAL 下并发读安全。
  const db = new (loadDatabaseSync())(dbPath, { readOnly: true });

  const countStmt = db.prepare("SELECT count(*) AS c FROM message WHERE session_id = ?");

  const fetchWindow = (sessionId: string, rawRows: RawMessageRow[]): LazyHistoryWindow => {
    const totalMessages = (countStmt.get(sessionId) as { c: number }).c;
    const messageRows: MessageRow[] = rawRows.map((r) => ({
      id: r.id,
      sequence: r.sequence,
      timeCreated: r.time_created,
      role: parseRole(r.data),
    }));
    if (messageRows.length === 0) {
      return { parts: [], messages: [], oldestMessageSequence: null, totalMessages };
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
    return toWindow(messageRows, parts, totalMessages);
  };

  return {
    readTailWindow(sessionId: string, maxMessages: number): LazyHistoryWindow {
      const rows = db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM message
            WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?`,
        )
        .all(sessionId, maxMessages) as unknown as RawMessageRow[];
      return fetchWindow(sessionId, rows);
    },
    readPageBefore(
      sessionId: string,
      beforeMessageSequence: number,
      maxMessages: number,
    ): LazyHistoryWindow {
      // message.sequence 会话内单调（官方写入语义）；空序历史回退 time_created 比较。
      const rows = db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM message
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
        ) as unknown as RawMessageRow[];
      return fetchWindow(sessionId, rows);
    },
    countMessages(sessionId: string): number {
      try {
        return (countStmt.get(sessionId) as { c: number }).c;
      } catch {
        return 0;
      }
    },
    readModelSelection(sessionId: string): {
      providerId: string;
      modelId: string;
      options?: { reasoningLevel?: string };
    } | null {
      const pickOptions = (raw: unknown): { reasoningLevel?: string } | undefined => {
        const level = (raw as { options?: { reasoningLevel?: unknown } })?.options?.reasoningLevel;
        return typeof level === "string" && level.trim() ? { reasoningLevel: level } : undefined;
      };
      try {
        const entry = db
          .prepare(
            "select data from session_entry where session_id = ? and type = 'runtime/model_selection' " +
              "order by time_updated desc limit 1",
          )
          .get(sessionId) as { data: string } | undefined;
        if (entry) {
          const parsed = JSON.parse(entry.data) as {
            providerId?: unknown;
            modelId?: unknown;
            modelSelection?: { providerId?: unknown; modelId?: unknown };
          };
          const isBare =
            typeof parsed.providerId === "string" && typeof parsed.modelId === "string";
          const wrapped = parsed.modelSelection;
          const isWrapped =
            typeof wrapped?.providerId === "string" && typeof wrapped?.modelId === "string";
          if (isBare || isWrapped) {
            const out = isBare
              ? { providerId: parsed.providerId as string, modelId: parsed.modelId as string }
              : {
                  providerId: (wrapped as { providerId: string }).providerId,
                  modelId: (wrapped as { modelId: string }).modelId,
                };
            if (out.providerId.trim() && out.modelId.trim()) {
              const options = pickOptions(isBare ? parsed : wrapped);
              return options ? { ...out, options } : out;
            }
          }
        }
      } catch {
        /* entry 路径失败回落消息推导 */
      }
      try {
        const last = db
          .prepare(
            "select data from message where session_id = ? and data like '%\"role\":\"assistant\"%' " +
              "and data like '%\"modelId\"%' order by time_created desc limit 1",
          )
          .get(sessionId) as { data: string } | undefined;
        if (last) {
          const parsed = JSON.parse(last.data) as {
            modelId?: unknown;
            provider?: unknown;
            providerId?: unknown;
          };
          const modelId = typeof parsed.modelId === "string" ? parsed.modelId.trim() : "";
          const providerId = String(parsed.providerId ?? parsed.provider ?? "").trim();
          if (modelId && providerId) return { providerId, modelId };
        }
      } catch {
        /* 无法判定返回 null */
      }
      return null;
    },
    close(): void {
      db.close();
    },
  };
}
