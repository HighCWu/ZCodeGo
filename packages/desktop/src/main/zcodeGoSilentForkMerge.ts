/**
 * zcode-go 静默 fork 第三批：双向归并 worker（main 进程）。
 *
 * redirect 建立后，原会话 S 冻结为完整档案（所有发送经 map 寻址到隐形子会话 S'，
 * 模型与 UI 全程在 S' 上工作）。本 worker 周期性做两个方向的补齐：
 *
 * 1. 迟到注入（S 观察者）：fork 快照（parentMaxMessageRowid）之后落进 S 的行
 *    ——quiescence 门控收不掉的后台写入（bg bash 输出等）——按原样 id 注入 S'
 *    尾部。原样 id 使注入行随后被方向 2 归并回 S 时天然幂等跳过（同 id 已在 S）。
 *    S 已冻结无删除，rowid 单调，水位线安全；注入按 part 粒度补齐（消息先到、
 *    part 持续追加的后台流不丢尾）。
 * 2. 增量归并（S' → S）：fork 复制前缀之后的 S' 新行整消息复制回 S（id 原样 +
 *    sequence 续排），S 持续保有完整历史；下次轮换（batch 4）删除旧 fork 无损。
 *    前缀排除不用 rowid 水位线——S' 是活会话，用户 rewind 删行后 rowid 会回退
 *    复用；改用结构判据：fork 复制行 id 一律带 msg_zgk_ 前缀（zcodeGoDirectFork
 *    生成），活行天然没有。活行筛 id 不在 S（幂等，崩溃重跑安全）。
 *
 * 常态 pass 只扫内存 rowid 提示之后的新行（近零成本）；每 N 次 pass 做一次全量
 * 兜底扫描，捕获 rewind 造成的 rowid 回退行。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ZcodeGoSessionRedirectEntry } from "@zcode/services/node";
import { listZcodeGoSessionRedirects } from "@zcode/services/node";

type SqliteDb = {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
};

function loadSqlite(): {
  DatabaseSync: new (path: string, options?: { timeout?: number }) => SqliteDb;
} {
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

export interface ZcodeGoSilentForkMergePassResult {
  entries: number;
  injectedMessages: number;
  mergedMessages: number;
}

interface MessageRow {
  rowid: number;
  id: string;
  time_created: number;
  time_updated: number;
  data: string;
  sequence: number | null;
}

interface PartRow {
  id: string;
  message_id: string;
  data: string;
  time_created: number;
  time_updated: number;
  sequence: number | null;
}

function insertChanges(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0;
}

/**
 * 方向 1：迟到注入（S → S'）。S 冻结无删除，rowid > 快照水位线即迟到行。
 *
 * 每次都从 entry.parentMaxMessageRowid（不可变）全量扫迟到集：S 冻结，迟到集
 * 有界（通常 0~少数几行），不做内存水位推进——推进会漏掉「消息先到、part 持续
 * 追加」的流式行（其 message rowid 不再前进）。
 *
 * message/part 的 id 是库内全局主键——原样 id 注入会与 S 里既有的行冲突；
 * 注入行用确定性派生 id（msg_zgk_inj_<原id> / part_zgk_inj_<原id>）：
 * - 幂等：重跑同一条目命中同 id，INSERT OR IGNORE 天然去重（含 part 粒度补齐）；
 * - 方向 2 归并按 msg_zgk_ 前缀排除注入行（其内容本就来自 S，回流即重复）；
 * - 迟到批次内的 parentID 链按派生 id 改写，跨批引用按「存在于 S' 则保留，
 *   否则置空」——与 direct fork 的裁剪容错同口径。
 */
