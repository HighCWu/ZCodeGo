/**
 * zcode-go「派生精简历史新会话」意图总线（侧栏菜单 → SessionPane）。
 * 菜单项设置意图；SessionPane 在该会话行就绪后消费并自动派生，60 秒未消费自动过期。
 */
const intents = new Map<string, number>();

export function setZcodeGoForkIntent(sessionId: string): void {
  intents.set(sessionId, Date.now());
}

export function consumeZcodeGoForkIntent(sessionId: string): boolean {
  const at = intents.get(sessionId);
  intents.delete(sessionId);
  return at !== undefined && Date.now() - at <= 60_000;
}
