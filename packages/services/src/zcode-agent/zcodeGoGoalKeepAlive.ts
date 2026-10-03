/**
 * zcode-go goal 停滞看门狗（goal-keeper 标准版子集，桌面服务层实现）。
 *
 * 背景：运行时的 goal 续跑是一次性循环，仅由 prompt 收尾 / task-notification /
 * goal 命令重新武装；运行时或桌面重启后 active goal 不会被重新武装（resume.ts
 * 刻意设计），也没有空闲看门狗（continueActiveTargetIfIdle 零调用方）——goal
 * 会保持 active 但永远静默。
 *
 * 本模块只追踪「本次 host 启动后启用（active 边沿）且未被用户打断/暂停」的 goal：
 *   - sessions-index 初始 snapshot 中的 active 视为历史状态，不追踪
 *   - 之后 delta 里的 active 边沿（set/resume）→ 注册追踪
 *   - goal 转入 paused/verified/budget_limited/丢失 → 停止追踪（用户动作优先）
 * 追踪中 goal 仍 active 但 lastActivity 距今超过阈值 → 判定停转 → 调官方
 * session/goal resume 重新武装续跑循环（协议层对 active goal 无守卫，实测安全）；
 * 每会话最多自动恢复 3 次，超出放行并记日志。
 *
 * 配置：~/.zcode-go/config.json
 *   { "goalKeepAlive": { "enabled": true, "stallMinutes": 10, "maxAutoResumes": 3 } }
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".zcode-go");
const SCAN_INTERVAL_MS = 60_000;

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
  readSessionState(params: {
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
  /** budget_limited 的重试间隔（额度恢复无主动信号，轮询重试） */
  budgetRetryMinutes: number;
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
  lastActivityMs: number;
  /** 注册（启用）时刻——路径 5 判定用：注册后从未有活动 = 模型未就绪 */
  registeredAtMs: number;
  autoResumes: number;
  /** budget_limited 等待额度恢复 */
  budgetWaiting?: boolean;
  /** 最近一次 budget 重试时刻 */
  lastBudgetRetryMs?: number;
}

let agent: ZcodeGoGoalKeepAliveAgent | null = null;
let logger: ZcodeGoGoalKeepAliveLogger | null = null;
let disposed = false;
let scanTimer: ReturnType<typeof setInterval> | null = null;

/** 历史遗留：host 启动时已处于 active 的 goal（初始 snapshot），永不自动恢复。 */
const preExisting = new Set<string>();
/** 本次启动后启用的 goal（active 边沿注册）。 */
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
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
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

/** sessions-index 帧观察入口（zcodeAgentService 帧分发点调用）。 */
export function observeZcodeGoGoalKeepAliveFrame(workspace: {
  workspacePath?: string;
  workspaceIdentity?: string;
}, wire: unknown): void {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  for (const entry of extractEntries(wire)) {
    if (typeof entry.sessionId !== "string" || !entry.sessionId) continue;
    const sessionId = entry.sessionId;
    const goalStatus = typeof entry.goalStatus === "string" ? entry.goalStatus : undefined;
    const now = Date.now();

    if (goalStatus === "active") {
      if (preExisting.has(sessionId)) continue;
      const existing = tracked.get(sessionId);
      if (existing) {
        existing.lastActivityMs = Math.max(existing.lastActivityMs, now);
        continue;
      }
      // delta 里的 active 才是「本次启动后启用」；初始 snapshot 的 active 属历史状态
      if (payloadKind(wire) === "snapshot") continue;
      tracked.set(sessionId, {
        sessionId,
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        lastActivityMs: now,
        registeredAtMs: now,
        autoResumes: 0,
      });
      logger?.info(trace(), "[zcode-go goal 看门狗] 追踪新启用的 goal", {
        sessionId,
        workspace: workspace.workspacePath ?? "",
      });
      continue;
    }
    // 非 active：verified/丢失 → 终态停止追踪；paused → 延迟判定（可能是
    // budget_limited 被投影成 paused，由 scan 读 raw status 区分）
    const t = tracked.get(sessionId);
    if (t && (goalStatus === "paused" || goalStatus === undefined)) {
      t.budgetWaiting = goalStatus === "paused" ? true : t.budgetWaiting;
      t.lastActivityMs = Math.max(t.lastActivityMs, now);
      continue;
    }
    if (t) {
      tracked.delete(sessionId);
      logger?.debug(trace(), "[zcode-go goal 看门狗] goal 终态，停止追踪", {
        sessionId,
        goalStatus: goalStatus ?? null,
      });
    }
  }
}

