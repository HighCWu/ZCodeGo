/**
 * zcode-go「分叉压缩历史会话」意图总线（侧栏菜单 → SessionPane）。
 * 菜单项设置意图；SessionPane 在该会话的 fork 目标行就绪后消费并自动派生，
 * 60 秒未消费自动过期。
 *
 * 已打开的会话没有挂载/切换事件，intent 设置时同步广播 window 事件，
 * 活跃的 SessionPane 订阅自己 sessionId 的事件即时消费。
 */
const INTENT_EVENT = "zcode-go:fork-intent";

const intents = new Map<string, number>();

export function setZcodeGoForkIntent(sessionId: string): void {
  intents.set(sessionId, Date.now());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(INTENT_EVENT, { detail: { sessionId } }));
  }
}

/** 是否有未过期意图（不消费）。 */
export function peekZcodeGoForkIntent(sessionId: string): boolean {
  const at = intents.get(sessionId);
  return at !== undefined && Date.now() - at <= 60_000;
}

export function consumeZcodeGoForkIntent(sessionId: string): boolean {
  const at = intents.get(sessionId);
  intents.delete(sessionId);
  return at !== undefined && Date.now() - at <= 60_000;
}
