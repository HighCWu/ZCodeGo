/**
 * zcode-go：会话历史合成（帧合成层）——巨会话冷打开的 host 侧快路径。
 *
 * 消费 sessionHistoryLazyReader 的窗口（parts 原样 JSON + message 元信息），
 * 投影为 v4 conversation 行（UI 投影面）并组装协议合法的合成快照 /
 * rowsRange 回填结果。官方 runtime 以全量恢复为前提产帧（巨会话 30s+）；
 * 本层让冷打开立即出尾窗，live 升级由后台真实订阅接管（见
 * zcodeAgentService 的合成订阅分支）。
 *
 * 投影口径（V1）：
 * - user 消息 + text part → userInput（origin realUser；附件不投影）
 * - assistant 消息 + text part → assistantText（state complete）
 * - reasoning part → reasoning（state complete）
 * - tool part → toolCall（callID/tool/state.status 映射；inputText 取
 *   state.input 的 JSON 摘要，超长截断）
 * - compaction part → timelineMarker(compact)（展示位；origin/status 取
 *   part 载荷可辨值，缺省 auto/success）
 * - step-start/step-finish/timeline(goal_verification) → 不投影（turn 边界
 *   与 goal 语义无法从 part 无损重建，宁缺毋错）
 * - rowId = message.sequence × 1000 + 消息内 part 序（确定性、单调、
 *   快照窗口与回填页一致——客户端按 rowId 键控合并/排序）
 */
import type { LazyHistoryWindow, LazyHistoryPart, LazyHistoryMessage } from "./sessionHistoryLazyReader.js";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import type { z } from "zod";

/** 快照尾窗行数（对齐协议 snapshotTailWindowRows=60）。 */
export const SYNTHETIC_TAIL_MESSAGES = 60;
/** rowsRange 单页行数上限（对齐 rowsRangeMaxLimit=200）。 */
export const SYNTHETIC_PAGE_MESSAGES = 200;
/** inputText 摘要上限（tool 调用入参可能巨大）。 */
const TOOL_INPUT_TEXT_MAX = 2000;

type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
type ConversationRow = ConversationSnapshot["rows"]["window"][number];

interface PartShape {
  type?: unknown;
  text?: unknown;
  callID?: unknown;
  tool?: unknown;
  state?: {
    status?: unknown;
    input?: unknown;
    error?: unknown;
  } | null;
}

