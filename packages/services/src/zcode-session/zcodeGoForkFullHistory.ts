/**
 * zcode-go：hover fork 全量历史的分段倒序补齐（用户定稿的流式 fork）。
 *
 * 交互模型（用户定稿）：
 *   - forkAssistant 瞬间完成"压缩边界后内容"（官方全量复制 F，快）→ child
 *     立即可用可发消息（新消息照常追加，与 silent fork 同款不阻塞）；
 *   - 边界前的更早历史由后台**倒序分段**补进 child（从边界往前一段段），
 *     提前关闭后重启仍继续（任务状态持久化 ~/.zcode-go/，非官方 DB）；
 *   - 聊天历史查询（rowsRange 懒加载/模型工具查历史）遇未完成任务必须
 *     **同步推进剩余全部**再放行——杜绝"假到顶"；
 *   - 状态只落 ~/.zcode-go/ 文件，不动官方 DB 表格式（只用 message/part）。
 *
 * 并发：host（rowsRange 触发同步推进）与 main（周期 worker）可能同时推进
 * 同一任务——每段推进是单个 begin immediate 事务，游标（lastSRowid）在事务
 * 内按 DB 实际状态推导，天然串行安全。child 的注入段 sequence 由任务内
 * nextLowerSeq 递减分配（事务内独占推进时无冲突；跨推进器由事务串行化兜底）。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SEGMENT_MESSAGES = 500;
const STATE_VERSION = 1;

export interface ForkFullHistoryTask {
  childSessionId: string;
  originalSessionId: string;
  status: "pending" | "done";
  /** S 侧游标：下次从此 rowid 往前（更早）取段 */
  lastSRowid: number;
  /** preservedSegment 的 rowid 区间（child 已有，注入跳过但游标越过） */
  preservedHeadRowid: number;
  preservedTailRowid: number;
  /** boundary 消息在 S 的 rowid（注入起点从它往前） */
  boundaryRowid: number;
  /** S 边界前非 preserved 总条数 */
  boundaryTotal: number;
  injected: number;
  /** child 下一注入段的 sequence 上界（递减分配，紧贴第一阶段尾） */
  nextLowerSeq: number;
  updatedAt: number;
}

interface ForkFullHistoryState {
  version: number;
  tasks: ForkFullHistoryTask[];
}

function stateDir(): string {
  return process.env.ZCODE_GO_STATE_DIR_OVERRIDE || `${process.env.HOME || ""}/.zcode-go`;
}

function statePath(): string {
  return `${stateDir()}/fork-fullhistory-tasks.json`;
}

export function sessionDbPathForForkEnrich(): string {
  const base = process.env.ZCODE_DATA_BASE_DIR?.trim() || process.env.HOME || "";
  return `${base}/.zcode/cli/db/db.sqlite`;
}

/** host 侧开库入口（getBuiltinModule；等待/推进与模块内共用同一类型面）。 */
export function openForkEnrichDatabase(): EnrichDb {
  return newForkEnrichDatabase();
}

function newForkEnrichDatabase(): EnrichDb {
  const sqlite = (
    process as unknown as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule?.("node:sqlite") as
    | { DatabaseSync: new (path: string, options?: { timeout?: number }) => EnrichDb }
    | undefined;
  if (!sqlite) throw new Error("node:sqlite unavailable in this runtime");
  return new sqlite.DatabaseSync(sessionDbPathForForkEnrich(), { timeout: 10_000 });
}

function loadState(): ForkFullHistoryState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<ForkFullHistoryState>;
    if (raw.version === STATE_VERSION && Array.isArray(raw.tasks)) {
      return { version: STATE_VERSION, tasks: raw.tasks as ForkFullHistoryTask[] };
    }
  } catch {
    /* 首次/损坏：空态 */
  }
  return { version: STATE_VERSION, tasks: [] };
}

function saveState(state: ForkFullHistoryState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 1), "utf8");
}

export function getForkFullHistoryTask(childSessionId: string): ForkFullHistoryTask | null {
  return loadState().tasks.find((t) => t.childSessionId === childSessionId) ?? null;
}

export function listPendingForkFullHistoryTasks(): ForkFullHistoryTask[] {
  return loadState().tasks.filter((t) => t.status === "pending");
}

/** forkAssistant ack 后登记任务（第一阶段=边界后内容已完成）。 */
export function registerForkFullHistoryTask(params: {
  childSessionId: string;
  originalSessionId: string;
  lastSRowid: number;
  preservedHeadRowid: number;
  preservedTailRowid: number;
  boundaryRowid: number;
  boundaryTotal: number;
  nextLowerSeq: number;
}): ForkFullHistoryTask {
  const state = loadState();
  const existing = state.tasks.find((t) => t.childSessionId === params.childSessionId);
  if (existing) return existing;
  const task: ForkFullHistoryTask = {
    ...params,
    status: "pending",
    injected: 0,
    updatedAt: Date.now(),
  };
  state.tasks.push(task);
  saveState(state);
  return task;
}

function updateTask(task: ForkFullHistoryTask): void {
  const state = loadState();
  const i = state.tasks.findIndex((t) => t.childSessionId === task.childSessionId);
  if (i >= 0) state.tasks[i] = { ...task, updatedAt: Date.now() };
  saveState(state);
}

// 参数用宽松形态：node:sqlite 的 get/all 重载与严格 unknown 逆变不兼容
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface EnrichDb {
  prepare: (sql: string) => {
    get: (...args: any[]) => any;
    all: (...args: any[]) => any[];
    run: (...args: any[]) => { changes: number | bigint };
  };
  exec: (sql: string) => void;
  close: () => void;
}

