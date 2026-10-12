/**
 * zcode-go 窗口级集成 hooks（从 App.tsx 拆出——上游合并零冲突面，App.tsx 的
 * zcode-go 门控点仅两个 hook 调用行）。
 */
import { useEffect, useRef } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** 跨窗口侧边栏同步：聚焦 bump + 20s 兜底轮询（原 App.tsx 内联实现的平移）。 */
export function useZcodeGoWindowTaskListSync(
  workspaceAbsPath: string,
  workspaceIdentity?: string,
): void {
  // zcode-go：跨窗口侧边栏同步。任务列表是拉模式（本窗口签名缓存 + 本窗口 host
  // 投影），另一窗口创建/变更的任务对本窗口零信号——用户切回本窗口时看不到新任务。
  // 组合修复（host 侧另有快照 15s 过期强制重建）：窗口聚焦立即 bump（「看的时刻
  // 是新的」）+ 20s 兜底轮询（后台窗口也跟随，覆盖 CLI 自动化等非 UI 来源）。
  useEffect(() => {
    const bump = (): void => {
      useZCodeSessionStore.getState().bumpTaskListVersion(workspaceAbsPath, workspaceIdentity);
    };
    const bumpOnVisible = (): void => {
      if (document.visibilityState === "visible") bump();
    };
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", bumpOnVisible);
    const timer = window.setInterval(bump, 20_000);
    return () => {
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", bumpOnVisible);
      window.clearInterval(timer);
    };
  }, [workspaceAbsPath, workspaceIdentity]);
}

/** 「在新窗口打开会话」初始会话领取（原 App.tsx 内联实现的平移）。 */
export function useZcodeGoInitialSessionClaim(
  handleSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void,
): void {
  // zcode-go：本窗口若是「在新窗口打开会话」创建的，启动时领取初始会话并打开。
  // 领取是一次性质询（main 侧领取即清除）；本 effect 仅在窗口挂载时执行一次。
  const handleSelectTaskRef = useRef(handleSelectTask);
  handleSelectTaskRef.current = handleSelectTask;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bridge = (
        window as {
          zcode?: {
            zcodeGoTakeSessionInitial?: () => Promise<{
              taskId: string;
              workspacePath: string;
              workspaceIdentity?: string;
            } | null>;
          };
        }
      ).zcode;
      let pending: { taskId: string; workspacePath: string; workspaceIdentity?: string } | null =
        null;
      try {
        pending = (await bridge?.zcodeGoTakeSessionInitial?.()) ?? null;
      } catch {
        pending = null;
      }
      // web 远程「在新窗口打开会话」：本窗口由深链 #zg-task= 打开，shim 解析
      // 后挂在 window 上——与桌面新窗口的领取式注入走同一条打开路径。
      if (!pending) {
        const webInitial = (
          window as {
            __ZCODE_GO_INITIAL_TASK__?: {
              taskId?: unknown;
              workspacePath?: unknown;
              workspaceIdentity?: unknown;
            } | null;
          }
        ).__ZCODE_GO_INITIAL_TASK__;
        if (
          webInitial &&
          typeof webInitial.taskId === "string" &&
          typeof webInitial.workspacePath === "string" &&
          webInitial.taskId &&
          webInitial.workspacePath
        ) {
          pending = {
            taskId: webInitial.taskId,
            workspacePath: webInitial.workspacePath,
            workspaceIdentity:
              typeof webInitial.workspaceIdentity === "string" && webInitial.workspaceIdentity
                ? webInitial.workspaceIdentity
                : undefined,
          };
        }
      }
      if (cancelled || !pending) return;
      // 冷启动时任务列表/store 可能尚未就绪（tab 恢复与 App 挂载并行）：验证
      // activeTaskId 落位，未落位延迟重试（最多 3 次），避免一次性领取因时序
      // 太早而丢掉初始会话。
      const tryOpen = (remaining: number): void => {
        handleSelectTaskRef.current(
          pending.workspacePath,
          pending.taskId,
          pending.workspaceIdentity,
        );
        window.setTimeout(() => {
          if (cancelled) return;
          const workspaceState = useZCodeSessionStore
            .getState()
            .getWorkspaceState(pending.workspacePath, pending.workspaceIdentity);
          if (workspaceState.activeTaskId !== pending.taskId && remaining > 0) {
            tryOpen(remaining - 1);
          }
        }, 1_200);
      };
      tryOpen(3);
    })();
    return () => {
      cancelled = true;
    };
    // 仅窗口启动执行一次：初始会话是 per-window 的一次性质询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
