/**
 * zcode-go goal 完成复核（goal-keeper 标准版子集，桌面服务层实现）。
 *
 * 机制：运行时把 goal 判为 complete（sessions-index goalStatus → "verified"）
 * 后，对同一 objective 重新 session/goal set（官方既有语义）。运行时的 goal
 * continuation 会让执行目标的模型在原会话内、以完整对话历史、无痕
 * （model-only 输入）地自行重新判定目标是否完成：判定未完成则模型继续推进
 * （该部分是真实目标工作，本就应当可见）；判定完成则静默结束。zcode-go 不
 * 修改运行时 goal 状态机——观察（sessions-index 官方协议帧）与重触发
 * （session/goal 既有 action）均走官方协议面。
 *
 * 防循环：同一 goal 的复核-重触发轮数有上限（默认 3 轮，超限放行完成）。
 *
 * 配置：~/.zcode-go/config.json
 *   { "goalVerify": { "enabled": true, "maxRounds": 3 } }
 *   enabled=false 停用；maxRounds 为同一会话同一 goal 的最大重触发轮数。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const STATE_DIR = join(homedir(), ".zcode-go");
/** 完成事件与重触发之间的静置（让收尾 turn/UI 稳定；goal action 在 turn 运行中会被拒绝）。 */
const SETTLE_DELAY_MS = 5_000;
/** 重触发遇忙（active turn 等）重试次数与间隔。 */
const RETRIGGER_ATTEMPTS = 5;
const RETRIGGER_DELAY_MS = 20_000;

export interface ZcodeGoGoalVerifyLogger {
  info(traceId: string | undefined, message: string, extra?: unknown): void;
  warn(traceId: string | undefined, message: string, extra?: unknown): void;
  debug(traceId: string | undefined, message: string, extra?: unknown): void;
}

/** 复核所需的 agent service 能力子集（结构化类型，真实服务可赋值）。 */
export interface ZcodeGoGoalVerifyAgent {
  readSessionState(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runtimePolicy?: string;
  }): Promise<unknown>;
  goalSession(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    action: "show" | "set" | "replace" | "pause" | "resume" | "clear";
    objective?: string;
  }): Promise<unknown>;
}

interface GoalVerifyConfig {
  enabled: boolean;
  maxRounds: number;
}

interface SessionSnapshotShape {
  projection?: {
    target?: {
      objective?: string;
      status?: string;
    } | null;
  } | null;
}

let agent: ZcodeGoGoalVerifyAgent | null = null;
let logger: ZcodeGoGoalVerifyLogger | null = null;
let disposed = false;
/** sessionId → 最近一次 sessions-index goalStatus（迁移检测，只在 verified 边沿触发）。 */
const lastGoalStatusBySession = new Map<string, string>();
/** sessionId → 已执行的重触发轮数（goal 更换后重新计数）。 */
const roundsByGoal = new Map<string, number>();
const inFlight = new Set<string>();

function readConfig(): GoalVerifyConfig {
  const defaults: GoalVerifyConfig = { enabled: true, maxRounds: 3 };
  try {
    const path = join(STATE_DIR, "config.json");
    if (!existsSync(path)) return defaults;
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      goalVerify?: { enabled?: boolean; maxRounds?: number };
    };
    return {
      enabled: raw.goalVerify?.enabled !== false,
      maxRounds: Math.max(1, Math.min(10, raw.goalVerify?.maxRounds ?? defaults.maxRounds)),
    };
  } catch {
    return defaults;
  }
}

