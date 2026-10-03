/**
 * zcode-go 孤儿任务清扫（takeover 模式）。
 *
 * /zcode-go 空会话的清理存在不可避免的删除时序竞态：hook 在提交瞬间直删会话行，
 * 而「会话创建」事件异步到达桌面后，任务索引 syncer 才插入任务行——它插在删除之
 * 后，且因会话行已不在、读不到标题，落库为默认的「New session」（实测）。因此
 * 真正收敛的清理必须发生在 syncer 稳定之后：以会话库为准，定期删除任务索引里的
 * 孤儿行。
 *
 * 孤儿判定（护栏，防误删）：仅限本地任务（workspace_identity IS NULL——远端
 * SSH/WSL 任务的会话行在远端库里，本地查不到是正常形态，绝不碰）且 db.sqlite
 * 中不存在对应 session 行的任务行。同时兜底清理「title=/zcode-go 且 0 消息」
 * 的会话本身（hook 清理失败时的残留）。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type SqliteDb = {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
};

function loadSqlite(): { DatabaseSync: new (path: string, options?: { timeout?: number }) => SqliteDb } {
  const builtin = (
    process as unknown as {
      getBuiltinModule?: (id: string) => {
        DatabaseSync: new (path: string, options?: { timeout?: number }) => SqliteDb;
      };
    }
  ).getBuiltinModule?.("node:sqlite");
  if (builtin) return builtin;
  throw new Error("node:sqlite unavailable in this runtime");
}

const SESSION_DB = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const TASKS_INDEX_DB = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");

export interface SweepResult {
  ok: boolean;
  removedTasks: number;
  removedSessions: number;
  error?: string;
}

export function sweepOrphanTasks(logger?: {
  info: (message: string, extra?: unknown) => void;
  warn: (message: string, extra?: unknown) => void;
}): SweepResult {
  const base: SweepResult = { ok: false, removedTasks: 0, removedSessions: 0 };
  if (!existsSync(SESSION_DB) || !existsSync(TASKS_INDEX_DB)) {
    return { ...base, error: "db not found" };
  }
  let sessionDb: SqliteDb;
  let tasksDb: SqliteDb;
  try {
    const sqlite = loadSqlite();
    sessionDb = new sqlite.DatabaseSync(SESSION_DB, { timeout: 10_000 });
    tasksDb = new sqlite.DatabaseSync(TASKS_INDEX_DB, { timeout: 10_000 });
  } catch (error) {
    return { ...base, error: `open failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    // 本地会话 id 全集（万级行，一次载入）。
    const sessionIds = new Set<string>();
    const sessionRows = sessionDb.prepare("select id from session").all() as unknown as Array<{
      id: string;
    }>;
    for (const row of sessionRows) sessionIds.add(row.id);

    // 本地任务（远端 workspace_identity 不碰）。
    const taskRows = tasksDb
      .prepare(
        "select task_id, workspace_key, workspace_path from tasks where deleted = 0 and workspace_identity is null",
      )
      .all() as unknown as Array<{ task_id: string; workspace_key: string; workspace_path: string }>;

    const orphanTaskIds: string[] = [];
    for (const row of taskRows) {
      if (!row.task_id.startsWith("sess_")) continue;
      if (!sessionIds.has(row.task_id)) orphanTaskIds.push(row.task_id);
    }

    // 兜底：hook 清理失败时残留的 /zcode-go 空会话本体（0 消息）。
    const residualJunk = sessionDb
      .prepare(
        "select s.id as id, (select count(*) from message m where m.session_id = s.id) as n " +
          "from session s where s.title = '/zcode-go'",
      )
      .all() as unknown as Array<{ id: string; n: number }>;
    const junkSessionIds = residualJunk.filter((row) => row.n === 0).map((row) => row.id);

    tasksDb.exec("begin immediate");
    try {
      const deleteMember = tasksDb.prepare("delete from task_group_members where task_id = ?");
      const deleteTask = tasksDb.prepare("delete from tasks where task_id = ?");
      for (const taskId of [...orphanTaskIds, ...junkSessionIds]) {
        deleteMember.run(taskId);
        deleteTask.run(taskId);
      }
      tasksDb.exec("commit");
    } catch (transactionError) {
      try {
        tasksDb.exec("rollback");
      } catch {
        /* 尽力而为 */
      }
      throw transactionError;
    }

    if (junkSessionIds.length > 0) {
      sessionDb.exec("begin immediate");
      try {
        const deleteInputHistory = sessionDb.prepare("delete from input_history where session_id = ?");
        const deleteSessionInput = sessionDb.prepare("delete from session_input where session_id = ?");
        const deleteSession = sessionDb.prepare("delete from session where id = ?");
        for (const sessionId of junkSessionIds) {
          deleteInputHistory.run(sessionId);
          deleteSessionInput.run(sessionId);
          deleteSession.run(sessionId);
        }
        sessionDb.exec("commit");
      } catch (transactionError) {
        try {
          sessionDb.exec("rollback");
        } catch {
          /* 尽力而为 */
        }
        throw transactionError;
      }
    }

    const result: SweepResult = {
      ok: true,
      removedTasks: orphanTaskIds.length + junkSessionIds.length,
      removedSessions: junkSessionIds.length,
    };
    if (result.removedTasks > 0 || result.removedSessions > 0) {
      logger?.info("[zcode-go] 孤儿任务清扫完成", {
        orphanTasks: orphanTaskIds.length,
        junkSessions: junkSessionIds.length,
      });
    }
    return result;
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      sessionDb.close();
    } catch {
      /* 尽力而为 */
    }
    try {
      tasksDb.close();
    } catch {
      /* 尽力而为 */
    }
  }
}

/** takeover 启动后多轮清扫：1.5s（首屏前）/ 10s / 30s（兜 syncer 晚到插入）。 */
export function scheduleOrphanTaskSweeps(logger?: {
  info: (message: string, extra?: unknown) => void;
  warn: (message: string, extra?: unknown) => void;
}): void {
  for (const delayMs of [1_500, 10_000, 30_000]) {
    const timer = setTimeout(() => {
      try {
        sweepOrphanTasks(logger);
      } catch {
        /* 单轮异常不影响下一轮 */
      }
    }, delayMs);
    timer.unref?.();
  }
}