function parsePart(data: string): PartShape | null {
  try {
    const parsed = JSON.parse(data) as PartShape;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function toolStatusOf(part: PartShape): "success" | "error" | "cancelled" {
  const status = part.state?.status;
  if (status === "error" || status === "failed") return "error";
  if (status === "cancelled") return "cancelled";
  return "success";
}

function toolInputTextOf(part: PartShape): string {
  const input = part.state?.input;
  if (input === undefined || input === null) return "";
  try {
    const text = JSON.stringify(input);
    return text.length > TOOL_INPUT_TEXT_MAX ? `${text.slice(0, TOOL_INPUT_TEXT_MAX)}…` : text;
  } catch {
    return "";
  }
}

/** message 序 → rowId 基数（消息内 part 序为低位）。 */
function rowIdOf(sequence: number | null, partOrdinal: number): number {
  return Math.max(1, sequence ?? 1) * 1000 + partOrdinal;
}

/**
 * 窗口 → 行投影（升序）。rowBaseFields 里 createdAt/createdAtSeq 取
 * message 元信息（part 级时间戳不参与行序，保证与 rowId 单调一致）。
 */
export function projectHistoryRows(window: LazyHistoryWindow): ConversationRow[] {
  const byMessage = new Map<string, LazyHistoryMessage>();
  for (const message of window.messages) byMessage.set(message.id, message);
  const partOrdinalByMessage = new Map<string, number>();
  const rows: ConversationRow[] = [];
  for (const part of window.parts) {
    const message = byMessage.get(part.messageId);
    if (!message) continue;
    const ordinal = (partOrdinalByMessage.get(part.messageId) ?? 0) + 1;
    partOrdinalByMessage.set(part.messageId, ordinal);
    const shape = parsePart(part.data);
    if (!shape) continue;
    const rowId = rowIdOf(part.messageSequence ?? message.sequence, ordinal);
    const turnId = `t_hist_${message.id}`;
    const createdAt = message.timeCreated;
    const createdAtSeq = rowId;
    if (shape.type === "text" && typeof shape.text === "string") {
      if (message.role === "user") {
        rows.push({
          rowId,
          turnId,
          createdAt,
          createdAtSeq,
          kind: "userInput",
          text: shape.text,
          origin: "realUser",
        });
      } else {
        rows.push({
          rowId,
          turnId,
          createdAt,
          createdAtSeq,
          kind: "assistantText",
          text: shape.text,
          state: "complete",
        });
      }
      continue;
    }
    if (shape.type === "reasoning" && typeof shape.text === "string") {
      rows.push({
        rowId,
        turnId,
        createdAt,
        createdAtSeq,
        kind: "reasoning",
        text: shape.text,
        state: "complete",
      });
      continue;
    }
    if (shape.type === "tool" && typeof shape.tool === "string") {
      const status = toolStatusOf(shape);
      const error =
        status === "error" && shape.state?.error && typeof shape.state.error === "object"
          ? {
              code: String((shape.state.error as { code?: unknown }).code ?? "tool_error"),
              message: String((shape.state.error as { message?: unknown }).message ?? "").slice(0, 500),
            }
          : undefined;
      rows.push({
        rowId,
        turnId,
        createdAt,
        createdAtSeq,
        kind: "toolCall",
        toolCallId: typeof shape.callID === "string" ? shape.callID : `hist_${part.partId}`,
        toolName: shape.tool,
        status,
        inputText: toolInputTextOf(shape),
        ...(error ? { error } : {}),
      });
      continue;
    }
    if (shape.type === "compaction") {
      rows.push({
        rowId,
        turnId,
        createdAt,
        createdAtSeq,
        kind: "timelineMarker",
        marker: {
          type: "compact",
          origin: "auto",
          status: "success",
        },
      });
    }
  }
  return rows;
}

function allow(v = true): { allowed: true } | { allowed: false; reasonCode: string } {
  return v ? { allowed: true } : { allowed: false, reasonCode: "unavailable" };
}

/**
 * 组装协议合法的合成快照（尾窗）。状态区取「已结束会话」的中性值——
 * live 升级时真实快照会整体替换本快照（store 的 snapshot 语义）。
 * 校验兜底：schema parse 失败时降级为空窗口（不让合成层害死订阅）。
 */
export function synthesizeConversationSnapshot(
  sessionId: string,
  window: LazyHistoryWindow,
  title: string,
): ConversationSnapshot {
  const rows = projectHistoryRows(window);
  const candidate = {
    protocolVersion: 1,
    sessionId,
    logEpoch: "zcode-go-synthetic",
    seq: 0,
    revision: 0,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: allow(),
      compact: allow(),
      switchModelConfig: allow(),
      setFollowupMode: allow(),
      queueEdit: allow(),
      sendQueuedNow: allow(false),
      pauseGoal: allow(false),
      resumeGoal: allow(false),
    },
    inputRouting: { mode: "startNow" },
    meta: { title, titleSource: "default" as const },
    config: { provider: "", model: "", thought: "default", followupMode: "queue" as const },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: {
      window: rows,
      // 滚动条估计值（totalCount 语义即估计）
      totalCount: window.totalMessages,
      // 全序第一行 rowId：sequence 从 1 起 → 1000；窗口首行等于它 ⇔ 真到顶
      firstRowId: 1000,
    },
  };
  const parsed = conversationSnapshotSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return conversationSnapshotSchema.parse({
    ...candidate,
    rows: { window: [], totalCount: window.totalMessages, firstRowId: null },
  });
}

/** rowsRange 回填结果（合成模式）：行升序 + hasMore 由游标判定。 */
export function synthesizeRowsRangePage(
  window: LazyHistoryWindow,
  beforeMessageSequence: number | null,
): {
  rows: ConversationRow[];
  atSeq: number;
  atRevision: number;
  atLogEpoch: string;
  hasMore: boolean;
} {
  const rows = projectHistoryRows(window);
  const oldest = window.oldestMessageSequence;
  const hasMore = oldest !== null && oldest > 1;
  return {
    rows,
    atSeq: 0,
    atRevision: 0,
    atLogEpoch: "zcode-go-synthetic",
    hasMore: hasMore && (beforeMessageSequence === null || oldest < beforeMessageSequence),
  };
}

/** 供中继层组装 wire 帧的载荷类型重导出（避免直接依赖 zod 推断）。 */
export type { LazyHistoryPart };
