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
import { createHash } from "node:crypto";
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

function sha24(v: string): string {
  return createHash("sha1").update(v).digest("hex").slice(0, 24);
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
        // —— 与 services advanceForkFullHistorySegment 同款（事务内选择段 +
        //    确定性派生 id + OR IGNORE：双推进器并发幂等）——
        db.exec("begin immediate");
        let inserted = 0;
        let lastSRowid = task.lastSRowid;
        try {
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
            db.exec("commit");
            continue;
          }
          const ordered = [...rows].reverse();
          const count = ordered.length;
          const childMinRow = db
            .prepare("select min(sequence) as s from message where session_id = ?")
            .get(task.childSessionId) as unknown as { s: number | null };
          const childMin = childMinRow?.s;
          if (childMin !== null && childMin !== undefined && childMin <= count) {
            db.prepare("update message set sequence = sequence + ? where session_id = ?").run(
              count,
              task.childSessionId,
            );
          }
          const insertMessage = db.prepare(
            "insert or ignore into message (id, session_id, time_created, time_updated, data, sequence) " +
              "values (?, ?, ?, ?, ?, ?)",
          );
          const insertPart = db.prepare(
            "insert or ignore into part (id, session_id, message_id, time_created, time_updated, data, sequence) " +
              "values (?, ?, ?, ?, ?, ?, ?)",
          );
          let seq = 1;
          for (const row of ordered) {
            const newId = `msg_zgk_fb_${sha24(row.id)}`;
            const insertedRow = insertMessage.run(newId, task.childSessionId, row.time_created, row.time_updated, row.data, seq) as unknown as { changes: number | bigint };
            if (Number(insertedRow.changes) > 0) inserted += 1;
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
                `part_zgk_fb_${sha24(part.id)}`,
                task.childSessionId,
                newId,
                part.time_created,
                part.time_updated,
                part.data,
                part.sequence,
              );
            }
            lastSRowid = row.r;
            seq += 1;
          }
          task.lastSRowid = lastSRowid;
          task.injected += inserted;
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

// ── hover fork（direct 流程）登记 + 立即连续补齐 ────────────────────────────

/**
 * 从 parent（原会话）采集边界信息并登记 child 的全量补齐任务。
 * 边界判定与 forkCompactSessionDirect/forkTrim 同款（最后一个活跃压缩边界）。
 * 返回 null = parent 无压缩边界（child 内容已全，无需任务）。
 */
export function registerForkFullHistoryFromParent(
  parentSessionId: string,
  childSessionId: string,
): ForkFullHistoryTask | null {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(
    `${process.env.ZCODE_DATA_BASE_DIR?.trim() || process.env.HOME || ""}/.zcode/cli/db/db.sqlite`,
    { timeout: 10_000 },
  );
  try {
    const compactionParts = db
      .prepare(
        "select m.rowid as mrow, p.data as data, m.sequence as seq " +
          "from part p join message m on m.id = p.message_id and m.session_id = p.session_id " +
          "where p.session_id = ? and p.data like '{\"type\":\"compaction\"%' " +
          "order by m.sequence desc",
      )
      .all(parentSessionId) as unknown as Array<{
      mrow: number;
      data: string;
      seq: number;
    }>;
    let boundaryRowid = 0;
    let preservedHead: string | undefined;
    let preservedTail: string | undefined;
    let hasBoundary = false;
    for (const part of compactionParts) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(part.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (payload.compactBoundary !== undefined || payload.timelineStatus === undefined) {
        hasBoundary = true;
        boundaryRowid = part.mrow;
        const boundary = payload.compactBoundary as
          | { preservedSegment?: { headMessageId?: string; tailMessageId?: string } }
          | undefined;
        preservedHead = boundary?.preservedSegment?.headMessageId;
        preservedTail = boundary?.preservedSegment?.tailMessageId;
        break;
      }
    }
    if (!hasBoundary) return null;
    const headRow = preservedHead
      ? (db
          .prepare("select rowid as r from message where session_id = ? and id = ?")
          .get(parentSessionId, preservedHead) as unknown as { r: number } | undefined)
      : undefined;
    const tailRow = preservedTail
      ? (db
          .prepare("select rowid as r from message where session_id = ? and id = ?")
          .get(parentSessionId, preservedTail) as unknown as { r: number } | undefined)
      : undefined;
    const preservedHeadRowid = headRow?.r ?? 0;
    const preservedTailRowid = tailRow?.r ?? 0;
    const boundaryTotal = db
      .prepare(
        "select count(*) as c from message where session_id = ? and rowid < ? " +
          "and not (rowid >= ? and rowid <= ?)",
      )
      .get(parentSessionId, boundaryRowid, preservedHeadRowid, preservedTailRowid) as unknown as {
      c: number;
    };
    const childMin = db
      .prepare("select min(sequence) as s from message where session_id = ?")
      .get(childSessionId) as unknown as { s: number | null };
    return registerForkFullHistoryTask({
      childSessionId,
      originalSessionId: parentSessionId,
      lastSRowid: boundaryRowid,
      preservedHeadRowid,
      preservedTailRowid,
      boundaryRowid,
      boundaryTotal: boundaryTotal.c,
      nextLowerSeq: (childMin?.s ?? 1) - 1,
    });
  } finally {
    db.close();
  }
}

