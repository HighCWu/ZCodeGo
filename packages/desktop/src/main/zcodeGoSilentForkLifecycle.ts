/**
 * zcode-go 静默 fork 生命周期（batch 4 拆分自 zcodeGoSilentForkMerge）：
 * 周期 worker 启停、轮换终末归并、旧 fork 删除。核心双向同步逻辑见 merge 模块。
 */
import type { ZcodeGoSessionRedirectEntry } from "@zcode/services/node";
import {
  clearZcodeGoSilentForkEntryStateForTest,
  openZcodeGoSilentForkSessionDb,
  runZcodeGoSilentForkMergePass,
  syncZcodeGoSilentForkEntry,
} from "./zcodeGoSilentForkMerge.js";

/**
 * 轮换终末归并（batch 4）：删除旧 fork 前对其做一次全量兜底归并（rewind 回退
 * 行等非常规路径一并收尾）。独立连接、忽略内存提示，只作用于单条目。
 */
export function runZcodeGoSilentForkFinalMerge(input: {
  originalSessionId: string;
  entry: ZcodeGoSessionRedirectEntry;
  sessionDbPath?: string;
  log?: (message: string, meta?: unknown) => void;
}): void {
  const sessionDb = openZcodeGoSilentForkSessionDb(input.sessionDbPath);
  if (!sessionDb) return;
  try {
    syncZcodeGoSilentForkEntry({
      sessionDb,
      originalSessionId: input.originalSessionId,
      entry: input.entry,
      fullScan: true,
      log: input.log ?? (() => {}),
    });
  } finally {
    try {
      sessionDb.close();
    } catch {
      /* 尽力而为 */
    }
  }
}

let workerTimer: ReturnType<typeof setInterval> | null = null;
const WORKER_INTERVAL_MS = 60_000;

/** 启动周期归并（60s；unref 不拖住进程退出）。幂等。 */
export function startZcodeGoSilentForkMergeWorker(
  log: (message: string, meta?: unknown) => void,
): void {
  if (workerTimer) return;
  const tick = (): void => {
    try {
      runZcodeGoSilentForkMergePass({ log });
    } catch (error) {
      log("静默 fork 归并 pass 异常", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  workerTimer = setInterval(tick, WORKER_INTERVAL_MS);
  workerTimer.unref?.();
}

/**
 * 轮换收尾（batch 4）：删除被替换的旧隐形 fork 会话的全部行。
 * 调用前提：redirect 已轮换到新 fork（新发送不再寻址旧 fork），
 * 且旧 fork 的增量已终末归并回原会话。删除失败只留不可见死行，无功能影响。
 */
export function deleteZcodeGoSilentForkSession(input: {
  forkSessionId: string;
  sessionDbPath?: string;
  log?: (message: string, meta?: unknown) => void;
}): boolean {
  const log = input.log ?? (() => {});
  const sessionDb = openZcodeGoSilentForkSessionDb(input.sessionDbPath);
  if (!sessionDb) return false;
  try {
    sessionDb.exec("begin immediate");
    try {
      sessionDb.prepare("delete from part where session_id = ?").run(input.forkSessionId);
      sessionDb.prepare("delete from message where session_id = ?").run(input.forkSessionId);
      sessionDb.prepare("delete from session_entry where session_id = ?").run(input.forkSessionId);
      const result = sessionDb.prepare("delete from session where id = ?").run(input.forkSessionId);
      sessionDb.exec("commit");
      log("旧隐形 fork 会话已删除（轮换收尾）", {
        forkSessionId: input.forkSessionId,
        deletedSessionRows: (result as { changes?: number }).changes ?? 0,
      });
      return true;
    } catch (error) {
      try {
        sessionDb.exec("rollback");
      } catch {
        /* 尽力而为 */
      }
      log("旧 fork 删除失败（残留为不可见死行，无功能影响）", {
        forkSessionId: input.forkSessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  } finally {
    try {
      sessionDb.close();
    } catch {
      /* 尽力而为 */
    }
  }
}

export function stopZcodeGoSilentForkMergeWorkerForTest(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  clearZcodeGoSilentForkEntryStateForTest();
}
