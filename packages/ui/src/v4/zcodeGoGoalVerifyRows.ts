/**
 * zcode-go goal 复核轮的 UI 隐藏。
 *
 * 复核消息（服务层发送，文本带 shared ZCODE_GO_GOAL_VERIFY_MARKER）保留在
 * 会话存储中作为模型后续上下文，但 UI 时间线不渲染复核轮的任何行：
 * userInput 带标记 → 同 turnId 的全部行（assistant 回复、只读工具核查）
 * 一并过滤。
 */
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { isZcodeGoGoalVerifyMarkerText } from "@zcode/shared";

// 按 rows 数组引用记忆化：大会话（数万行）在加载/流式期每帧触发渲染，逐渲染
// 全量扫描会在 renderer 主线程反复分配大数组，造成会话打开卡顿。
const filterCache = new WeakMap<readonly ConversationRow[], readonly ConversationRow[]>();

export function filterZcodeGoGoalVerifyRows(
  rows: readonly ConversationRow[],
): readonly ConversationRow[] {
  if (rows.length === 0) return rows;
  const cached = filterCache.get(rows);
  if (cached) return cached;
  const hiddenTurnIds = new Set<string>();
  for (const row of rows) {
    if (row.kind === "userInput" && isZcodeGoGoalVerifyMarkerText(row.text)) {
      hiddenTurnIds.add(row.turnId);
    }
  }
  const result =
    hiddenTurnIds.size === 0 ? rows : rows.filter((row) => !hiddenTurnIds.has(row.turnId));
  filterCache.set(rows, result);
  return result;
}