/** 从 sessions-index wire candidate（snapshot/delta 两种形态）提取 goalStatus 列表。 */
function extractSessionGoalEntries(
  wire: unknown,
): Array<{ sessionId: string; goalStatus?: string }> {
  const out: Array<{ sessionId: string; goalStatus?: string }> = [];
  if (typeof wire !== "object" || wire === null) return out;
  const w = wire as { snapshot?: unknown; delta?: unknown };
  const push = (session: unknown): void => {
    if (typeof session !== "object" || session === null) return;
    const s = session as { sessionId?: unknown; goalStatus?: unknown };
    if (typeof s.sessionId === "string" && s.sessionId) {
      out.push({
        sessionId: s.sessionId,
        goalStatus: typeof s.goalStatus === "string" ? s.goalStatus : undefined,
      });
    }
  };
  if (typeof w.delta === "object" && w.delta !== null) {
    const d = w.delta as { op?: unknown; session?: unknown };
    if (d.op === "session.upserted") push(d.session);
    return out;
  }
  if (typeof w.snapshot === "object" && w.snapshot !== null) {
    const snap = w.snapshot as { sessions?: unknown };
    if (Array.isArray(snap.sessions)) for (const s of snap.sessions) push(s);
  }
  return out;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function retriggerOnce(
  workspace: { sessionId?: string; workspacePath?: string; workspaceIdentity?: string },
  sessionId: string,
  objective: string,
  traceId: string,
): Promise<void> {
  if (!agent) return;
  const target = { ...workspace, sessionId };
  for (let attempt = 1; attempt <= RETRIGGER_ATTEMPTS; attempt += 1) {
    try {
      // 重试前再查一次：goal 可能已被用户改动（清除/换目标/手动重启）——只重触发
      // 仍处完成态且文本未变的 goal
      const latest = (await agent.readSessionState({
        ...target,
        runtimePolicy: "existing-only",
      })) as SessionSnapshotShape | undefined;
      const current = latest?.projection?.target;
      if (current?.objective?.trim() !== objective || current?.status !== "complete") {
        logger?.info(traceId, "[zcode-go goal 复核] goal 已变化，放弃重触发", {
          sessionId,
          status: current?.status ?? null,
        });
        return;
      }
      await agent.goalSession({ ...target, action: "set", objective });
      logger?.info(
        traceId,
        "[zcode-go goal 复核] 已重新触发 goal（set → active；运行时将让模型在原会话内自行复判，未完成则继续推进）",
        { sessionId },
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn(traceId, "[zcode-go goal 复核] 重触发失败（turn 运行中等忙场景将重试）", {
        sessionId,
        attempt,
        message: message.slice(0, 200),
      });
      if (attempt < RETRIGGER_ATTEMPTS) await sleep(RETRIGGER_DELAY_MS);
    }
  }
}

async function handleVerified(
  workspace: { sessionId?: string; workspacePath?: string; workspaceIdentity?: string },
  sessionId: string,
  config: GoalVerifyConfig,
  traceId: string,
): Promise<void> {
  if (!agent) return;
  const target = { ...workspace, sessionId };
  const snapshot = (await agent.readSessionState({
    ...target,
    runtimePolicy: "existing-only",
  })) as SessionSnapshotShape | undefined;
  const goal = snapshot?.projection?.target;
  const objective = goal?.objective?.trim();
  if (!objective) {
    logger?.debug(traceId, "[zcode-go goal 复核] 会话无 goal（可能已被清除），跳过", {
      sessionId,
    });
    return;
  }
  const oKey = `${sessionId}::${objective.length}::${objective.slice(0, 120)}`;
  if ((roundsByGoal.get(oKey) ?? 0) >= config.maxRounds) {
    logger?.info(traceId, "[zcode-go goal 复核] 达到最大重触发轮数，放行完成", {
      sessionId,
      rounds: roundsByGoal.get(oKey),
      maxRounds: config.maxRounds,
    });
    return;
  }
  if (goal?.status && goal.status !== "complete") {
    // 等待期间用户已重新触发/暂停/清除——尊重用户动作
    logger?.debug(traceId, "[zcode-go goal 复核] goal 状态已变化，跳过", {
      sessionId,
      status: goal.status,
    });
    return;
  }

  await sleep(SETTLE_DELAY_MS);
  roundsByGoal.set(oKey, (roundsByGoal.get(oKey) ?? 0) + 1);
  logger?.info(traceId, "[zcode-go goal 复核] 触发重运行（模型将在原会话内自行复判）", {
    sessionId,
    round: roundsByGoal.get(oKey),
  });
  await retriggerOnce(workspace, sessionId, objective, traceId);
}

/** sessions-index 帧观察入口：goalStatus → "verified" 的边沿触发复核。 */
export function observeZcodeGoSessionsIndexFrame(
  workspace: { sessionId?: string; workspacePath?: string; workspaceIdentity?: string },
  wire: unknown,
): void {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  for (const entry of extractSessionGoalEntries(wire)) {
    const prev = lastGoalStatusBySession.get(entry.sessionId);
    if (entry.goalStatus) lastGoalStatusBySession.set(entry.sessionId, entry.goalStatus);
    if (entry.goalStatus !== "verified" || prev === "verified") continue;
    const traceId = randomUUID();
    if (inFlight.has(entry.sessionId)) {
      logger?.debug(traceId, "[zcode-go goal 复核] 该会话已有复核进行中，跳过", {
        sessionId: entry.sessionId,
      });
      continue;
    }
    inFlight.add(entry.sessionId);
    logger?.info(traceId, "[zcode-go goal 复核] 检测到 goal 完成", {
      sessionId: entry.sessionId,
    });
    void handleVerified(workspace, entry.sessionId, config, traceId)
      .catch((error: unknown) => {
        logger?.warn(traceId, "[zcode-go goal 复核] 复核流程异常（放行完成）", {
          sessionId: entry.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight.delete(entry.sessionId);
      });
  }
}

/** 桌面服务装配时调用（node.ts 容器）；重复调用幂等。 */
export function initZCodeGoGoalVerify(
  agentService: ZcodeGoGoalVerifyAgent,
  options?: { logger?: ZcodeGoGoalVerifyLogger },
): void {
  agent = agentService;
  logger = options?.logger ?? null;
  disposed = false;
}

export function disposeZCodeGoGoalVerify(): void {
  disposed = true;
  agent = null;
  lastGoalStatusBySession.clear();
  roundsByGoal.clear();
  inFlight.clear();
}
