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
  /** 快通道连续无效 resume 计数（maxAutoResumes 保护）。 */
  fastResumes: number;
  /** 慢通道：下次探测时刻 + 当前退避间隔。 */
  nextProbeAtMs: number;
  probeBackoffMs: number;
  /** 最近一次 resume 时刻（活动恢复判定窗口）。 */
  lastResumeAtMs: number;
  /** budget_limited 等待额度恢复 */
  budgetWaiting?: boolean;
  /** 最近一次 budget 重试时刻 */
  lastBudgetRetryMs?: number;
}

let agent: ZcodeGoGoalKeepAliveAgent | null = null;
let logger: ZcodeGoGoalKeepAliveLogger | null = null;
let disposed = false;
let scanTimer: ReturnType<typeof setInterval> | null = null;

/** 本次启动后启用的 goal（active 边沿或 snapshot 注册）。 */
const tracked = new Map<string, TrackedGoal>();

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
  if (typeof wire !== "object" || wire === null) return [];
  const w = wire as { payload?: unknown };
  const payload = w.payload as
    | {
        kind?: string;
        snapshot?: { sessions?: unknown };
        deltas?: Array<{ op?: unknown; session?: unknown }>;
      }
    | undefined;
  const out: Array<IndexSessionEntry> = [];
  const push = (session: unknown): void => {
    if (typeof session === "object" && session !== null) out.push(session as IndexSessionEntry);
  };
  if (payload?.kind === "deltas" && Array.isArray(payload.deltas)) {
    for (const d of payload.deltas) if (d.op === "session.upserted") push(d.session);
  } else if (payload?.kind === "snapshot" && payload.snapshot !== null && typeof payload.snapshot === "object") {
    const snap = payload.snapshot as { sessions?: unknown };
    if (Array.isArray(snap.sessions)) for (const s of snap.sessions) push(s);
  }
  return out;
}

function payloadKind(wire: unknown): string | null {
  if (typeof wire !== "object" || wire === null) return null;
  const payload = (wire as { payload?: { kind?: unknown } }).payload;
  return typeof payload?.kind === "string" ? payload.kind : null;
}

/** sessions-index 帧观察入口（zcodeAgentService 帧分发点调用）。 */
export function observeZcodeGoGoalKeepAliveFrame(workspace: {
  workspacePath?: string;
  workspaceIdentity?: string;
}, wire: unknown): void {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  const fromSnapshot = payloadKind(wire) === "snapshot";
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
            // 上一轮 resume 之后产生了新活动——恢复成功。
            if (existing.fastResumes > 0 || existing.probeBackoffMs > SLOW_PROBE_BASE_MS || existing.budgetWaiting) {
              logger?.info(trace(), "[zcode-go goal 看门狗] goal 恢复推进，重置重试状态", {
                sessionId,
              });
            }
            existing.fastResumes = 0;
            existing.probeBackoffMs = SLOW_PROBE_BASE_MS;
            existing.nextProbeAtMs = 0;
            existing.lastResumeAtMs = 0;
            existing.budgetWaiting = false;
            existing.lastBudgetRetryMs = undefined;
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
      t.budgetWaiting = true;
      t.lastActivityAtMs = Math.max(t.lastActivityAtMs, frameActivity);
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
  if (typeof wire !== "object" || wire === null) return;
  const frame = wire as {
    topic?: unknown;
    payload?: {
      kind?: unknown;
      snapshot?: { goal?: unknown } | null;
      deltas?: Array<{ op?: unknown; patch?: { goal?: unknown } }>;
    };
  };
  // topic = conversation/<sessionId>；订阅 snapshot 前的兜底（sessionId 缺失时无法归因）。
  const topic = typeof frame.topic === "string" ? frame.topic : "";
  if (!topic.startsWith("conversation/")) return;
  const sessionId = topic.slice("conversation/".length);
  if (!sessionId) return;

  if (frame.payload?.kind === "snapshot" && frame.payload.snapshot) {
    // 快照帧到达：会话在活动（订阅建立/重对齐）；goal 在场则套用状态规则。
    bumpActivity(sessionId);
    applyGoalStatus(workspace, sessionId, frame.payload.snapshot.goal);
    return;
  }
  if (frame.payload?.kind === "deltas" && Array.isArray(frame.payload.deltas)) {
    let sawGoal = false;
    for (const delta of frame.payload.deltas) {
      if (delta?.op !== "state.updated") continue;
      const goal = delta.patch?.goal;
      if (goal === undefined) continue;
      sawGoal = true;
      applyGoalStatus(workspace, sessionId, goal);
    }
    // 无 goal 键的 state 更新（usage/queue 等）仍是活动信号，但只有已追踪的
    // 会话才刷新——不注册新 goal（无 goal 键不代表 goal 状态）。
    if (!sawGoal) bumpActivity(sessionId);
  }
}

