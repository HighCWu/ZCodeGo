/**
 * zcode-go「分叉进行中」状态（侧栏点击封锁用）。
 * 菜单点击分叉后、子会话任务行就位前，禁止打开父会话（fork 需要父会话激活，
 * 打开会与分叉/裁剪竞态并触发大历史加载）。
 */
const forking = new Set<string>();

export function markZcodeGoForking(sessionId: string): void {
  forking.add(sessionId);
}

export function unmarkZcodeGoForking(sessionId: string): void {
  forking.delete(sessionId);
}

export function isZcodeGoForking(sessionId: string): boolean {
  return forking.has(sessionId);
}