/**
 * 推进一个任务一段（单事务）。返回本段注入条数；0 = 已完成（无更多段）。
 * 游标在事务内按 DB 实际状态推导，多推进器并发安全。
 */
export function advanceForkFullHistorySegment(task: ForkFullHistoryTask, db: EnrichDb): number {
  if (task.status === "done") return 0;
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
    updateTask(task);
    return 0;
  }
  const ordered = [...rows].reverse(); // rowid 倒序取段 → 正序插入
  const count = ordered.length;
  // sequence 分配按事务内实态：child 当前 min <= count 时整体平移让位，注入段
  // 恒占 1..count。并发推进器（host rowsRange / main worker）下快照 nextLowerSeq
  // 会重叠——事务内重查实态才是并发安全的分层。
  db.exec("begin immediate");
  let startSeq = 1;
  try {
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
    startSeq = 1;
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
  // 游标 = 本段最小 rowid（rows 为倒序，末位即最老——继续往前 scan 的起点）
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
  updateTask(task);
  return count;
}

/**
 * 同步推进到完成（rowsRange/历史查询放行前调用）。每段一个事务——与 main
 * 周期 worker 的推进天然互斥；段间 await 让出事件循环，避免 host 单线程饿死。
 */
export async function waitForForkFullHistoryDone(
  childSessionId: string,
  db: EnrichDb,
  options: { timeoutMs?: number } = {},
): Promise<"done" | "absent" | "timeout"> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  for (;;) {
    const task = getForkFullHistoryTask(childSessionId);
    if (!task) return "absent";
    if (task.status === "done") return "done";
    if (Date.now() > deadline) return "timeout";
    advanceForkFullHistorySegment(task, db);
    await new Promise((r) => setTimeout(r, 0));
    if (getForkFullHistoryTask(childSessionId)?.status === "done") return "done";
    if (Date.now() > deadline) return "timeout";
  }
}

/** 任务登记时的边界信息采集（S 侧 boundary/preserved/游标/总量/child 尾序）。 */
export function collectForkFullHistoryParams(
  originalSessionId: string,
  childSessionId: string,
): {
  ok: boolean;
  error?: string;
  params?: {
    lastSRowid: number;
    preservedHeadRowid: number;
    preservedTailRowid: number;
    boundaryRowid: number;
    boundaryTotal: number;
    nextLowerSeq: number;
  };
} {
  if (!existsSync(sessionDbPathForForkEnrich())) return { ok: false, error: "session db missing" };
  const db = newForkEnrichDatabase();
  try {
    const compactionParts = db
      .prepare(
        "select m.rowid as mrow, p.data as data, m.sequence as seq " +
          "from part p join message m on m.id = p.message_id and m.session_id = p.session_id " +
          "where p.session_id = ? and p.data like '{\"type\":\"compaction\"%' " +
          "order by m.sequence desc",
      )
      .all(originalSessionId) as unknown as Array<{
      mrow: number;
      data: string;
      seq: number;
    }>;
    let boundarySeq = -1;
    let boundaryRowid = 0;
    let preservedHead: string | undefined;
    let preservedTail: string | undefined;
    for (const part of compactionParts) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(part.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (payload.compactBoundary !== undefined || payload.timelineStatus === undefined) {
        boundarySeq = part.seq;
        // 游标基准 = boundary 所属 message 的 rowid（message 表空间，与注入
        // 查询同表同空间；part 的 rowid 是另一空间，不能混用）
        boundaryRowid = part.mrow;
        const boundary = payload.compactBoundary as
          | { preservedSegment?: { headMessageId?: string; tailMessageId?: string } }
          | undefined;
        preservedHead = boundary?.preservedSegment?.headMessageId;
        preservedTail = boundary?.preservedSegment?.tailMessageId;
        break;
      }
    }
    if (boundarySeq < 0) {
      // S 无边界 → child（F 的全量复制）内容已全，无需任务
      return { ok: false, error: "no compaction boundary in original session" };
    }
    const headRow = preservedHead
      ? (db
          .prepare("select rowid as r from message where session_id = ? and id = ?")
          .get(originalSessionId, preservedHead) as unknown as { r: number } | undefined)
      : undefined;
    const tailRow = preservedTail
      ? (db
          .prepare("select rowid as r from message where session_id = ? and id = ?")
          .get(originalSessionId, preservedTail) as unknown as { r: number } | undefined)
      : undefined;
    const preservedHeadRowid = headRow?.r ?? 0;
    const preservedTailRowid = tailRow?.r ?? 0;
    const boundaryTotal = db
      .prepare(
        "select count(*) as c from message where session_id = ? and rowid < ? " +
          "and not (rowid >= ? and rowid <= ?)",
      )
      .get(originalSessionId, boundaryRowid, preservedHeadRowid, preservedTailRowid) as unknown as {
      c: number;
    };
    const childMin = db
      .prepare("select min(sequence) as s from message where session_id = ?")
      .get(childSessionId) as unknown as { s: number | null };
    return {
      ok: true,
      params: {
        lastSRowid: boundaryRowid,
        preservedHeadRowid,
        preservedTailRowid,
        boundaryRowid,
        boundaryTotal: boundaryTotal.c,
        nextLowerSeq: (childMin?.s ?? 1) - 1,
      },
    };
  } finally {
    db.close();
  }
}
