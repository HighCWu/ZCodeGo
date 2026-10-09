/**
 * zcode-go goal 停滞看门狗（goal-keeper 标准版子集，桌面服务层实现）。
 *
 * 背景：运行时的 goal 续跑是一次性循环，仅由 prompt 收尾 / task-notification /
 * goal 命令重新武装；运行时或桌面重启后 active goal 不会被重新武装（resume.ts
 * 刻意设计），也没有空闲看门狗（continueActiveTargetIfIdle 零调用方）——goal
 * 会保持 active 但永远静默。
 *
 * 两种停滞形态（实证，zcode.cjs + v4 schema）：
 *   - 会话 token 预算耗尽：goal 内部转 budget_limited，v4 投影为 paused →
 *     budget 通道轮询恢复（恢复无主动信号）。
 *   - 账号额度耗尽：goal 仍 active，仅表现为 turn failed + 会话活动停滞 →
 *     停滞通道恢复。额度恢复可能在数小时后，快速重试只会在额度未恢复时制造
 *     可见失败 turn——因此停滞恢复采用「快 3 次探测 → 指数退避慢通道（15min
 *     起、×2、封顶 2h、不限次）」，任一次 resume 后会话活动恢复即全部复位。
 *
 * 手动暂停不续跑（用户语义：自动续跑仅覆盖非人为中断）：v4 投影把手动
 * paused 与 budget_limited 都压成 "paused"，见 paused 边沿一律先经
 * verifyPausedIntent 查运行时原生状态（session/goal show →
 * snapshot.runtime.target.status，失败退 readSession）——budget_limited 才
 * 进入预算等待；paused = 手动意图，停止追踪；连续 3 次查询失败也放弃
 * （宁可少续跑，不误拉起手动暂停）。预算通道退避独立计数（budgetRetries），
 * 且距上次 budget 事件不足一个完整间隔时活动复位不清零（防 60s 循环）。
 *
 * 活动时间一律取帧里的 lastActivityAt（而非本地 now）：标题变化等与 goal 无关
 * 的 session.upserted 不掩盖停滞；帧值回退（乱序）时取 max 防时钟毛刺。
 *
 * 追踪注册：delta 里的 active 边沿（本次启动后启用）立即注册；初始 snapshot
 * 里的 active 也注册（桌面重启不丢追踪——官方不重新武装是官方的行为，本模块
 * 的职责就是让 zcode-go 运行期间 active goal 不死），但 snapshot 注册的 goal
 * 首次停滞直接走慢通道（不明确其停止原因，避免对历史静默 goal 立即重试）。
 *
 * 配置：~/.zcode-go/config.json
 *   { "goalKeepAlive": { "enabled": true, "stallSeconds": 60, "budgetRetryMinutes": 5, "maxAutoResumes": 3 } }
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractLogicalFramePayload, wireFrameTopic } from "./zcodeGoWireFrame.js";
import { hasZcodeGoGoalPauseIntent } from "./zcodeGoGoalVerify.js";

const STATE_DIR = join(homedir(), ".zcode-go");
const SCAN_INTERVAL_MS = 60_000;
/** 慢通道起始退避 → 封顶。 */
const SLOW_PROBE_BASE_MS = 15 * 60_000;
const SLOW_PROBE_MAX_MS = 2 * 60 * 60_000;
/** resume 后判定「活动是否恢复」的观察窗（scan 一轮）。 */
const RESUME_EFFECT_WINDOW_MS = 5 * 60_000;

export interface ZcodeGoGoalKeepAliveLogger {
  info(traceId: string | undefined, message: string, extra?: unknown): void;
  warn(traceId: string | undefined, message: string, extra?: unknown): void;
  debug(traceId: string | undefined, message: string, extra?: unknown): void;
}

export interface ZcodeGoGoalKeepAliveAgent {
  goalSession(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    action: "show" | "set" | "replace" | "pause" | "resume" | "clear";
    objective?: string;
  }): Promise<unknown>;
  setModel(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    model: { providerId: string; modelId: string };
  }): Promise<unknown>;
  readSession(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runtimePolicy?: string;
  }): Promise<unknown>;
  readSessionMessages(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    limit?: number;
  }): Promise<unknown>;
}

