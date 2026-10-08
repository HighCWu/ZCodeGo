/**
 * zcode-go「分叉压缩历史会话」直连实现（direct fork）。
 *
 * 与「官方 forkAssistant + 裁剪」二选一：官方 fork 逐字复制全部 transcript
 * （4.3 万消息/14 万 part，分钟级）再靠裁剪瘦身；本实现从会话库直接构造子会话，
 * 只复制模型可见前缀：
 *
 *   保留 = 最后一个活跃压缩边界的摘要消息 + compactBoundary.preservedSegment 区间
 *          （模型上下文的组成部分） + 边界后全部消息 + 各自 part 行
 *
 * 约束与正确性：
 *   - message/part 的 id 是库内全局唯一主键（saveMessage on conflict(id)），子会话
 *     行一律生成新 id，并按 identity map 改写 message.data.parentID 链与 compaction
 *     载荷内的结构化引用（summaryMessageId/preservedSegment.*——仅当被引用 id 在
 *     复制集内；越界引用保留原值，起始处悬空引用经裁剪实测被 hydrator 容忍）。
 *   - 不复制 goal/验证历史（分叉是全新续接）；复制父会话最新 runtime/model_selection
 *     （思考强度随模型选择继承）与 runtime/execution_state（mode 继承——缺失时 CLI
 *     水合上报 mode="default"，会被任务索引读取侧判非法而隐藏子会话）。
 *   - 父会话未被打开（菜单前置条件）→ CLI 对父子均无内存态，直写存储无竞态对象；
 *     子会话在首次订阅时由 CLI 从存储水合。
 *   - 任务索引行同步 upsert（侧栏唯一数据源），fork 完成即可见。
 */
import { randomUUID } from "node:crypto";
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
const TASKS_INDEX_DB = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");

/** 任务索引读取侧 zod 枚举（zcodeTaskMetaSchema.mode）；CLI 内部值 "default" 不在其中。 */
const TASK_INDEX_MODES = new Set(["yolo", "plan", "edit", "auto", "autoEdit", "build"]);

function normalizeTaskIndexMode(mode: string | null | undefined): string {
  return mode && TASK_INDEX_MODES.has(mode) ? mode : "build";
}

export interface DirectForkResult {
  ok: boolean;
  childSessionId: string;
  copiedMessages: number;
  workspacePath?: string;
  /** 快照时刻原会话 message 表 max(rowid)：此后落进原会话的行属「迟到写入」，
   *  由静默 fork 归并 worker 注入子会话（batch 3）。 */
  parentMaxMessageRowid?: number;
  /** fork 写入完成后子会话 message 表 max(rowid)：归并 worker 以此为水位线，
   *  只把此后产生的新行复制回原会话（避开 fork 复制前缀的重复归并）。 */
  childMaxMessageRowid?: number;
  error?: string;
}

/** 与 CLI isActiveCompactionBoundaryPart 同判据。 */
function isActiveCompactionBoundaryPayload(payload: Record<string, unknown>): boolean {
  if (payload.type !== "compaction") return false;
  return payload.compactBoundary !== undefined || payload.timelineStatus === undefined;
}

interface KeptRow {
  id: string;
  sequence: number;
  data: string;
}

/** compaction 载荷里的结构化消息引用字段，按 identity map 改写（仅限映射内的 id）。 */
function remapCompactionPayloadIds(payload: Record<string, unknown>, map: Map<string, string>): void {
  const remap = (value: string): string => map.get(value) ?? value;
  if (typeof payload.summaryMessageId === "string") {
    payload.summaryMessageId = remap(payload.summaryMessageId);
  }
  if (typeof payload.tail_start_id === "string") {
    payload.tail_start_id = remap(payload.tail_start_id);
  }
  const boundary = payload.compactBoundary as
    | {
        summaryMessageId?: string;
        lastSummarizedMessageId?: string;
        summaryMessageIds?: string[];
        preservedSegment?: {
          headMessageId?: string;
          anchorMessageId?: string;
          tailMessageId?: string;
        };
      }
    | undefined;
  if (!boundary) return;
  if (typeof boundary.summaryMessageId === "string") {
    boundary.summaryMessageId = remap(boundary.summaryMessageId);
  }
  if (typeof boundary.lastSummarizedMessageId === "string") {
    boundary.lastSummarizedMessageId = remap(boundary.lastSummarizedMessageId);
  }
  if (Array.isArray(boundary.summaryMessageIds)) {
    boundary.summaryMessageIds = boundary.summaryMessageIds.map((id) => remap(id));
  }
  const segment = boundary.preservedSegment;
  if (segment) {
    if (typeof segment.headMessageId === "string") segment.headMessageId = remap(segment.headMessageId);
    if (typeof segment.anchorMessageId === "string") segment.anchorMessageId = remap(segment.anchorMessageId);
    if (typeof segment.tailMessageId === "string") segment.tailMessageId = remap(segment.tailMessageId);
  }
}