/**
 * 立即连续补齐到完成（fork 落地后调用——"从 fork 开始就持续往前补"，段间
 * setImmediate 让出事件循环；与周期 worker/rowsRange 推进靠单事务互斥）。
 * 提前关闭：剩余段由重启后的周期 worker 续推。
 */
export function runContinuousForkFullHistoryBackfill(
  childSessionId: string,
  log: (message: string, meta?: unknown) => void,
): void {
  void (async () => {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(
      `${process.env.ZCODE_DATA_BASE_DIR?.trim() || process.env.HOME || ""}/.zcode/cli/db/db.sqlite`,
      { timeout: 10_000 },
    );
    try {
      for (;;) {
        const task = loadTasks().find((t) => t.childSessionId === childSessionId);
        if (!task || task.status === "done") return;
        // 同步段推进（单事务）；段间让出事件循环
        const advance = (): number => {
          const t = loadTasks().find((x) => x.childSessionId === childSessionId);
          if (!t || t.status === "done") return 0;
          // 段选择必须在事务内 + 确定性派生 id + OR IGNORE（与 services
          // advanceForkFullHistorySegment 同款——双推进器并发幂等）
          db.exec("begin immediate");
          let inserted = 0;
          let lastSRowid = t.lastSRowid;
          try {
            const rows = db
              .prepare(
                "select id, time_created, time_updated, data, rowid as r from message " +
                  "where session_id = ? and rowid < ? " +
                  "and not (rowid >= ? and rowid <= ?) " +
                  "order by rowid desc limit ?",
              )
              .all(
                t.originalSessionId,
                t.lastSRowid,
                t.preservedHeadRowid,
                t.preservedTailRowid,
                SEGMENT_MESSAGES,
              ) as unknown as Array<{
              id: string;
              time_created: number;
              time_updated: number;
              data: string;
              r: number;
            }>;
            if (rows.length === 0) {
              t.status = "done";
              saveTasks(loadTasks());
              db.exec("commit");
              return 0;
            }
            const ordered = [...rows].reverse();
            const count = ordered.length;
            const childMinRow = db
              .prepare("select min(sequence) as s from message where session_id = ?")
              .get(t.childSessionId) as unknown as { s: number | null };
            const childMin = childMinRow?.s;
            if (childMin !== null && childMin !== undefined && childMin <= count) {
              db.prepare("update message set sequence = sequence + ? where session_id = ?").run(
                count,
                t.childSessionId,
              );
            }
            const insertMessage = db.prepare(
              "insert or ignore into message (id, session_id, time_created, time_updated, data, sequence) " +
                "values (?, ?, ?, ?, ?, ?)",
            );
            const insertPart = db.prepare(
              "insert or ignore into part (id, session_id, message_id, time_created, time_updated, data, sequence) " +
                "values (?, ?, ?, ?, ?, ?, ?)",
            );
            let seq = 1;
            for (const row of ordered) {
              const newId = `msg_zgk_fb_${sha24(row.id)}`;
              const insertedRow = insertMessage.run(newId, t.childSessionId, row.time_created, row.time_updated, row.data, seq) as unknown as { changes: number | bigint };
              if (Number(insertedRow.changes) > 0) inserted += 1;
              const parts = db
                .prepare(
                  "select id, time_created, time_updated, data, sequence from part " +
                    "where session_id = ? and message_id = ? order by sequence",
                )
                .all(t.originalSessionId, row.id) as unknown as Array<{
                id: string;
                time_created: number;
                time_updated: number;
                data: string;
                sequence: number;
              }>;
              for (const part of parts) {
                insertPart.run(
                  `part_zgk_fb_${sha24(part.id)}`,
                  t.childSessionId,
                  newId,
                  part.time_created,
                  part.time_updated,
                  part.data,
                  part.sequence,
                );
              }
              lastSRowid = row.r;
              seq += 1;
            }
            t.lastSRowid = lastSRowid;
            t.injected += inserted;
            db.exec("commit");
          } catch (error) {
            db.exec("rollback");
            throw error;
          }
          const remaining = db
            .prepare(
              "select count(*) as c from message where session_id = ? and rowid < ? " +
                "and not (rowid >= ? and rowid <= ?)",
            )
            .get(
              t.originalSessionId,
              t.lastSRowid,
              t.preservedHeadRowid,
              t.preservedTailRowid,
            ) as unknown as { c: number };
          if (remaining.c === 0) t.status = "done";
          saveTasks(loadTasks());
          return count;
        };
        const inserted = advance();
        if (inserted > 0) {
          log("hover fork 全量补齐推进", {
            childSessionId,
            inserted,
            done: loadTasks().find((x) => x.childSessionId === childSessionId)?.status === "done",
          });
        }
        if (inserted === 0) return;
        await new Promise((r) => setImmediate(r));
      }
    } catch (error) {
      log("hover fork 连续补齐异常（周期 worker/查询触发续推）", {
        childSessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      db.close();
    }
  })();
}