interface GoalKeepAliveConfig {
  enabled: boolean;
  /** 路径 2-4（verifier 无 nextAction / 通知断链 / 续跑轮报错）的停滞阈值 */
  stallSeconds: number;
  /** 路径 5（模型未就绪）的等待阈值 */
  modelWaitSeconds: number;
  /** budget_limited 的重试间隔（额度恢复无主动信号，轮询重试；内部仍按 ×2 退避封顶 60min） */
  budgetRetryMinutes: number;
  /** 快通道保护上限：连续无效 resume 次数，超出转慢通道（不限次、退避） */
  maxAutoResumes: number;
}

interface SessionSettingsShape {
  model?: {
    current?: { providerId: string; modelId: string } | null;
    available?: Array<{ providerId: string; modelId: string }>;
  } | null;
}

interface SessionSnapshotShape {
  projection?: { target?: { objective?: string; status?: string } | null };
  settings?: SessionSettingsShape | null;
}

interface TrackedGoal {
  sessionId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  /** 会话活动时刻（帧 lastActivityAt，非本地时钟）。 */
  lastActivityAtMs: number;
  /** 注册（启用）时刻——路径 5 判定用：注册后从未有活动 = 模型未就绪 */
  registeredAtMs: number;
  /** 初始 snapshot 里已 active（历史状态）：首次停滞直接走慢通道。 */
  fromSnapshot: boolean;
  /** 模型追溯（路径 5）已尝试过：一次性救济，恢复复位后再次停滞不再触发。 */
  modelTraceTried: boolean;
  /** 快通道连续无效 resume 计数（maxAutoResumes 保护）。 */
  fastResumes: number;
  /** 慢通道：下次探测时刻 + 当前退避间隔。 */
  nextProbeAtMs: number;
  probeBackoffMs: number;
  /** 最近一次 resume 时刻（活动恢复判定窗口）。 */
  lastResumeAtMs: number;
  /** budget_limited 等待额度恢复 */
  budgetWaiting?: boolean;
  /** budget 轮询重试计时（undefined = 无进行中的预算等待；置位时从当前时刻起等满一个间隔——修复首跳立即重试） */
  lastBudgetRetryMs?: number;
  /** 预算通道独立重试计数（×2 退避；与停滞通道的 fastResumes 分离，避免互相复位） */
  budgetRetries?: number;
  /** 最近一次权威判定为 budget_limited 的时刻 */
  budgetEpisodeAtMs?: number;
  /** 预算等待结束后的活动起点——活动持续满一个完整间隔才老化清零 budgetRetries（防「resume→一个 turn→又 budget」的 60s 循环） */
  budgetActiveSinceMs?: number;
  /** paused 边沿待权威裁定（v4 投影无法区分手动/budget）；连续裁定失败计数见 pauseVerifyAttempts */
  pauseNeedsVerify?: boolean;
  /** 权威裁定连续失败次数（≥3 放弃追踪——宁可不续跑也不误拉起手动暂停） */
  pauseVerifyAttempts?: number;
}

let agent: ZcodeGoGoalKeepAliveAgent | null = null;
let logger: ZcodeGoGoalKeepAliveLogger | null = null;
let disposed = false;
let scanTimer: ReturnType<typeof setInterval> | null = null;

/** 本次启动后启用的 goal（active 边沿或 snapshot 注册）。 */
const tracked = new Map<string, TrackedGoal>();
/** paused 权威裁定进行中的会话（防帧风暴重复查询）。 */
const pauseVerifying = new Set<string>();

/** 配置读取带 10s TTL 缓存：readConfig 位于每帧分发路径，同步文件 I/O 不可每帧做。 */
let configCache: { at: number; value: GoalKeepAliveConfig } | null = null;
const CONFIG_TTL_MS = 10_000;

function readConfig(): GoalKeepAliveConfig {
  if (configCache && Date.now() - configCache.at <= CONFIG_TTL_MS) return configCache.value;
  const defaults: GoalKeepAliveConfig = {
    enabled: true,
    stallSeconds: 60,
    modelWaitSeconds: 60,
    budgetRetryMinutes: 5,
    maxAutoResumes: 3,
  };
  const resolved = (() => {
    try {
      const path = join(STATE_DIR, "config.json");
      if (!existsSync(path)) return defaults;
      const raw = JSON.parse(readFileSync(path, "utf-8")) as {
        goalKeepAlive?: {
          enabled?: boolean;
          stallSeconds?: number;
          modelWaitSeconds?: number;
          budgetRetryMinutes?: number;
          maxAutoResumes?: number;
        };
      };
      return {
        enabled: raw.goalKeepAlive?.enabled !== false,
        stallSeconds: Math.max(30, raw.goalKeepAlive?.stallSeconds ?? 60),
        modelWaitSeconds: Math.max(30, raw.goalKeepAlive?.modelWaitSeconds ?? 60),
        budgetRetryMinutes: Math.max(1, raw.goalKeepAlive?.budgetRetryMinutes ?? 5),
        maxAutoResumes: Math.max(1, Math.min(10, raw.goalKeepAlive?.maxAutoResumes ?? defaults.maxAutoResumes)),
      };
    } catch {
      return defaults;
    }
  })();
  configCache = { at: Date.now(), value: resolved };
  return resolved;
}

