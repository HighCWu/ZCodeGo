/**
 * zcode-go：hover fork 全量历史的后台推进 worker（main 进程）。
 *
 * 用户定稿的流式 fork：forkAssistant（边界后内容，快）完成即 child 可用；
 * 边界前的更早历史由此 worker 每 2.5s 倒序推进一段（500 条）——用户提前
 * 关闭 app 后重启仍继续（任务状态持久化 ~/.zcode-go/）。rowsRange/历史
 * 查询触发时 host 侧同步推进剩余（单事务互斥、游标按 DB 实态推导，双推进
 * 器并发安全）。
 *
 * ⚠️ 本文件运行于 Electron main：不得 import 含 node:sqlite 静态依赖的
 * services 模块（main 的模块解析器不接受 node:sqlite，实测 ERR_MODULE_
 * NOT_FOUND: 'sqlite' 拖垮整个主进程）——sqlite 一律走 process.
 * getBuiltinModule（与 zcodeGoDirectFork/zcodeGoForkTrim 同款），推进 SQL
 * 与 services/zcodeGoForkFullHistory 的 advanceForkFullHistorySegment 保持
 * 逐字一致（状态文件是同一份，互为推进器）。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const WORKER_INTERVAL_MS = 2_500;
const SEGMENT_MESSAGES = 500;

let workerTimer: ReturnType<typeof setInterval> | null = null;

interface ForkFullHistoryTask {
  childSessionId: string;
  originalSessionId: string;
  status: "pending" | "done";
  lastSRowid: number;
  preservedHeadRowid: number;
  preservedTailRowid: number;
  boundaryRowid: number;
  boundaryTotal: number;
  injected: number;
  nextLowerSeq: number;
  updatedAt: number;
}

interface ForkFullHistoryState {
  version: number;
  tasks: ForkFullHistoryTask[];
}

function loadSqlite(): { DatabaseSync: new (path: string, options?: { timeout?: number }) => {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
} } {
  const builtin = (
    process as unknown as {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule?.("node:sqlite") as
    | { DatabaseSync: new (path: string, options?: { timeout?: number }) => {
        prepare: (sql: string) => {
          get: (...args: unknown[]) => unknown;
          all: (...args: unknown[]) => unknown[];
          run: (...args: unknown[]) => unknown;
        };
        exec: (sql: string) => void;
      } }
    | undefined;
  if (!builtin) throw new Error("node:sqlite unavailable in this runtime");
  return builtin;
}

function stateDir(): string {
  return process.env.ZCODE_GO_STATE_DIR_OVERRIDE || `${process.env.HOME || ""}/.zcode-go`;
}

function loadTasks(): ForkFullHistoryTask[] {
  try {
    const raw = JSON.parse(readFileSync(`${stateDir()}/fork-fullhistory-tasks.json`, "utf8")) as
      ForkFullHistoryState;
    if (raw.version === 1 && Array.isArray(raw.tasks)) return raw.tasks;
  } catch {
    /* 首次/损坏：空态 */
  }
  return [];
}

function saveTasks(tasks: ForkFullHistoryTask[]): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    `${stateDir()}/fork-fullhistory-tasks.json`,
    JSON.stringify({ version: 1, tasks }, null, 1),
    "utf8",
  );
}

function tick(log: (message: string, meta?: unknown) => void): void {
  const tasks = loadTasks().filter((t) => t.status === "pending");
  if (tasks.length === 0) return;
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(
    `${process.env.ZCODE_DATA_BASE_DIR?.trim() || process.env.HOME || ""}/.zcode/cli/db/db.sqlite`,
    { timeout: 10_000 },
  );
  try {
    for (const task of loadTasks().filter((t) => t.status === "pending")) {
      try {
        // —— 与 services advanceForkFullHistorySegment 逐字一致的段推进 ——
        const rows = db
          .prepare(
            "select id, time_created, time_updated, data, rowid as r from message " +
              "where session_id = ? and rowid < ? " +
              "and not (rowid >= ? and rowid <= ?) " +
              "order by rowid desc limit ?",
          )
          .all(
            task.originalSessionId,
            task.lastSRowid,
            task.preservedHeadRowid,
            task.preservedTailRowid,
            SEGMENT_MESSAGES,
          ) as unknown as Array<{
          id: string;
          time_created: number;
          time_updated: number;
          data: string;
          r: number;
        }>;
        if (rows.length === 0) {
          task.status = "done";
          saveTasks(loadTasks());
          continue;
        }
        const ordered = [...rows].reverse();
        const count = ordered.length;
        const startSeq = task.nextLowerSeq - count + 1;
        db.exec("begin immediate");
        try {
          const insertMessage = db.prepare(
            "insert into message (id, session_id, time_created, time_updated, data, sequence) " +
              "values (?, ?, ?, ?, ?, ?)",
          );
          const insertPart = db.prepare(
            "insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) " +
              "values (?, ?, ?, ?, ?, ?, ?)",
          );
          let seq = startSeq;
          for (const row of ordered) {
            const newId = `msg_zgk_${randomUUID()}`;
            insertMessage.run(newId, task.childSessionId, row.time_created, row.time_updated, row.data, seq);
            const parts = db
              .prepare(
                "select id, time_created, time_updated, data, sequence from part " +
                  "where session_id = ? and message_id = ? order by sequence",
              )
              .all(task.originalSessionId, row.id) as unknown as Array<{
              id: string;
              time_created: number;
              time_updated: number;
              data: string;
              sequence: number;
            }>;
            for (const part of parts) {
              insertPart.run(
                `part_zgk_${randomUUID()}`,
                task.childSessionId,
                newId,
                part.time_created,
                part.time_updated,
                part.data,
                part.sequence,
              );
            }
            seq += 1;
          }
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
        task.lastSRowid = rows[rows.length - 1]!.r;
        task.nextLowerSeq = startSeq;
        task.injected += count;
        const remaining = db
          .prepare(
            "select count(*) as c from message where session_id = ? and rowid < ? " +
              "and not (rowid >= ? and rowid <= ?)",
          )
          .get(
            task.originalSessionId,
            task.lastSRowid,
            task.preservedHeadRowid,
            task.preservedTailRowid,
          ) as unknown as { c: number };
        if (remaining.c === 0) task.status = "done";
        saveTasks(loadTasks());
        log("hover fork 全量补齐推进", {
          childSessionId: task.childSessionId,
          inserted: count,
          injectedTotal: task.injected,
          boundaryTotal: task.boundaryTotal,
          done: task.status === "done",
        });
      } catch (error) {
        log("hover fork 全量补齐段推进异常", {
          childSessionId: task.childSessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    db.close();
  }
}

/** 启动后台推进（app 生命周期内常驻；unref 不拖退出）。重复调用幂等。 */
export function startZcodeGoForkFullHistoryWorker(
  log: (message: string, meta?: unknown) => void,
): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => tick(log), WORKER_INTERVAL_MS);
  workerTimer.unref?.();
}