function injectLateWrites(
  sessionDb: SqliteDb,
  S: string,
  F: string,
  entry: ZcodeGoSessionRedirectEntry,
  log: (message: string, meta?: unknown) => void,
): { injectedMessages: number; injectedParts: number } {
  if (typeof entry.parentMaxMessageRowid !== "number") return { injectedMessages: 0, injectedParts: 0 };
  const watermark = entry.parentMaxMessageRowid;

  // 排除 msg_zgk_ 前缀：方向 2 归并回 S 的行 rowid 也在水位线之后，不排除会
  // 形成「归并 → 误判迟到 → 注入回 S'」的内容复制循环。
  const lateRows = sessionDb
    .prepare(
      "select rowid, id, time_created, time_updated, data, sequence from message " +
        "where session_id = ? and rowid > ? and id not like 'msg\\_zgk\\_%' escape '\\' " +
        "order by rowid",
    )
    .all(S, watermark) as unknown as MessageRow[];
  if (lateRows.length === 0) return { injectedMessages: 0, injectedParts: 0 };

  // 迟到批次的确定性 id 映射（先看全部迟到行，跨消息 parentID 链可改写）
  const idMap = new Map<string, string>();
  for (const row of lateRows) idMap.set(row.id, `msg_zgk_inj_${row.id}`);

  const forkIds = new Set(
    (
      sessionDb.prepare("select id from message where session_id = ?").all(F) as unknown as Array<{
        id: unknown;
      }>
    ).map((row) => String(row.id)),
  );
  for (const mapped of idMap.values()) forkIds.add(mapped);
  const maxSeq =
    ((sessionDb
      .prepare("select max(sequence) as m from message where session_id = ?")
      .get(F) as { m: number | null } | undefined)?.m ?? 0) || 0;
  const insertMessage = sessionDb.prepare(
    "insert or ignore into message (id, session_id, time_created, time_updated, data, sequence) " +
      "values (?, ?, ?, ?, ?, ?)",
  );
  const insertPart = sessionDb.prepare(
    "insert or ignore into part (id, session_id, message_id, time_created, time_updated, data, sequence) " +
      "values (?, ?, ?, ?, ?, ?, ?)",
  );
  const selectParts = sessionDb.prepare(
    "select id, message_id, data, time_created, time_updated, sequence from part " +
      "where session_id = ? and message_id = ? order by sequence, rowid",
  );
  /** 迟到行的 data：parentID 批内改写 / 存在保留 / 悬空置空。 */
  const remapLateData = (data: string): string => {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (typeof parsed.parentID === "string") {
        const mapped = idMap.get(parsed.parentID);
        if (mapped) parsed.parentID = mapped;
        else if (!forkIds.has(parsed.parentID)) delete parsed.parentID;
        else return JSON.stringify(parsed);
      }
      return JSON.stringify(parsed);
    } catch {
      return data;
    }
  };

  let injectedMessages = 0;
  let injectedParts = 0;
  let seq = maxSeq;
  sessionDb.exec("begin immediate");
  try {
    for (const row of lateRows) {
      const targetId = idMap.get(row.id)!;
      seq += 1;
      if (insertChanges(insertMessage.run(targetId, F, row.time_created, row.time_updated, remapLateData(row.data), seq)) > 0) {
        injectedMessages += 1;
      }
      // part 粒度补齐：消息先到、part 持续追加的后台流不丢尾（确定性 part id 幂等）
      for (const part of selectParts.all(S, row.id) as unknown as PartRow[]) {
        if (insertChanges(insertPart.run(`part_zgk_inj_${part.id}`, F, targetId, part.time_created, part.time_updated, part.data, part.sequence)) > 0) {
          injectedParts += 1;
        }
      }
    }
    sessionDb.exec("commit");
  } catch (error) {
    try {
      sessionDb.exec("rollback");
    } catch {
      /* 尽力而为 */
    }
    log("迟到注入失败（下轮重试）", {
      original: S,
      message: error instanceof Error ? error.message : String(error),
    });
    return { injectedMessages: 0, injectedParts: 0 };
  }
  if (injectedMessages > 0 || injectedParts > 0) {
    log("迟到写入已注入隐形子会话", { original: S, fork: F, injectedMessages, injectedParts });
  }
  return { injectedMessages, injectedParts };
}

/**
 * 方向 2：增量归并（S' → S）。候选 = 非复制/注入前缀（id 无 msg_zgk_ 前缀——
 * 排除 fork 复制行与迟到注入行，它们的内容本就源自 S）且派生目标 id
 * （msg_zgk_mb_<原id>）不在 S 的行。
 *
 * 归并行同样用确定性派生 id：message.id 是库内全局主键，原样 id 会与 S' 里的
 * 源行冲突；派生 id 使重跑幂等（INSERT OR IGNORE），rewind 后 S' 的新行换新
 * 原id → 新派生id，与档案里已归并的旧行互不冲突。
 * 常态 pass 只扫内存 rowid 提示之后的新行；每 N 次 pass 全量兜底一次，捕获
 * rewind 删行后 rowid 回退复用的活行。
 */