interface IndexSessionEntry {
  sessionId?: unknown;
  goalStatus?: unknown;
  lastActivityAt?: unknown;
  workspacePath?: unknown;
  workspaceIdentity?: unknown;
}

function extractEntries(wire: unknown): Array<IndexSessionEntry> {
  const payload = extractLogicalFramePayload(wire);
  if (!payload) return [];
  const out: Array<IndexSessionEntry> = [];
  const push = (session: unknown): void => {
    if (typeof session === "object" && session !== null) out.push(session as IndexSessionEntry);
  };
  if (payload.kind === "deltas") {
    for (const d of payload.deltas ?? []) {
      if ((d as { op?: unknown })?.op === "session.upserted") {
        push((d as { session?: unknown }).session);
      }
    }
  } else if (payload.snapshot !== null && typeof payload.snapshot === "object") {
    const snap = payload.snapshot as { sessions?: unknown };
    if (Array.isArray(snap.sessions)) for (const s of snap.sessions) push(s);
  }
  return out;
}

/** sessions-index 帧观察入口（zcodeAgentService 帧分发点调用）。 */
export function observeZcodeGoGoalKeepAliveFrame(workspace: {
  workspacePath?: string;
  workspaceIdentity?: string;
}, wire: unknown): void {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  const logical = extractLogicalFramePayload(wire);
  if (!logical) return;
  const fromSnapshot = logical.kind === "snapshot";
  for (const entry of extractEntries(wire)) {
    if (typeof entry.sessionId !== "string" || !entry.sessionId) continue;
    const sessionId = entry.sessionId;
    const goalStatus = typeof entry.goalStatus === "string" ? entry.goalStatus : undefined;
    // 帧自带活动时刻；缺失（旧 CLI）退回本地时钟，保证单调不减。
    const frameActivity = typeof entry.lastActivityAt === "number" ? entry.lastActivityAt : Date.now();

    if (goalStatus === "active") {
      const existing = tracked.get(sessionId);
      if (existing) {
        // 活动真实前进：resume 生效判定 + 退避/计数复位；budget 等待结束。
        if (frameActivity > existing.lastActivityAtMs) {
          if (existing.lastResumeAtMs > 0 && frameActivity >= existing.lastResumeAtMs) {
            // 上一轮 resume 之后产生了新活动——恢复成功。预算退避不在此清零：
            // 记录活动起点，活动持续满一个完整间隔（下个 active 帧老化检查）
            // 才算「预算真正恢复」——「resume→一个 turn→又 budget_limited」的
            // 会话保持退避，不再 60s 循环。
            const budgetIntervalMs = readConfig().budgetRetryMinutes * 60_000;
            if (existing.fastResumes > 0 || existing.probeBackoffMs > SLOW_PROBE_BASE_MS || existing.budgetWaiting) {
              logger?.info(trace(), "[zcode-go goal 看门狗] goal 恢复推进，重置重试状态", {
                sessionId,
                budgetRetriesKept: existing.budgetRetries ?? 0,
              });
            }
            existing.fastResumes = 0;
            existing.probeBackoffMs = SLOW_PROBE_BASE_MS;
            existing.nextProbeAtMs = 0;
            existing.lastResumeAtMs = 0;
            if (existing.budgetWaiting) {
              existing.budgetWaiting = false;
              existing.budgetActiveSinceMs = Date.now();
            }
            existing.pauseNeedsVerify = false;
            existing.pauseVerifyAttempts = 0;
          }
          // 老化：预算等待结束后活动已持续满一个完整间隔 → 预算真正恢复。
          if (
            !existing.budgetWaiting &&
            existing.budgetActiveSinceMs !== undefined &&
            Date.now() - existing.budgetActiveSinceMs >= readConfig().budgetRetryMinutes * 60_000
          ) {
            existing.budgetRetries = 0;
            existing.lastBudgetRetryMs = undefined;
            existing.budgetEpisodeAtMs = undefined;
            existing.budgetActiveSinceMs = undefined;
          }
          existing.lastActivityAtMs = frameActivity;
        }
        continue;
      }
      tracked.set(sessionId, {
        sessionId,
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        lastActivityAtMs: frameActivity,
        registeredAtMs: Date.now(),
        fromSnapshot,
        modelTraceTried: false,
        fastResumes: 0,
        nextProbeAtMs: 0,
        probeBackoffMs: SLOW_PROBE_BASE_MS,
        lastResumeAtMs: 0,
      });
      logger?.info(trace(), fromSnapshot ? "[zcode-go goal 看门狗] 注册 snapshot 中的 active goal" : "[zcode-go goal 看门狗] 追踪新启用的 goal", {
        sessionId,
        workspace: workspace.workspacePath ?? "",
      });
      continue;
    }
    // 非 active：verified/notSatisfied/failed → 终态停止追踪；paused → budget
    // 等待（会话 token 预算耗尽的投影）；undefined → 会话有 goal 之外的活动，
    // 仅推进活动时刻（用帧值，避免无关 upsert 掩盖停滞）。
    const t = tracked.get(sessionId);
    if (!t) continue;
    if (goalStatus === "paused") {
      t.lastActivityAtMs = Math.max(t.lastActivityAtMs, frameActivity);
      if (!t.budgetWaiting) {
        // 投影 paused 来源二义（手动暂停 / budget_limited）——交权威裁定。
        t.pauseNeedsVerify = true;
        void verifyPausedIntent(workspace, sessionId);
      }
      continue;
    }
    if (goalStatus === undefined) {
      t.lastActivityAtMs = Math.max(t.lastActivityAtMs, frameActivity);
      continue;
    }
    tracked.delete(sessionId);
    logger?.debug(trace(), "[zcode-go goal 看门狗] goal 终态，停止追踪", {
      sessionId,
      goalStatus,
    });
  }
}

