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
}

interface GoalKeepAliveConfig {
  enabled: boolean;
  stallMinutes: number;
  maxAutoResumes: number;
}

interface TrackedGoal {
  sessionId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  lastActivityMs: number;
  autoResumes: number;
}

let agent: ZcodeGoGoalKeepAliveAgent | null = null;
let logger: ZcodeGoGoalKeepAliveLogger | null = null;
let disposed = false;
let scanTimer: ReturnType<typeof setInterval> | null = null;

/** 历史遗留：host 启动时已处于 active 的 goal（初始 snapshot），永不自动恢复。 */
const preExisting = new Set<string>();
/** 本次启动后启用的 goal（active 边沿注册）。 */
const tracked = new Map<string, TrackedGoal>();

function readConfig(): GoalKeepAliveConfig {
  const defaults: GoalKeepAliveConfig = { enabled: true, stallMinutes: 10, maxAutoResumes: 3 };
  try {
    const path = join(STATE_DIR, "config.json");
    if (!existsSync(path)) return defaults;
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      goalKeepAlive?: { enabled?: boolean; stallMinutes?: number; maxAutoResumes?: number };
    };
    return {
      enabled: raw.goalKeepAlive?.enabled !== false,
      stallMinutes: Math.max(2, raw.goalKeepAlive?.stallMinutes ?? defaults.stallMinutes),
      maxAutoResumes: Math.max(1, Math.min(10, raw.goalKeepAlive?.maxAutoResumes ?? defaults.maxAutoResumes)),
    };
  } catch {
    return defaults;
  }
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
        autoResumes: 0,
      });
      logger?.info(trace(), "[zcode-go goal 看门狗] 追踪新启用的 goal", {
        sessionId,
        workspace: workspace.workspacePath ?? "",
      });
      continue;
    }
    // 非 active（paused/verified/budget_limited/丢失）→ 用户动作或自然终态，停止追踪
    if (tracked.delete(sessionId)) {
      logger?.debug(trace(), "[zcode-go goal 看门狗] goal 非活动态，停止追踪", {
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
  const stallMs = config.stallMinutes * 60_000;
  const now = Date.now();
  for (const trackedGoal of [...tracked.values()]) {
    if (now - trackedGoal.lastActivityMs <= stallMs) continue;
    if (trackedGoal.autoResumes >= config.maxAutoResumes) {
      tracked.delete(trackedGoal.sessionId);
      logger?.warn(trace(), "[zcode-go goal 看门狗] 自动恢复次数达上限，放行", {
        sessionId: trackedGoal.sessionId,
        autoResumes: config.maxAutoResumes,
      });
      continue;
    }
    const traceId = trace();
    logger?.info(traceId, "[zcode-go goal 看门狗] goal active 但已停滞，自动恢复推进", {
      sessionId: trackedGoal.sessionId,
      idleMinutes: Math.round((now - trackedGoal.lastActivityMs) / 60_000),
      attempt: trackedGoal.autoResumes + 1,
    });
    trackedGoal.lastActivityMs = now;
    trackedGoal.autoResumes += 1;
    try {
      await agent.goalSession({
        sessionId: trackedGoal.sessionId,
        workspacePath: trackedGoal.workspacePath,
        workspaceIdentity: trackedGoal.workspaceIdentity,
        action: "resume",
      });
    } catch (error) {
      logger?.warn(traceId, "[zcode-go goal 看门狗] 恢复失败", {
        sessionId: trackedGoal.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