function mergeBackNewWrites(
  sessionDb: SqliteDb,
  S: string,
  F: string,
  rowidHint: number,
  fullScan: boolean,
  log: (message: string, meta?: unknown) => void,
): { mergedMessages: number; mergedParts: number; lastRowid: number } {
  // 幂等判据用派生目标 id，不用源 id（源行永远在 S'，查它会恒真）
  const notMergedExpr =
    "not exists (select 1 from message s where s.id = 'msg_zgk_mb_' || message.id and s.session_id = ?) ";
  const baseSelect =
    "select rowid, id, time_created, time_updated, data, sequence from message " +
    "where session_id = ? and id not like 'msg\\_zgk\\_%' escape '\\' " +
    "and " +
    notMergedExpr;
  const rows = (
    fullScan
      ? sessionDb.prepare(baseSelect + "order by rowid").all(F, S)
      : sessionDb
          .prepare(baseSelect + "and rowid > ? order by rowid")
          .all(F, S, rowidHint)
  ) as unknown as MessageRow[];
  if (rows.length === 0) return { mergedMessages: 0, mergedParts: 0, lastRowid: rowidHint };

  // 批次 id 映射（parentID 链改写）+ S 既有 id 集（跨批引用存在则保留）
  const idMap = new Map<string, string>();
  for (const row of rows) idMap.set(row.id, `msg_zgk_mb_${row.id}`);
  const originalIds = new Set(
    (
      sessionDb.prepare("select id from message where session_id = ?").all(S) as unknown as Array<{
        id: unknown;
      }>
    ).map((row) => String(row.id)),
  );
  for (const mapped of idMap.values()) originalIds.add(mapped);
  const maxSeq =
    ((sessionDb
      .prepare("select max(sequence) as m from message where session_id = ?")
      .get(S) as { m: number | null } | undefined)?.m ?? 0) || 0;
  const insertMessage = sessionDb.prepare(
    "insert or ignore into message (id, session_id, time_created, time_updated, data, sequence) " +
      "values (?, ?, ?, ?, ?, ?)",
  );
  const insertPart = sessionDb.prepare(
    "insert or ignore into part (id, session_id, message_id, time_created, time_updated, data, sequence) " +
      "values (?, ?, ?, ?, ?, ?, ?)",
  );
  const selectParts = sessionDb.prepare(
    "select id, message_id, data, time_created, time_updated, sequence from part " +
      "where session_id = ? and message_id = ? order by sequence, rowid",
  );
  /** 归并行 data：parentID 批内改写 / S 存在保留 / 悬空置空（档案局部一致）。 */
  const remapMergedData = (data: string): string => {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (typeof parsed.parentID === "string") {
        const mapped = idMap.get(parsed.parentID);
        if (mapped) parsed.parentID = mapped;
        else if (!originalIds.has(parsed.parentID)) delete parsed.parentID;
      }
      return JSON.stringify(parsed);
    } catch {
      return data;
    }
  };

  let mergedMessages = 0;
  let mergedParts = 0;
  let seq = maxSeq;
  sessionDb.exec("begin immediate");
  try {
    for (const row of rows) {
      const targetId = idMap.get(row.id)!;
      seq += 1;
      if (
        insertChanges(
          insertMessage.run(
            targetId,
            S,
            row.time_created,
            row.time_updated,
            remapMergedData(row.data),
            seq,
          ),
        ) > 0
      ) {
        mergedMessages += 1;
      }
      // part 粒度补齐（确定性 part id 幂等；归并行按序续排 part 序列）
      let partSeq = 0;
      for (const part of selectParts.all(F, row.id) as unknown as PartRow[]) {
        partSeq += 1;
        if (
          insertChanges(
            insertPart.run(
              `part_zgk_mb_${part.id}`,
              S,
              targetId,
              part.time_created,
              part.time_updated,
              part.data,
              partSeq,
            ),
          ) > 0
        ) {
          mergedParts += 1;
        }
      }
    }
    sessionDb.exec("commit");
  } catch (error) {
    try {
      sessionDb.exec("rollback");
    } catch {
      /* 尽力而为 */
    }
    log("增量归并失败（下轮重试）", {
      original: S,
      message: error instanceof Error ? error.message : String(error),
    });
    return { mergedMessages: 0, mergedParts: 0, lastRowid: rowidHint };
  }
  if (mergedMessages > 0 || mergedParts > 0) {
    log("隐形子会话增量已归并回原会话", { original: S, fork: F, mergedMessages, mergedParts });
  }
  const lastRow = rows[rows.length - 1];
  return {
    mergedMessages,
    mergedParts,
    lastRowid: lastRow ? Math.max(rowidHint, lastRow.rowid) : rowidHint,
  };
}