let traceCounter = 0;
function trace(): string {
  traceCounter += 1;
  return `zcode-go-keepalive-${traceCounter}`;
}

/**
 * conversation 帧观察入口（zcodeAgentService conversation 帧分发点调用）。
 *
 * goal 状态的权威实时源是 conversation 帧：snapshot 平级 goal 键、delta 的
 * state.updated patch.goal（goal set/resume/pause 都产生带 goal 键的帧）。
 * sessions-index 的 goalStatus 是列表投影（可选字段，CLI 不保证在 goal 变化时
 * 携带），两个源并用以保证注册边沿可见。帧到达本身即活动信号（流式 delta 持续
 * 到达 = 会话活着），活动时刻用帧到达时的本地时钟。
 */
export function observeZcodeGoGoalKeepAliveConversationFrame(workspace: {
  workspacePath?: string;
  workspaceIdentity?: string;
}, wire: unknown): void {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  // topic = conversation/<sessionId>（complete/fragment 均携带；缺 topic 无法归因）。
  const topic = wireFrameTopic(wire);
  if (!topic || !topic.startsWith("conversation/")) return;
  const sessionId = topic.slice("conversation/".length);
  if (!sessionId) return;

  const logical = extractLogicalFramePayload(wire);
  if (!logical) return;
  if (logical.kind === "snapshot") {
    // 快照帧到达：会话在活动（订阅建立/重对齐）；goal 在场则套用状态规则。
    bumpActivity(sessionId);
    applyGoalStatus(workspace, sessionId, (logical.snapshot as { goal?: unknown } | null)?.goal);
    return;
  }
  let sawGoal = false;
  for (const delta of logical.deltas ?? []) {
    if ((delta as { op?: unknown })?.op !== "state.updated") continue;
    const goal = (delta as { patch?: { goal?: unknown } }).patch?.goal;
    if (goal === undefined) continue;
    sawGoal = true;
    applyGoalStatus(workspace, sessionId, goal);
  }
  // 无 goal 键的 state 更新（usage/queue 等）仍是活动信号，但只有已追踪的
  // 会话才刷新——不注册新 goal（无 goal 键不代表 goal 状态）。
  if (!sawGoal) bumpActivity(sessionId);
}

function bumpActivity(sessionId: string): void {
  const t = tracked.get(sessionId);
  if (t) t.lastActivityAtMs = Math.max(t.lastActivityAtMs, Date.now());
}

