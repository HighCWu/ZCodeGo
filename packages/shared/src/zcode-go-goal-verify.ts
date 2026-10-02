/**
 * zcode-go goal 复核标记（跨包共享）。
 *
 * 桌面发送的 goal 复核消息以此标记开头；UI 渲染层据此隐藏/折叠复核轮的
 * 行（消息本体保留在会话存储中，作为模型后续上下文的一部分）。
 */
export const ZCODE_GO_GOAL_VERIFY_MARKER = "<!-- zcode-go:goal-verify";

export function isZcodeGoGoalVerifyMarkerText(text: string): boolean {
  return text.startsWith(ZCODE_GO_GOAL_VERIFY_MARKER);
}