function payloadKind(wire: unknown): string | null {
  if (typeof wire !== "object" || wire === null) return null;
  const payload = (wire as { payload?: { kind?: unknown } }).payload;
  return typeof payload?.kind === "string" ? payload.kind : null;
}

let traceCounter = 0;
function trace(): string {
  traceCounter += 1;
  return `zcode-go-keepalive-${traceCounter}`;
}

async function scanAndRecover(): Promise<void> {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  const now = Date.now();
  for (const g of [...tracked.values()]) {
    const target = {
      sessionId: g.sessionId,
      workspacePath: g.workspacePath,
      workspaceIdentity: g.workspaceIdentity,
    };

    // 通道一：budget_limited → 轮询重试 resume（额度恢复无主动信号；过早恢复
    // 会产生一轮 quota 失败的可见 turn，因此重试间隔默认 5 分钟，量级可控）
    if (g.budgetWaiting) {
      const since = now - (g.lastBudgetRetryMs ?? g.lastActivityMs);
      if (since < config.budgetRetryMinutes * 60_000) continue;
      g.lastBudgetRetryMs = now;
      g.lastActivityMs = now;
      g.autoResumes += 1;
      if (g.autoResumes > config.maxAutoResumes) {
        tracked.delete(g.sessionId);
        logger?.warn(trace(), "[zcode-go goal 看门狗] budget 轮询超限，放行", {
          sessionId: g.sessionId,
        });
        continue;
      }
      logger?.info(trace(), "[zcode-go goal 看门狗] budget_limited 轮询恢复", {
        sessionId: g.sessionId,
        attempt: g.autoResumes,
      });
      try {
        await agent.goalSession({ ...target, action: "resume" });
      } catch (error) {
        logger?.warn(trace(), "[zcode-go goal 看门狗] budget 恢复失败（继续轮询）", {
          sessionId: g.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const idleMs = now - g.lastActivityMs;

    // 通道二：路径 5——启用后从未有活动 = 模型未就绪。追溯该会话从最新到旧
    // 使用过的模型，找列表中仍可用的降档恢复
    if (g.autoResumes === 0 && now - g.registeredAtMs >= config.modelWaitSeconds * 1000) {
      logger?.info(trace(), "[zcode-go goal 看门狗] 疑似路径 5（模型未就绪），追溯模型列表恢复", {
        sessionId: g.sessionId,
      });
      g.lastActivityMs = now;
      try {
        const recovered = await recoverViaModelTrace(target);
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

    // 通道三：路径 2-4（verifier 无 nextAction / 通知断链 / 续跑轮报错）——
    // 停滞超过阈值即 resume 续上（active goal 上重复 resume 是安全 no-op +
    // 重新武装；若 turn 正在运行，continueGoalAfterChange 会自动让位）
    if (idleMs >= config.stallSeconds * 1000) {
      g.lastActivityMs = now;
      g.autoResumes += 1;
      logger?.info(trace(), "[zcode-go goal 看门狗] goal 停滞，resume 续上", {
        sessionId: g.sessionId,
        idleSeconds: Math.round(idleMs / 1000),
        attempt: g.autoResumes,
      });
      try {
        await agent.goalSession({ ...target, action: "resume" });
      } catch (error) {
        logger?.warn(traceId(), "[zcode-go goal 看门狗] resume 失败（下轮重试）", {
          sessionId: g.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
  const snapshot = (await agent.readSessionState({
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
  if (!scanTimer) {
    scanTimer = setInterval(() => {
      void scanAndRecover();
    }, SCAN_INTERVAL_MS);
    scanTimer.unref?.();
  }
}

export function disposeZCodeGoGoalKeepAlive(): void {
  disposed = true;
  agent = null;
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  preExisting.clear();
  tracked.clear();
}
