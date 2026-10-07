/**
 * zcode-go「在新窗口打开会话」统一入口（同实例多窗口）。
 *
 * 与启动第二个 app 实例不同：单实例锁不变，新窗口走官方多窗口骨架
 * （createWindowInstance，每窗口一个 local host），配置/会话库/托盘全共享；
 * 退出语义不变——全部窗口关闭才退出（Linux），Windows 关闭到托盘按窗口数判定。
 */
export interface ZcodeGoNewWindowTask {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

type MobileBridgeStatusLike = {
  state: "idle" | "signaling" | "waiting-mobile" | "connecting" | "connected" | "error";
  pairingUrl?: string;
  qrUrl?: string;
};

/**
 * web 远程（手机/浏览器）分支：新窗口 = 新浏览器标签页 + 一条可用配对码。
 *
 * 配对码取用策略：会话活着（含已连接）就复用同一配对码——房间由桌面心跳
 * 保活不会过期，且房间支持多客户端（桌面自动为第二个页面另配桥窗口）；
 * 仅当会话已死（idle/error）才真正「刷新配对码」（stop+start 重建，此时
 * 没有会被中断的现存连接）。这样无论多晚点开，新窗口都拿不到过期码。
 */
async function openSessionInNewWebTab(
  task: ZcodeGoNewWindowTask,
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string,
): Promise<void> {
  const bridge = (
    window as {
      zcode?: {
        zcodeGoMobileBridgeStart?: () => Promise<MobileBridgeStatusLike | undefined>;
        zcodeGoMobileBridgeStop?: () => Promise<void>;
      };
    }
  ).zcode;
  // 弹窗拦截规避：window.open 必须在用户手势栈内同步调用——先开空白页占住
  // 弹窗许可，拿到配对码后再导航（about:blank 同源可断 opener）。
  const tab = window.open("about:blank", "_blank");
  let status = await bridge?.zcodeGoMobileBridgeStart?.();
  if (status && (status.state === "idle" || status.state === "error")) {
    await bridge?.zcodeGoMobileBridgeStop?.();
    status = await bridge?.zcodeGoMobileBridgeStart?.();
  }
  const url = status?.pairingUrl ?? status?.qrUrl ?? null;
  if (!url || !tab) {
    try {
      tab?.close();
    } catch {
      /* 尽力而为 */
    }
    void import("@/components/ui/toast.js").then((m) =>
      m.toast(formatMessage({ id: "taskList.openInNewWindowFailed" }, { error: "" }), {
        variant: "warning",
      }),
    );
    return;
  }
  // 深链初始会话：容器页透传 #zg-task=，shim 解析后交给 App 启动领取
  // （与桌面 zcodeGoTakeSessionInitial 同一条打开路径）。
  const initial = encodeURIComponent(
    JSON.stringify({
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    }),
  );
  try {
    tab.opener = null;
  } catch {
    /* 跨源句柄置空失败无碍 */
  }
  tab.location.href = url + "#zg-task=" + initial;
}

export async function openSessionInNewWindow(
  task: ZcodeGoNewWindowTask,
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string,
): Promise<void> {
  const webRemote =
    (globalThis as typeof globalThis & { __ZCODE_WEB_REMOTE__?: boolean }).__ZCODE_WEB_REMOTE__ ===
    true;
  if (webRemote) {
    await openSessionInNewWebTab(task, formatMessage);
    return;
  }
  const bridge = (
    window as {
      zcode?: {
        zcodeGoOpenSessionInNewWindow?: (payload: ZcodeGoNewWindowTask) => Promise<{
          ok: boolean;
          error?: string;
        }>;
      };
    }
  ).zcode;
  let outcome: { ok: boolean; error?: string };
  try {
    outcome =
      (await bridge?.zcodeGoOpenSessionInNewWindow?.({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      })) ?? { ok: false, error: "desktop bridge unavailable" };
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!outcome.ok) {
    void import("@/components/ui/toast.js").then((m) =>
      m.toast(formatMessage({ id: "taskList.openInNewWindowFailed" }, { error: outcome.error ?? "" }), {
        variant: "warning",
      }),
    );
  }
}
