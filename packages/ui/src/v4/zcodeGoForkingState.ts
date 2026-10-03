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


export interface ForkCompactSessionOutcome {
  ok: boolean;
  childSessionId: string;
  workspacePath?: string;
  error?: string;
}

/**
 * 菜单点击统一入口：登记分叉中（封锁点击）→ 主进程直连 fork（不打开父会话）
 * → 失效任务列表并 bump 重查（子任务即刻可见）→ 解除封锁。
 */
export async function forkCompactSessionViaHost(
  parentSessionId: string,
): Promise<ForkCompactSessionOutcome> {
  markZcodeGoForking(parentSessionId);
  try {
    const bridge = (
      window as {
        zcode?: {
          zcodeGoForkCompactSession?: (payload: {
            parentSessionId: string;
          }) => Promise<ForkCompactSessionOutcome>;
        };
      }
    ).zcode;
    const result = await bridge?.zcodeGoForkCompactSession?.({ parentSessionId });
    const outcome =
      result ?? { ok: false, childSessionId: "", error: "desktop bridge unavailable" };
    if (outcome.ok && outcome.workspacePath) {
      // 侧栏整表重查（应用内权威入口）+ query-cache 层兜底。
      void import("@/store/zcodeSessionStore.js").then((m) =>
        m.useZCodeSessionStore.getState().bumpTaskListVersion(outcome.workspacePath!),
      );
      void import("@/store/taskQueryCacheStore.js").then((m) =>
        m.invalidateTaskQueryCacheByScopes([{ workspacePath: outcome.workspacePath! }]),
      );
    }
    return outcome;
  } catch (error) {
    return {
      ok: false,
      childSessionId: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unmarkZcodeGoForking(parentSessionId);
  }
}
