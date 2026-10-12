/**
 * zcode-go 静默 fork 事务执行器（从 index.ts 拆出——上游合并门控点 = index.ts
 * 的依赖注入常量 + 两处调用行）。manual（hover fork IPC）与 auto-compaction
 * （host 静默点触发）共用；在途互斥随本模块（原 index.ts 模块级 let 平移）。
 */
import type { BrowserWindow } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { forkCompactSessionDirect } from "./zcodeGoDirectFork.js";
import {
  deleteZcodeGoSilentForkSession,
  runZcodeGoSilentForkFinalMerge,
} from "./zcodeGoSilentForkLifecycle.js";
import { resetZcodeGoSilentForkEntryState, runZcodeGoSilentForkMergePass } from "./zcodeGoSilentForkMerge.js";
import { getZcodeGoSessionRedirect } from "@zcode/services/node";
import type { logger as zcodeGoLogger } from "./logger.js";

export interface ZcodeGoForkTransactionDeps {
  logger: typeof zcodeGoLogger;
  /** 转接事件广播目标（排除气泡窗口的应用窗口集）。 */
  getBroadcastTargets: () => BrowserWindow[];
}

let zcodeGoForkTransactionInFlight = false;

function executeZcodeGoSilentForkTransactionInternal(
  sessionId: string,
  createdBy: "manual" | "auto-compaction",
  deps: ZcodeGoForkTransactionDeps,
): { ok: boolean; forkSessionId?: string; error?: string } {
  if (!sessionId.startsWith("sess_")) {
    return { ok: false, error: "invalid session id" };
  }
  if (zcodeGoForkTransactionInFlight) {
    return { ok: false, error: "another silent fork transaction is in flight" };
  }
  zcodeGoForkTransactionInFlight = true;
  try {
    const existingEntry = getZcodeGoSessionRedirect(sessionId);
    const activeEndpoint = existingEntry?.forkSessionId ?? sessionId;
    const result = forkCompactSessionDirect({
      parentSessionId: activeEndpoint,
      silent: true,
      // 轮换防伪：活跃端点须有晚于当前表项建立的新压缩边界（原会话无表项时
      // 不校验——首个 fork 的边界本就可能很老）
      ...(existingEntry ? { requireBoundaryNewerThanMs: existingEntry.createdAt } : {}),
      log: (message, meta) => deps.logger.info(`[zcode-go-silent-fork] ${message}`, meta),
    });
    if (!result.ok) return { ok: false, error: result.error };
    if (existingEntry) {
      const oldForkId = existingEntry.forkSessionId;
      // 终末归并旧 fork 增量（全量兜底扫描，rewind 行也收尾）再轮换删除
      try {
        runZcodeGoSilentForkFinalMerge({
          originalSessionId: sessionId,
          entry: existingEntry,
          log: (message, meta) => deps.logger.info(`[zcode-go-silent-fork-merge] ${message}`, meta),
        });
      } catch (error) {
        deps.logger.warn("[zcode-go-silent-fork] 轮换终末归并异常（继续轮换，旧 fork 保留待删）", {
          original: sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      // 先轮换表项（新发送立即寻址新 fork），再删旧 fork 行
      setZcodeGoSessionRedirect(sessionId, {
        forkSessionId: result.childSessionId,
        createdAt: Date.now(),
        createdBy,
        ...(typeof result.parentMaxMessageRowid === "number"
          ? { parentMaxMessageRowid: result.parentMaxMessageRowid }
          : {}),
        ...(typeof result.childMaxMessageRowid === "number"
          ? { childMaxMessageRowid: result.childMaxMessageRowid }
          : {}),
      });
      resetZcodeGoSilentForkEntryState(sessionId);
      deleteZcodeGoSilentForkSession({
        forkSessionId: oldForkId,
        log: (message, meta) => deps.logger.info(`[zcode-go-silent-fork] ${message}`, meta),
      });
    } else {
      setZcodeGoSessionRedirect(sessionId, {
        forkSessionId: result.childSessionId,
        createdAt: Date.now(),
        createdBy,
        ...(typeof result.parentMaxMessageRowid === "number"
          ? { parentMaxMessageRowid: result.parentMaxMessageRowid }
          : {}),
        ...(typeof result.childMaxMessageRowid === "number"
          ? { childMaxMessageRowid: result.childMaxMessageRowid }
          : {}),
      });
    }
    for (const win of deps.getBroadcastTargets()) {
      if (!win.isDestroyed()) {
        win.webContents.send(PlatformChannels.ZcodeGoSessionRedirected, {
          from: sessionId,
          to: result.childSessionId,
        });
      }
    }
    deps.logger.info("[zcode-go-silent-fork] 转接完成", {
      from: sessionId,
      to: result.childSessionId,
      copiedMessages: result.copiedMessages,
      createdBy,
      rotation: Boolean(existingEntry),
    });
    // batch 3：转接后立即做一次双向补齐（迟到注入 + 增量归并起点对齐）。
    // 失败由 60s 周期 worker 幂等重试。
    try {
      runZcodeGoSilentForkMergePass({
        log: (message, meta) => deps.logger.info(`[zcode-go-silent-fork-merge] ${message}`, meta),
      });
    } catch {
      /* 见上 */
    }
    return { ok: true, forkSessionId: result.childSessionId };
  } finally {
    zcodeGoForkTransactionInFlight = false;
  }
}



/** 对外入口（保持原函数名，index.ts 两处调用）。 */
export function executeZcodeGoSilentForkTransaction(
  sessionId: string,
  createdBy: "manual" | "auto-compaction",
  deps: ZcodeGoForkTransactionDeps,
): { ok: boolean; forkSessionId?: string; error?: string } {
  return executeZcodeGoSilentForkTransactionInternal(sessionId, createdBy, deps);
}
