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

export async function openSessionInNewWindow(
  task: ZcodeGoNewWindowTask,
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string,
): Promise<void> {
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