/** 单条目双向补齐（导出供测试）。 */
export function syncZcodeGoSilentForkEntry(input: {
  sessionDb: SqliteDb;
  originalSessionId: string;
  entry: ZcodeGoSessionRedirectEntry;
  mergeRowidHint?: number;
  fullScan?: boolean;
  log?: (message: string, meta?: unknown) => void;
}): {
  injectedMessages: number;
  mergedMessages: number;
  mergeRowidHint: number;
} {
  const log = input.log ?? (() => {});
  const S = input.originalSessionId;
  const F = input.entry.forkSessionId;
  const mergeRowidHint = input.mergeRowidHint ?? 0;

  const inject = injectLateWrites(input.sessionDb, S, F, input.entry, log);
  const merge = mergeBackNewWrites(
    input.sessionDb,
    S,
    F,
    mergeRowidHint,
    input.fullScan ?? false,
    log,
  );
  return {
    injectedMessages: inject.injectedMessages,
    mergedMessages: merge.mergedMessages,
    mergeRowidHint: merge.lastRowid,
  };
}

/** 进程内 per-条目扫描提示与全量兜底计数（崩溃重启从 entry 水位线重来）。 */
const entryState = new Map<string, { mergeRowid: number; passCount: number }>();
const FULL_SCAN_EVERY_N_PASSES = 10;

/** 全表 pass：遍历 redirect map 的每个条目做双向补齐。 */
export function runZcodeGoSilentForkMergePass(input?: {
  sessionDbPath?: string;
  log?: (message: string, meta?: unknown) => void;
}): ZcodeGoSilentForkMergePassResult {
  const log = input?.log ?? (() => {});
  const entries = listZcodeGoSessionRedirects();
  if (entries.length === 0) return { entries: 0, injectedMessages: 0, mergedMessages: 0 };
  const sessionDbPath = input?.sessionDbPath ?? SESSION_DB;
  if (!existsSync(sessionDbPath)) {
    return { entries: entries.length, injectedMessages: 0, mergedMessages: 0 };
  }
  const sqlite = loadSqlite();
  const sessionDb = new sqlite.DatabaseSync(sessionDbPath, { timeout: 10_000 });
  try {
    let injectedMessages = 0;
    let mergedMessages = 0;
    for (const { originalSessionId, entry } of entries) {
      // 条目指向的 fork 会话不存在（被外部清理）→ 跳过（轮换/崩溃恢复另行处理）
      const forkExists = sessionDb.prepare("select 1 from session where id = ?").get(entry.forkSessionId);
      if (!forkExists) continue;
      const state = entryState.get(originalSessionId) ?? { mergeRowid: 0, passCount: 0 };
      const result = syncZcodeGoSilentForkEntry({
        sessionDb,
        originalSessionId,
        entry,
        mergeRowidHint: state.mergeRowid,
        // 每 N 次 pass 全量兜底一次（捕获 rewind 后 rowid 回退复用的活行）
        fullScan: state.passCount % FULL_SCAN_EVERY_N_PASSES === FULL_SCAN_EVERY_N_PASSES - 1,
        log,
      });
      state.mergeRowid = result.mergeRowidHint;
      state.passCount += 1;
      entryState.set(originalSessionId, state);
      injectedMessages += result.injectedMessages;
      mergedMessages += result.mergedMessages;
    }
    return { entries: entries.length, injectedMessages, mergedMessages };
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

export function stopZcodeGoSilentForkMergeWorkerForTest(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  entryState.clear();
}