/** 从 session/goal show 或 readSession 的快照里提取权威 goal 状态。
 * 导出供单测锚定语义（runtime 原生状态优先于 v4 投影）。 */
export function authoritativeGoalStatus(snapshot: unknown): string | undefined {
  const s = snapshot as {
    runtime?: { target?: { status?: unknown } | null } | null;
    projection?: { target?: { status?: unknown } | null } | null;
  } | null | undefined;
  const runtimeStatus = s?.runtime?.target?.status;
  if (typeof runtimeStatus === "string") return runtimeStatus;
  const projectionStatus = s?.projection?.target?.status;
  if (typeof projectionStatus === "string") return projectionStatus;
  return undefined;
}

/**
 * paused 边沿的权威裁定。v4 投影把「手动暂停」与「token 预算耗尽
 * （budget_limited）」都压成 "paused"——见 paused 就续跑会把用户手动暂停的
 * goal 在一分钟内拉起来（用户明确要求：仅手动中断不续跑）。运行时原生状态
 * 两者是不同枚举，此处查 session/goal show（失败退 readSession）：
 *   - budget_limited → 进入预算等待，且首跳从现在起等满一个间隔
 *     （旧行为 lastBudgetRetryMs 未初始化 → 下一轮扫描立即 resume）；
 *   - paused → 手动意图，停止追踪（用户 resume / 重设 goal 后经 active
 *     边沿重新注册，续跑能力不受影响）；
 *   - 查询失败 → 计数重试（下轮扫描再裁定），连续 3 次失败放弃追踪
 *     ——宁可少续跑，不误拉起手动暂停。
 */
async function verifyPausedIntent(
  workspace: { workspacePath?: string; workspaceIdentity?: string },
  sessionId: string,
): Promise<void> {
  if (!agent || disposed) return;
  if (!tracked.get(sessionId)) return;
  if (pauseVerifying.has(sessionId)) return;
  pauseVerifying.add(sessionId);
  try {
    const target = {
      sessionId,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
    };
    let status: string | undefined;
    try {
      const shown = (await agent.goalSession({ ...target, action: "show" })) as {
        snapshot?: unknown;
      } | undefined;
      status = authoritativeGoalStatus(shown?.snapshot);
    } catch {
      status = undefined;
    }
    if (status === undefined) {
      try {
        const read = (await agent.readSession(target)) as {
          snapshot?: unknown;
        } | undefined;
        status = authoritativeGoalStatus(read?.snapshot);
      } catch {
        status = undefined;
      }
    }
    const live = tracked.get(sessionId);
    if (!live) return;
    if (status === "budget_limited") {
      live.pauseNeedsVerify = false;
      live.pauseVerifyAttempts = 0;
      live.budgetWaiting = true;
      live.lastBudgetRetryMs = Date.now();
      live.budgetEpisodeAtMs = Date.now();
      live.budgetActiveSinceMs = undefined;
      logger?.info(
        trace(),
        "[zcode-go goal 看门狗] 权威状态 budget_limited，进入预算等待",
        { sessionId, budgetRetries: live.budgetRetries ?? 0 },
      );
      return;
    }
    if (status === "paused") {
      tracked.delete(sessionId);
      logger?.info(
        trace(),
        "[zcode-go goal 看门狗] goal 手动暂停（权威状态 paused），停止自动续跑",
        { sessionId },
      );
      return;
    }
    if (status !== undefined) {
      // active/complete 等其他权威状态：投影滞后，交回常规状态规则处理。
      live.pauseNeedsVerify = false;
      live.pauseVerifyAttempts = 0;
      return;
    }
    live.pauseVerifyAttempts = (live.pauseVerifyAttempts ?? 0) + 1;
    if (live.pauseVerifyAttempts >= 3) {
      tracked.delete(sessionId);
      logger?.warn(
        trace(),
        "[zcode-go goal 看门狗] paused 权威裁定连续失败，放弃追踪（不自动续跑）",
        { sessionId },
      );
    }
  } finally {
    pauseVerifying.delete(sessionId);
  }
}