function bumpActivity(sessionId: string): void {
  const t = tracked.get(sessionId);
  if (t) t.lastActivityAtMs = Math.max(t.lastActivityAtMs, Date.now());
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
      if (now > existing.lastActivityAtMs) existing.lastActivityAtMs = now;
      return;
    }
    tracked.set(sessionId, {
      sessionId,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      lastActivityAtMs: now,
      registeredAtMs: now,
      fromSnapshot: false,
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
    if (status === "paused") t.budgetWaiting = true;
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

async function scanAndRecover(): Promise<void> {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  const now = Date.now();
  for (const g of [...tracked.values()]) {
    // ── 通道一：budget_limited（token 预算耗尽，投影 paused）→ 轮询重试，
    // 间隔 ×2 退避封顶 60 分钟，不限总次数（额度/预算恢复无主动信号）。
    // resume 生效后由观察函数的活动前进分支复位 budgetWaiting。
    if (g.budgetWaiting) {
      const since = now - (g.lastBudgetRetryMs ?? 0);
      const interval = config.budgetRetryMinutes * 60_000;
      const backoff = g.lastBudgetRetryMs === 0 || g.lastBudgetRetryMs === undefined
        ? interval
        : Math.min(interval * Math.pow(2, g.fastResumes), 60 * 60_000);
      if (since < backoff) continue;
      g.lastBudgetRetryMs = now;
      g.fastResumes += 1;
      logger?.info(trace(), "[zcode-go goal 看门狗] budget_limited 轮询恢复", {
        sessionId: g.sessionId,
        backoffMinutes: Math.round(backoff / 60_000),
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
      g.fastResumes === 0 &&
      g.lastResumeAtMs === 0 &&
      now - g.registeredAtMs >= config.modelWaitSeconds * 1000
    ) {
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
    // resume 重启的 turn 立即失败）。快通道计数；超出保护上限转慢通道（指数退避、
    // 不限次——额度恢复可能在数小时后，一旦某次 resume 后活动前进即全部复位）。
    if (g.lastResumeAtMs > 0 && !resumeTookEffect(g)) {
      g.fastResumes += 1;
      if (g.fastResumes > config.maxAutoResumes) {
        // 进入/维持慢通道：调整退避并打点（退避变化时才打，避免每分钟刷日志）。
        const nextBackoff = Math.min(g.probeBackoffMs * 2, SLOW_PROBE_MAX_MS);
        const firstSlow = g.probeBackoffMs === SLOW_PROBE_BASE_MS;
        g.probeBackoffMs = nextBackoff;
        if (firstSlow) {
          logger?.info(trace(), "[zcode-go goal 看门狗] 连续无效 resume，转入慢通道退避（等待额度/环境恢复）", {
            sessionId: g.sessionId,
            nextBackoffMinutes: Math.round(nextBackoff / 60_000),
          });
        }
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
    g.nextProbeAtMs = now + g.probeBackoffMs;
    logger?.info(trace(), "[zcode-go goal 看门狗] 慢通道探测 resume（等待额度恢复中）", {
      sessionId: g.sessionId,
      backoffMinutes: Math.round(g.probeBackoffMs / 60_000),
    });
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
