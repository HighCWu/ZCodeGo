/**
 * zcode-go SessionPane 集成（从 SessionPane.tsx 拆出——上游合并零冲突面，
 * SessionPane 的 zcode-go 门控点仅三个 hook 调用行 + rows 过滤一行）。
 */
import { useCallback, useEffect, useRef } from "react";
import type {
  CommandAck,
  CommandType,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

type Logger = {
  warn: (...args: unknown[]) => void;
  lifecycle: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
};

type DispatchCommand = (
  type: CommandType,
  payload: Record<string, unknown>,
  targetSessionId: string | null,
  baseRevision?: number,
  baseLogEpoch?: string,
  ...rest: never[]
) => Promise<CommandAck>;

/** hover fork（silent fork direct 流程）：双击防抖 + 桌面 IPC。 */
export function useZcodeGoHoverForkHandler({
  sessionId,
  snapshotRef,
  logger,
}: {
  sessionId: string | null;
  snapshotRef: { current: ConversationSnapshot | null };
  logger: Logger;
}): (target: ConversationRowTarget) => void {
  const hoverForkInFlightRef = useRef(false);
  return useCallback(
    (_target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // 双击防抖：main 事务互斥只保证串行，防不住连续两次各建一对会话
      if (hoverForkInFlightRef.current) return;
      hoverForkInFlightRef.current = true;
      // zcode-go hover fork（silent fork direct 流程）：direct fork 活跃端点 →
      // 轮换转接（redirect S→N，视图/runtime 无缝续接精简上下文）→ 边界前历史
      // 由后台倒序补齐进 N（rowsRange/历史查询放行前同步推完，杜绝假到顶）。
      // 全量语义由补齐完成时达成；原 forkAssistant 命令通道保留给非桌面调用方。
      void (async () => {
        try {
          const result = await (
            window as {
              zcode?: {
                zcodeGoSilentFork?: (payload: {
                  sessionId: string;
                }) => Promise<{ ok: boolean; forkSessionId?: string; error?: string }>;
              };
            }
          ).zcode?.zcodeGoSilentFork?.({ sessionId });
          if (!result?.ok) {
            logger.warn(`[v4-pane] hover fork 未执行: ${result?.error ?? "unknown"}`);
          }
        } catch (error) {
          logger.warn(
            `[v4-pane] hover fork 异常: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          hoverForkInFlightRef.current = false;
        }
      })();
    },
    [logger, sessionId],
  );
}

/**
 * pauseGoal/resumeGoal 属 CAS 命令集（baseRevision 必须精确等于 runtime 当前
 * revision）。流式进行中 revision 随帧推进，UI 已应用 revision 几乎必然滞后
 * → 命令被拒 proto.staleRevision（静默，仅 console warn）→ 暂停 icon 不翻转
 * （用户实测「目标打断时有时候暂停 icon 不变继续」）。命令幂等（已 paused 时
 * noop），stale 时用最新已应用 revision 小退避重试即可收敛。
 */
export function useZcodeGoGoalCommandHandlers({
  dispatchCommand,
  sessionId,
  snapshotRef,
  logger,
}: {
  dispatchCommand: DispatchCommand;
  sessionId: string | null;
  snapshotRef: { current: ConversationSnapshot | null };
  logger: Logger;
}): { handlePauseGoal: () => void; handleResumeGoal: () => void } {
  const dispatchGoalCommandWithStaleRetry = useCallback(
    async (type: "pauseGoal" | "resumeGoal"): Promise<void> => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        let ack: CommandAck;
        try {
          ack = await dispatchCommand(type, {}, sessionId, snapshotRef.current?.revision);
        } catch (error) {
          logger.lifecycle.warn(`[v4-pane] ${type} 发送失败: ${String(error)}`);
          return;
        }
        if (ack.status === "stale") {
          await new Promise((resolve) => setTimeout(resolve, 120));
          continue;
        }
        // 与 handleStop 同款生命周期留痕：暂停/继续失效排障的唯一 UI 侧线索
        // （stale-revision 拒绝、runtime 非 active 态 no-op 都在这里现形）。
        logger.lifecycle.info(`[v4-pane] ${type} ack`, {
          status: ack.status,
          reasonCode: ack.reasonCode ?? "",
          attempt,
          goalStatus: snapshotRef.current?.goal?.status ?? "",
        });
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] ${type} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
        return;
      }
      logger.warn(`[v4-pane] ${type} 连续 stale 重试耗尽（流式 revision 推进不歇）`);
    },
    [dispatchCommand, sessionId],
  );

  const handlePauseGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.pauseGoal.allowed) return;
    // runtime 的 goal 续跑回合内没有任何命令通道能落地暂停（E2E 四轮探针
    // 实证）：pauseGoal 被序列化推迟到回合结束、彼时状态已流转 → 静默 no-op
    // （icon 永不翻转）；stop 无可停目标（canStop 恒 false）；backgroundWorks
    // 为空。zcode-go 的 goal-keeper 自动重触发又把回合间隙的暂停窗口关死。
    // 修复链：① 立即尽力而为（stale 重试的 pauseGoal + canStop 时的 stop）；
    // ② 登记暂停意图给 keeper——完成边沿跳过复核/重触发/看门狗 resume，
    // goal 在本回合收尾后停止续跑，icon 随终态确定性翻转。
    void dispatchGoalCommandWithStaleRetry("pauseGoal");
    if (current.control.canStop) {
      const foregroundExecutionId = current.control.activeWorks.find(
        (work) => work.foregroundExecutionId,
      )?.foregroundExecutionId;
      void dispatchCommand(
        "stop",
        foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {},
        sessionId,
      ).catch((error) => {
        logger.lifecycle.warn(`[v4-pane] pause(stop 路径) 失败: ${String(error)}`);
      });
    }
    // 暂停意图经 pauseGoal 命令路径自动登记（host 侧 hook），无需额外 RPC。
  }, [dispatchCommand, dispatchGoalCommandWithStaleRetry, sessionId]);

  const handleResumeGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.resumeGoal.allowed) return;
    void dispatchGoalCommandWithStaleRetry("resumeGoal");
  }, [dispatchGoalCommandWithStaleRetry, sessionId]);

  return { handlePauseGoal, handleResumeGoal };
}

/** 静默 fork 转接 → 强制快照重订（服务层已把订阅寻址到隐形 fork）。 */
export function useZcodeGoSessionRedirectSnapshot({
  sessionId,
  lease,
}: {
  sessionId: string | null;
  lease: { store: { connect: (options?: { forceSnapshot?: boolean }) => Promise<unknown> } } | null;
}): void {
  useEffect(() => {
    if (!sessionId || !lease) return;
    const off = (
      window as {
        zcode?: {
          zcodeGoOnSessionRedirected?: (
            callback: (payload: { from: string; to: string }) => void,
          ) => () => void;
        };
      }
    ).zcode?.zcodeGoOnSessionRedirected?.((payload) => {
      if (payload?.from === sessionId) {
        void lease.store.connect({ forceSnapshot: true });
      }
    });
    return () => off?.();
  }, [sessionId, lease]);
}