/** 套用 goal 状态（goal 键为 null = 已清除，非终态但停止追踪）。 */
function applyGoalStatus(
  workspace: { workspacePath?: string; workspaceIdentity?: string },
  sessionId: string,
  goal: unknown,
): void {
  if (goal === null || typeof goal !== "object") {
    tracked.delete(sessionId);
    return;
  }
  const status = (goal as { status?: unknown }).status;
  if (typeof status !== "string") return;
  const now = Date.now();
  if (status === "active") {
    const existing = tracked.get(sessionId);
    if (existing) {
      if (now > existing.lastActivityAtMs) {
        // 上一轮 resume 之后产生了真实活动——恢复成功，全部复位（与 sessions-index
        // 入口的 active 分支同款；conversation 帧是主力源，漏复位会让恢复后的
        // goal 永远停留在慢通道状态）。预算退避不在此清零：记录活动起点，活动
        // 持续满一个完整间隔才老化清零（预算反复的会话保持退避）。
        if (existing.lastResumeAtMs > 0 && now >= existing.lastResumeAtMs) {
          if (existing.fastResumes > 0 || existing.probeBackoffMs > SLOW_PROBE_BASE_MS || existing.budgetWaiting) {
            logger?.info(trace(), "[zcode-go goal 看门狗] goal 恢复推进，重置重试状态", {
              sessionId,
              budgetRetriesKept: existing.budgetRetries ?? 0,
            });
          }
          existing.fastResumes = 0;
          existing.probeBackoffMs = SLOW_PROBE_BASE_MS;
          existing.nextProbeAtMs = 0;
          existing.lastResumeAtMs = 0;
          if (existing.budgetWaiting) {
            existing.budgetWaiting = false;
            existing.budgetActiveSinceMs = now;
          }
          existing.pauseNeedsVerify = false;
          existing.pauseVerifyAttempts = 0;
        }
        // 老化：预算等待结束后活动已持续满一个完整间隔 → 预算真正恢复。
        if (
          !existing.budgetWaiting &&
          existing.budgetActiveSinceMs !== undefined &&
          now - existing.budgetActiveSinceMs >= readConfig().budgetRetryMinutes * 60_000
        ) {
          existing.budgetRetries = 0;
          existing.lastBudgetRetryMs = undefined;
          existing.budgetEpisodeAtMs = undefined;
          existing.budgetActiveSinceMs = undefined;
        }
        existing.lastActivityAtMs = now;
      }
      return;
    }
    tracked.set(sessionId, {
      sessionId,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      lastActivityAtMs: now,
      registeredAtMs: now,
      fromSnapshot: false,
      modelTraceTried: false,
      fastResumes: 0,
      nextProbeAtMs: 0,
      probeBackoffMs: SLOW_PROBE_BASE_MS,
      lastResumeAtMs: 0,
    });
    logger?.info(trace(), "[zcode-go goal 看门狗] 追踪新启用的 goal（conversation 帧）", {
      sessionId,
      workspace: workspace.workspacePath ?? "",
    });
    return;
  }
  const t = tracked.get(sessionId);
  if (!t) return;
  if (status === "paused" || status === "verifying") {
    t.lastActivityAtMs = Math.max(t.lastActivityAtMs, now);
    if (status === "paused" && !t.budgetWaiting) {
      // 投影 paused 来源二义（手动暂停 / budget_limited）——交权威裁定，
      // 裁定前不进入预算等待（也不会被扫描通道拉起）。
      t.pauseNeedsVerify = true;
      void verifyPausedIntent(workspace, sessionId);
    }
    return;
  }
  // verified / notSatisfied / failed：终态。
  tracked.delete(sessionId);
  logger?.debug(trace(), "[zcode-go goal 看门狗] goal 终态，停止追踪（conversation 帧）", {
    sessionId,
    status,
  });
}

/** resume 后观察窗内会话活动是否前进（恢复成功判定）。 */
function resumeTookEffect(g: TrackedGoal): boolean {
  return g.lastActivityAtMs > g.lastResumeAtMs;
}