export function forkCompactSessionDirect(input: {
  parentSessionId: string;
  /** 静默 fork：不 upsert 任务索引行（侧栏/搜索不可见，由 redirect map 寻址）。 */
  silent?: boolean;
  /**
   * 轮换防伪（batch 4）：要求父会话存在 time_created 晚于该时刻的活跃压缩边界，
   * 否则返回专用错误 "no fresh compaction boundary"——重放/伪帧触发的空转轮换
   * （整库全拷）由此在事务前拦下。缺省不校验（首个 fork 的边界本就可能很老）。
   */
  requireBoundaryNewerThanMs?: number;
  /**
   * 自动种子 fork（巨会话冷打开）用：要求存在活跃压缩边界——无边界时全量
   * 复制毫无意义，返回专用错误由调用方按良性跳过处理。
   */
  requireActiveBoundary?: boolean;
  /** 测试注入的库路径（缺省用真实共享库）。 */
  sessionDbPath?: string;
  tasksIndexDbPath?: string;
  log?: (message: string, meta?: unknown) => void;
}): DirectForkResult {
  const log = input.log ?? (() => {});
  const startedAt = Date.now();
  const parentSessionId = input.parentSessionId;
  const childSessionId = `sess_${randomUUID()}`;
  const base: DirectForkResult = { ok: false, childSessionId, copiedMessages: 0 };
  const sessionDbPath = input.sessionDbPath ?? SESSION_DB;
  const tasksIndexDbPath = input.tasksIndexDbPath ?? TASKS_INDEX_DB;
  if (!parentSessionId.startsWith("sess_")) return { ...base, error: "invalid session id" };
  // silent 模式不读任务索引（隐形），库缺失判定分开。
  if (!existsSync(sessionDbPath)) return { ...base, error: "session db not found" };
  if (!input.silent && !existsSync(tasksIndexDbPath)) {
    return { ...base, error: "tasks index db not found" };
  }

  let sessionDb: SqliteDb;
  let tasksDb: SqliteDb | undefined;
  try {
    const sqlite = loadSqlite();
    sessionDb = new sqlite.DatabaseSync(sessionDbPath, { timeout: 10_000 });
    if (!input.silent) {
      tasksDb = new sqlite.DatabaseSync(tasksIndexDbPath, { timeout: 10_000 });
    }
  } catch (error) {
    return { ...base, error: `open failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    const parent = sessionDb.prepare("select * from session where id = ?").get(parentSessionId) as
      | Record<string, unknown>
      | undefined;
    if (!parent) return { ...base, error: "parent session not found" };

    // ── 1. 保留集：最后一个活跃压缩边界的摘要 + preservedSegment + 边界后 ──
    // 两段式加载（43k 行会话不整表带 data 入内存）：先 id+sequence 定保留集，
    // 再经 temp 表仅取保留行的 data。temp 表 kept_ids 的生命周期覆盖消息与 part
    // 两次查询，全部取完再 drop。
    const allMessages = sessionDb
      .prepare("select id, sequence from message where session_id = ? order by sequence")
      .all(parentSessionId) as unknown as Array<{ id: string; sequence: number }>;
    const compactionParts = sessionDb
      .prepare(
        "select m.sequence as seq, p.data as data, p.time_created as boundary_time " +
          "from part p join message m on m.id = p.message_id and m.session_id = p.session_id " +
          "where p.session_id = ? and p.data like '{\"type\":\"compaction\"%' " +
          "order by m.sequence desc",
      )
      .all(parentSessionId) as unknown as Array<{ seq: number; data: string; boundary_time: number }>;
    let boundarySeq = -1;
    let preservedHead: string | undefined;
    let preservedTail: string | undefined;
    let boundaryTime = -1;
    for (const part of compactionParts) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(part.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!isActiveCompactionBoundaryPayload(payload)) continue;
      boundarySeq = part.seq;
      boundaryTime = part.boundary_time;
      const boundary = payload.compactBoundary as
        | { preservedSegment?: { headMessageId?: string; tailMessageId?: string } }
        | undefined;
      preservedHead = boundary?.preservedSegment?.headMessageId;
      preservedTail = boundary?.preservedSegment?.tailMessageId;
      break;
    }

    let headSeq = Number.MAX_SAFE_INTEGER;
    let tailSeq = -1;
    if (boundarySeq >= 0) {
      for (const message of allMessages) {
        if (message.id === preservedHead) headSeq = Math.min(headSeq, message.sequence);
        if (message.id === preservedTail) tailSeq = Math.max(tailSeq, message.sequence);
      }
    }
    // 轮换防伪：伪帧/重放触发时父会话没有「晚于当前 redirect 建立」的新边界，
    // 在开事务前拦下（整库全拷的空转轮换毫无意义且撕裂归并水位线）。
    if (
      typeof input.requireBoundaryNewerThanMs === "number" &&
      boundaryTime < input.requireBoundaryNewerThanMs
    ) {
      return { ...base, error: "no fresh compaction boundary" };
    }
    if (input.requireActiveBoundary && boundarySeq < 0) {
      return { ...base, error: "no active compaction boundary" };
    }
    const inPreservedSegment =
      headSeq <= tailSeq
        ? (message: { sequence: number }) => message.sequence >= headSeq && message.sequence <= tailSeq
        : () => false;
    const keptIds: string[] =
      boundarySeq >= 0
        ? allMessages
            .filter(
              (message) => message.sequence >= boundarySeq || inPreservedSegment(message),
            )
            .map((message) => message.id)
        : allMessages.map((message) => message.id);
    if (keptIds.length === 0) return { ...base, error: "no messages to copy" };

    sessionDb.exec("create temp table kept_ids(id text primary key)");
    const insertKept = sessionDb.prepare("insert into kept_ids(id) values (?)");
    for (const id of keptIds) insertKept.run(id);
    const messages = sessionDb
      .prepare(
        "select m.id, m.sequence, m.data from message m join kept_ids k on k.id = m.id " +
          "where m.session_id = ? order by m.sequence",
      )
      .all(parentSessionId) as unknown as KeptRow[];
    const childParts = sessionDb
      .prepare(
        "select p.id, p.message_id, p.data, p.sequence, p.time_created, p.time_updated " +
          "from part p join kept_ids k on k.id = p.message_id " +
          "where p.session_id = ? order by p.sequence",
      )
      .all(parentSessionId) as unknown as Array<{
      id: string;
      message_id: string;
      data: string;
      sequence: number;
      time_created: number;
      time_updated: number;
    }>;
    sessionDb.exec("drop table kept_ids");

    // ── 2. identity map（新 id 一律生成；part id 在写入时生成）──
    const idMap = new Map<string, string>();
    for (const message of messages) idMap.set(message.id, `msg_zgk_${randomUUID()}`);

    sessionDb.exec("begin immediate");
    let parentMaxMessageRowid = 0;
    let childMaxMessageRowid = 0;
    try {
      // 快照水位线：此刻原会话 message 已有的最大 rowid（begin immediate 持写锁，
      // 后续提交的写入 rowid 必然更大——无时钟歧义的迟到判定边界）。
      parentMaxMessageRowid =
        ((sessionDb
          .prepare("select max(rowid) as m from message where session_id = ?")
          .get(parentSessionId) as { m: number | null } | undefined)?.m ?? 0) || 0;
      // ── 3. 子会话行：镜像父行（新 id / parent_id=父 / Fork of 标题 / 现在）──
      sessionDb
        .prepare(
          "insert into session (id, project_id, workspace_id, parent_id, slug, directory, path, title, " +
            "version, permission, time_created, time_updated, task_type, title_source) " +
            "select ?, project_id, workspace_id, ?, " +
            "coalesce(slug, '') || '-fork-' || substr(?,-8), directory, path, ?, version, permission, ?, ?, task_type, title_source " +
            "from session where id = ?",
        )
        .run(
          childSessionId,
          parentSessionId,
          childSessionId,
          `Fork of ${(parent.title as string) ?? ""}`,
          Date.now(),
          Date.now(),
          parentSessionId,
        );

      // ── 4. 消息 + part 复制（新 id / parentID 与 compaction 引用改写 / sequence 重排）──
      const insertMessage = sessionDb.prepare(
        "insert into message (id, session_id, time_created, time_updated, data, sequence) " +
          "values (?, ?, ?, ?, ?, ?)",
      );
      const insertPart = sessionDb.prepare(
        "insert into part (id, session_id, message_id, time_created, time_updated, data, sequence) " +
          "values (?, ?, ?, ?, ?, ?, ?)",
      );
      const partsByOldMessageId = new Map<string, typeof childParts>();
      for (const part of childParts) {
        const list = partsByOldMessageId.get(part.message_id) ?? [];
        list.push(part);
        partsByOldMessageId.set(part.message_id, list);
      }

      const now = Date.now();
      let messageSeq = 0;
      let copiedParts = 0;
      for (const message of messages) {
        const newId = idMap.get(message.id)!;
        let data = message.data;
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (typeof parsed.parentID === "string" && idMap.has(parsed.parentID)) {
            parsed.parentID = idMap.get(parsed.parentID);
            data = JSON.stringify(parsed);
          }
        } catch {
          /* data 非 JSON：原样复制 */
        }
        messageSeq += 1;
        insertMessage.run(newId, childSessionId, now, now, data, messageSeq);

        const oldParts = partsByOldMessageId.get(message.id) ?? [];
        let partSeq = 0;
        for (const part of oldParts) {
          let partData = part.data;
          try {
            const parsed = JSON.parse(partData) as Record<string, unknown>;
            if (parsed.type === "compaction") {
              remapCompactionPayloadIds(parsed, idMap);
              partData = JSON.stringify(parsed);
            }
          } catch {
            /* 非 JSON：原样复制 */
          }
          partSeq += 1;
          insertPart.run(
            `part_zgk_${randomUUID()}`,
            childSessionId,
            newId,
            part.time_created,
            part.time_updated,
            partData,
            partSeq,
          );
        }
        copiedParts += oldParts.length;
      }

      // ── 5. runtime 条目复制（model_selection：思考强度；execution_state：mode）──
      const copyEntry = sessionDb.prepare(
        "insert into session_entry (id, session_id, type, time_created, time_updated, data) " +
          "values (?, ?, ?, ?, ?, ?)",
      );
      const parentModelSelection = sessionDb
        .prepare(
          "select data from session_entry where session_id = ? and type = 'runtime/model_selection' " +
            "order by time_updated desc limit 1",
        )
        .get(parentSessionId) as { data: string } | undefined;
      if (parentModelSelection) {
        copyEntry.run(
          `entry_zgk_${randomUUID()}`,
          childSessionId,
          "runtime/model_selection",
          now,
          now,
          parentModelSelection.data,
        );
      }
      const parentExecutionState = sessionDb
        .prepare(
          "select data from session_entry where session_id = ? and type = 'runtime/execution_state' " +
            "order by time_updated desc limit 1",
        )
        .get(parentSessionId) as { data: string } | undefined;
      // 父会话（非 fork 产物）通常没有 execution_state entry；水合兜底链是
      // 事件流 reduce > permission 列 > execution_state 覆盖。显式落一条合法 mode
      // 的 execution_state，保证 CLI 水合后上报的任务 mode 不会是 "default"
      // （该值会被任务索引读取侧判非法而从侧栏隐藏子会话）。
      let executionStateData = parentExecutionState?.data;
      if (!executionStateData) {
        let permissionMode: string | undefined;
        try {
          const permission = JSON.parse((parent.permission as string) ?? "{}") as { mode?: unknown };
          if (typeof permission.mode === "string") permissionMode = permission.mode;
        } catch {
          /* permission 列非 JSON：走默认 */
        }
        executionStateData = JSON.stringify({
          mode: TASK_INDEX_MODES.has(permissionMode ?? "") ? permissionMode : "build",
          planEnabled: false,
        });
      }
      copyEntry.run(
        `entry_zgk_${randomUUID()}`,
        childSessionId,
        "runtime/execution_state",
        now,
        now,
        executionStateData,
      );
      sessionDb.exec("commit");
      // 归并水位线：fork 复制完的最后一行 rowid（此后新产生的行才会归并回原会话）。
      childMaxMessageRowid =
        ((sessionDb
          .prepare("select max(rowid) as m from message where session_id = ?")
          .get(childSessionId) as { m: number | null } | undefined)?.m ?? 0) || 0;
      log("直连 fork 会话库写入完成", {
        childSessionId,
        copiedMessages: messages.length,
        copiedParts,
        durationMs: Date.now() - startedAt,
      });
    } catch (transactionError) {
      try {
        sessionDb.exec("rollback");
      } catch {
        /* 尽力而为 */
      }
      throw transactionError;
    }

    // ── 6. 任务索引行 upsert（侧栏唯一数据源；行就位后 bump 即可见）──
    // 官方 schema：tasks 以 (workspace_key, task_id) 唯一，on conflict 同键整行更新；
    // workspace 键直接沿用父任务行（与 syncer 写入保持同一身份，避免并行两行）。
    // mode 必须落在读取侧枚举内——CLI 值 "default" 会让行被 zod 判非法而从侧栏消失。
    // silent fork 跳过整段：侧栏/搜索对隐形子会话不可见，由 redirect map 寻址。
    const parentSession = sessionDb
      .prepare("select directory, title from session where id = ?")
      .get(parentSessionId) as { directory: string; title: string } | undefined;
    if (input.silent) {
      log("直连 fork（silent）：跳过任务索引行", { childSessionId });
    } else if (tasksDb)
    try {
      const now = Date.now();
      const childTitle = `Fork of ${(parentSession?.title ?? "")}`;
      const parentTask = tasksDb
        .prepare(
          "select workspace_key, workspace_path, workspace_identity, provider, mode, task_status, model " +
            "from tasks where task_id = ?",
        )
        .get(parentSessionId) as
        | {
            workspace_key: string;
            workspace_path: string;
            workspace_identity: string | null;
            provider: string | null;
            mode: string | null;
            task_status: string | null;
            model: string | null;
          }
        | undefined;
      const workspaceKey = parentTask?.workspace_key ?? parentSession?.directory ?? "";
      const workspacePath = parentTask?.workspace_path ?? parentSession?.directory ?? "";
      const mode = normalizeTaskIndexMode(parentTask?.mode);
      const meta = {
        taskId: childSessionId,
        traceId: randomUUID(),
        title: childTitle,
        titleOverridden: false,
        workspacePath,
        createdAt: now,
        updatedAt: now,
        mode,
        ...(parentTask?.provider ? { provider: parentTask.provider } : {}),
        forkedFromTaskId: parentSessionId,
        ...(parentTask?.task_status ? { status: parentTask.task_status } : {}),
      };
      tasksDb.exec("begin immediate");
      try {
        tasksDb
          .prepare(
            "insert into tasks (workspace_key, workspace_path, workspace_identity, task_id, title, task_status, provider, mode, model, forked_from_task_id, created_at, updated_at, unread_at, last_unread_at, pinned, archived, deleted, title_overridden, meta_json, searchable_text) " +
              "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, '') " +
              "on conflict(workspace_key, task_id) do update set " +
              "title = excluded.title, task_status = excluded.task_status, provider = excluded.provider, " +
              "mode = excluded.mode, model = excluded.model, forked_from_task_id = excluded.forked_from_task_id, " +
              "updated_at = excluded.updated_at, meta_json = excluded.meta_json",
          )
          .run(
            workspaceKey,
            workspacePath,
            parentTask?.workspace_identity ?? null,
            childSessionId,
            childTitle,
            parentTask?.task_status ?? "completed",
            parentTask?.provider ?? null,
            mode,
            parentTask?.model ?? null,
            parentSessionId,
            now,
            now,
            JSON.stringify(meta),
          );
        tasksDb.exec("commit");
      } catch (transactionError) {
        try {
          tasksDb.exec("rollback");
        } catch {
          /* 尽力而为 */
        }
        throw transactionError;
      }
      log("直连 fork 任务索引行写入完成", { childSessionId, mode, workspaceKey });
    } catch (error) {
      /* 任务行失败不回滚子会话（会话本体已就位；任务行可由 syncer/重启补建） */
      log("直连 fork 任务索引行写入失败（不回滚会话）", {
        childSessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      ok: true,
      childSessionId,
      copiedMessages: messages.length,
      ...(parentSession?.directory ? { workspacePath: parentSession.directory } : {}),
      parentMaxMessageRowid,
      childMaxMessageRowid,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("直连 fork 失败", { parentSessionId, message, durationMs: Date.now() - startedAt });
    return { ...base, error: message };
  } finally {
    try {
      sessionDb.close();
    } catch {
      /* 尽力而为 */
    }
    if (tasksDb) {
      try {
        tasksDb.close();
      } catch {
        /* 尽力而为 */
      }
    }
  }
}