async function resumeTrackedGoal(g: TrackedGoal, reason: string): Promise<void> {
  // 暂停意图在位（用户点了暂停、等完成边沿落地）——看门狗不得 resume 抢跑。
  if (hasZcodeGoGoalPauseIntent(g.sessionId)) {
    logger?.info(trace(), "[zcode-go goal 看门狗] 暂停意图在位，跳过 resume", {
      sessionId: g.sessionId,
    });
    return;
  }
  const target = {
    sessionId: g.sessionId,
    workspacePath: g.workspacePath,
    workspaceIdentity: g.workspaceIdentity,
  };
  g.lastResumeAtMs = Date.now();
  try {
    await agent!.goalSession({ ...target, action: "resume" });
    logger?.info(trace(), `[zcode-go goal 看门狗] ${reason}，resume 续上`, {
      sessionId: g.sessionId,
      attempt: g.fastResumes,
    });
  } catch (error) {
    logger?.warn(trace(), "[zcode-go goal 看门狗] resume 失败（下轮重试）", {
      sessionId: g.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 单轮扫描恢复（导出供测试驱动；正常运行由 init 的定时器驱动）。 */
export async function scanAndRecover(): Promise<void> {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  const now = Date.now();
  for (const g of [...tracked.values()]) {
    // paused 权威裁定失败重试（帧边沿已即时裁定过；此处每轮扫描兜底一次，
    // 连续 3 次失败由 verifyPausedIntent 内部放弃追踪）。
    if (g.pauseNeedsVerify && !g.budgetWaiting) {
      void verifyPausedIntent(
        { workspacePath: g.workspacePath, workspaceIdentity: g.workspaceIdentity },
        g.sessionId,
      );
      continue;
    }
    // ── 通道一：budget_limited（token 预算耗尽，权威判定后才进入）→ 轮询
    // 重试，间隔 ×2 退避封顶 60 分钟，不限总次数（额度/预算恢复无主动信号）。
    // 进入等待时 lastBudgetRetryMs 已置位 → 首跳等满一个间隔；预算反复的
    // 会话退避不被活动复位清零。resume 生效后由观察函数的活动前进分支复位。
    if (g.budgetWaiting) {
      const since = now - (g.lastBudgetRetryMs ?? 0);
      const interval = config.budgetRetryMinutes * 60_000;
      const backoff =
        g.lastBudgetRetryMs === undefined
          ? interval
          : Math.min(interval * Math.pow(2, g.budgetRetries ?? 0), 60 * 60_000);
      if (since < backoff) continue;
      g.lastBudgetRetryMs = now;
      g.budgetRetries = (g.budgetRetries ?? 0) + 1;
      logger?.info(trace(), "[zcode-go goal 看门狗] budget_limited 轮询恢复", {
        sessionId: g.sessionId,
        backoffMinutes: Math.round(backoff / 60_000),
        attempt: g.budgetRetries,
      });
      await resumeTrackedGoal(g, "budget_limited");
      continue;
    }

    const idleMs = now - g.lastActivityAtMs;

    // ── 通道二：路径 5——启用后从未有活动 = 模型未就绪。追溯该会话从最新到旧
    // 使用过的模型，找列表中仍可用的降档恢复（snapshot 注册的 goal 跳过：
    // 其「从未活动」只是观察起点问题）。
    if (
      !g.fromSnapshot &&
      !g.modelTraceTried &&
      g.lastActivityAtMs <= g.registeredAtMs &&
      now - g.registeredAtMs >= config.modelWaitSeconds * 1000
    ) {
      g.modelTraceTried = true;
      logger?.info(trace(), "[zcode-go goal 看门狗] 疑似路径 5（模型未就绪），追溯模型列表恢复", {
        sessionId: g.sessionId,
      });
      g.lastResumeAtMs = Date.now();
      try {
        const recovered = await recoverViaModelTrace({
          sessionId: g.sessionId,
          workspacePath: g.workspacePath,
          workspaceIdentity: g.workspaceIdentity,
        });
        if (!recovered) {
          logger?.info(trace(), "[zcode-go goal 看门狗] 无可用备选模型，放行", {
            sessionId: g.sessionId,
          });
        }
      } catch (error) {
        logger?.warn(trace(), "[zcode-go goal 看门狗] 模型追溯恢复失败", {
          sessionId: g.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    if (idleMs < config.stallSeconds * 1000) continue;

    // 上轮 resume 仍在观察窗内：等下一轮再判效果，避免连续快速 resume。
    if (g.lastResumeAtMs > 0 && now - g.lastResumeAtMs < RESUME_EFFECT_WINDOW_MS) continue;

    // 上轮 resume 已出观察窗且活动仍未前进 = 无效 resume（典型：账号额度未恢复，
    // resume 重启的 turn 立即失败）。快通道计数；超出保护上限转慢通道（退避只在
    // 真实探测后翻倍——若每轮 scan 都翻会几分钟内冲到封顶，失去 15/30/60 的梯度）。
    if (g.lastResumeAtMs > 0 && !resumeTookEffect(g)) {
      g.fastResumes += 1;
      if (g.fastResumes === config.maxAutoResumes + 1) {
        logger?.info(trace(), "[zcode-go goal 看门狗] 连续无效 resume，转入慢通道退避（等待额度/环境恢复）", {
          sessionId: g.sessionId,
          firstBackoffMinutes: Math.round(SLOW_PROBE_BASE_MS / 60_000),
        });
      }
    }

    // 快通道（保护计数内）按停滞阈值立即重试；慢通道按退避到点探测。
    if (g.fastResumes <= config.maxAutoResumes) {
      logger?.info(trace(), "[zcode-go goal 看门狗] goal 停滞，resume 续上", {
        sessionId: g.sessionId,
        idleSeconds: Math.round(idleMs / 1000),
        attempt: g.fastResumes + 1,
      });
      await resumeTrackedGoal(g, "goal 停滞");
      continue;
    }
    if (g.nextProbeAtMs === 0) g.nextProbeAtMs = g.lastResumeAtMs + g.probeBackoffMs;
    if (now < g.nextProbeAtMs) continue;
    logger?.info(trace(), "[zcode-go goal 看门狗] 慢通道探测 resume（等待额度恢复中）", {
      sessionId: g.sessionId,
      backoffMinutes: Math.round(g.probeBackoffMs / 60_000),
    });
    // 探测发生：本次用当前退避，探测后翻倍（若恢复成功，观察函数的 active 分支
    // 会整体复位回 SLOW_PROBE_BASE_MS）。
    g.nextProbeAtMs = now + g.probeBackoffMs;
    g.probeBackoffMs = Math.min(g.probeBackoffMs * 2, SLOW_PROBE_MAX_MS);
    await resumeTrackedGoal(g, "慢通道探测");
  }
}

/** 路径 5：从会话消息回溯模型使用序列（最新→旧），结合 settings.model.available
 * 找第一个可用的备选模型 → setModel + resume。 */
async function recoverViaModelTrace(target: {
  sessionId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}): Promise<boolean> {
  if (!agent) return false;
  const snapshot = (await agent.readSession({
    ...target,
    runtimePolicy: "existing-only",
  })) as SessionSnapshotShape | undefined;
  const current = snapshot?.settings?.model?.current;
  const available = snapshot?.settings?.model?.available ?? [];
  const availableKeys = new Set(available.map((m) => `${m.providerId}/${m.modelId}`));
  const history = (await agent.readSessionMessages({ ...target, limit: 200 })) as Array<{
    info?: { modelSelection?: { providerId?: string; modelId?: string } };
  }>;
  const usedNewestFirst: string[] = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const sel = (history[i] as { info?: { modelSelection?: { providerId?: string; modelId?: string } } })
      ?.info?.modelSelection;
    if (!sel?.providerId || !sel?.modelId) continue;
    const key = `${sel.providerId}/${sel.modelId}`;
    if (!usedNewestFirst.includes(key)) usedNewestFirst.push(key);
  }
  for (const key of usedNewestFirst) {
    const [providerId, modelId] = key.split("/");
    if (!providerId || !modelId) continue;
    if (current && providerId === current.providerId && modelId === current.modelId) continue;
    if (!availableKeys.has(key)) continue;
    logger?.info(trace(), "[zcode-go goal 看门狗] 切换到历史可用模型", {
      sessionId: target.sessionId,
      model: key,
    });
    await agent.setModel({ ...target, model: { providerId, modelId } });
    await agent.goalSession({ ...target, action: "resume" });
    return true;
  }
  return false;
}

/** 桌面服务装配时调用（node.ts 容器）。 */
export function initZCodeGoGoalKeepAlive(
  agentService: ZcodeGoGoalKeepAliveAgent,
  options?: { logger?: ZcodeGoGoalKeepAliveLogger },
): void {
  agent = agentService;
  logger = options?.logger ?? null;
  disposed = false;
  const config = readConfig();
  logger?.info(undefined, "[zcode-go goal 看门狗] 已启动", {
    enabled: config.enabled,
    stallSeconds: config.stallSeconds,
    budgetRetryMinutes: config.budgetRetryMinutes,
    maxAutoResumes: config.maxAutoResumes,
  });
  if (!scanTimer) {
    scanTimer = setInterval(() => {
      void scanAndRecover();
    }, SCAN_INTERVAL_MS);
    scanTimer.unref?.();
  }
}

export function disposeZcodeGoGoalKeepAlive(): void {
  disposed = true;
  agent = null;
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  tracked.clear();
}
