/**
 * zcode-go goal 完成复核（goal-keeper 标准版子集，桌面服务层实现）。
 *
 * 运行时把 goal 判为 complete（sessions-index goalStatus → "verified" 边沿）
 * 后，桌面在原会话内以 v4 sendText 发送我们自己的判定消息（GOAL 原文 +
 * JSON 返回格式要求；判定 turn 带只读工具，模型可真实核查——与用户手动
 * 提问同构）。模型按格式回复后解析：
 *   - passed=false → v4 sendGoalCommand 重触发原 objective（运行时既有
 *     语义：重置 active + 自动重驱动循环，未完成模型继续推进）
 *   - passed=true  → 追加二次确认（"为避免复杂项目误判请再认真判断一次"），
 *     再解析一次；仍 true 放行完成，false 重触发。
 * 复核消息带隐藏标记（shared ZCODE_GO_GOAL_VERIFY_MARKER），UI 渲染层
 * 据此隐藏复核轮的行；消息保留在会话存储中作为模型后续上下文。
 *
 * 不修改运行时 goal 状态机——全部走官方 v4 协议面。
 * （150% 额度签名链路经实测位于官方 CLI 运行时 zcode.cjs 而非 host，
 * host 为开源账户面代码，本修改不影响额度链路。）
 *
 * 配置：~/.zcode-go/config.json
 *   { "goalVerify": { "enabled": true, "maxRounds": 3 } }
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isZcodeGoGoalVerifyMarkerText,
  ZCODE_GO_GOAL_VERIFY_MARKER,
} from "@zcode/shared";

const CLIENT_ID = "zcode-go-goal-verify";
const SUBSCRIBER_SCOPE = "zcode-go-goal-verify";
const STATE_DIR = join(homedir(), ".zcode-go");
const SETTLE_DELAY_MS = 3_000;
const REPLY_TIMEOUT_MS = 240_000;
const REPLY_STABLE_MS = 4_000;
const RETRIGGER_ATTEMPTS = 5;
const RETRIGGER_DELAY_MS = 20_000;

export interface ZcodeGoGoalVerifyLogger {
  info(traceId: string | undefined, message: string, extra?: unknown): void;
  warn(traceId: string | undefined, message: string, extra?: unknown): void;
  debug(traceId: string | undefined, message: string, extra?: unknown): void;
}

export interface ZcodeGoGoalVerifyAgent {
  subscribeConversationV4(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    subscriberScope?: string;
    visibility?: "foreground" | "background";
  }): Promise<{ ack: { subscriptionId: string } }>;
  unsubscribeConversationV4(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    subscriptionId: string;
    subscriberScope?: string;
  }): Promise<unknown>;
  sendConversationCommandV4(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    subscriberScope?: string;
    envelope: {
      commandId: string;
      clientId: string;
      sessionId: string | null;
      type: "sendText" | "sendGoalCommand";
      payload: unknown;
      issuedAt: string;
    };
  }): Promise<unknown>;
  readSessionState(params: {
    sessionId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runtimePolicy?: string;
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

interface FrameRowShape {
  turnId?: string;
  kind?: string;
  text?: string;
}

let agent: ZcodeGoGoalVerifyAgent | null = null;
let logger: ZcodeGoGoalVerifyLogger | null = null;
let disposed = false;
const lastGoalStatusBySession = new Map<string, string>();
const roundsByGoal = new Map<string, number>();
const inFlight = new Set<string>();

const replyCollectors = new Map<
  string,
  { turnId: string | null; text: string; lastAppendAt: number }
>();

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

function extractConversationRows(wire: unknown): FrameRowShape[] {
  if (typeof wire !== "object" || wire === null) return [];
  const w = wire as { payload?: unknown };
  const payload = w.payload as
    | {
        kind?: string;
        snapshot?: { rows?: { window?: unknown } };
        deltas?: Array<{ op?: string; row?: unknown }>;
      }
      | undefined;
  const rows: FrameRowShape[] = [];
  if (payload?.kind === "deltas" && Array.isArray(payload.deltas)) {
    for (const d of payload.deltas) {
      if ((d.op === "row.appended" || d.op === "row.upserted") && typeof d.row === "object" && d.row !== null) {
        rows.push(d.row as FrameRowShape);
      }
    }
  } else if (payload?.kind === "snapshot") {
    const window = payload.snapshot?.rows?.window;
    if (Array.isArray(window)) for (const r of window) rows.push(r as FrameRowShape);
  }
  return rows;
}

export function observeZcodeGoConversationFrame(workspace: unknown, wire: unknown): void {
  if (replyCollectors.size === 0) return;
  const rows = extractConversationRows(wire);
  if (rows.length === 0) return;
  for (const row of rows) {
    if (row.kind === "userInput" && typeof row.text === "string" && isZcodeGoGoalVerifyMarkerText(row.text)) {
      for (const collector of replyCollectors.values()) {
        if (!collector.turnId && row.turnId) collector.turnId = row.turnId;
      }
      continue;
    }
    if (row.kind !== "assistantText" || typeof row.text !== "string" || !row.turnId) continue;
    for (const collector of replyCollectors.values()) {
      if (collector.turnId === row.turnId && row.text.length > collector.text.length) {
        collector.text = row.text;
        collector.lastAppendAt = Date.now();
      }
    }
  }
}

function verdictFromText(text: string): { passed: boolean; reason: string } | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let end = text.lastIndexOf("}"); end > start; end -= 1) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      if (typeof parsed.passed === "boolean") {
        return {
          passed: parsed.passed,
          reason: typeof parsed.reason === "string" ? parsed.reason : "",
        };
      }
    } catch {
      /* 缩窗重试 */
    }
  }
  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function sendAndCollectVerdict(
  workspace: { sessionId?: string; workspacePath?: string; workspaceIdentity?: string },
  sessionId: string,
  text: string,
  traceId: string,
): Promise<{ passed: boolean; reason: string } | null> {
  if (!agent) return null;
  const wsKey = workspace.workspacePath ?? workspace.workspaceIdentity ?? sessionId;
  const sub = await agent.subscribeConversationV4({
    ...workspace,
    sessionId,
    subscriberScope: SUBSCRIBER_SCOPE,
    visibility: "background",
  });
  const collector = { turnId: null as string | null, text: "", lastAppendAt: Date.now() };
  replyCollectors.set(wsKey, collector);
  try {
    await agent.sendConversationCommandV4({
      ...workspace,
      sessionId,
      subscriberScope: SUBSCRIBER_SCOPE,
      envelope: {
        commandId: randomUUID(),
        clientId: CLIENT_ID,
        sessionId,
        type: "sendText",
        payload: { text },
        issuedAt: new Date().toISOString(),
      },
    });
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(1_000);
      const stableFor = Date.now() - collector.lastAppendAt;
      if (collector.text) {
        const verdict = verdictFromText(collector.text);
        if (verdict && stableFor >= REPLY_STABLE_MS) return verdict;
      }
      if (!collector.turnId && Date.now() - (deadline - REPLY_TIMEOUT_MS) > 30_000) {
        logger?.warn(traceId, "[zcode-go goal 复核] 复核输入未被运行时确认（30s 无 turn）", {
          sessionId,
        });
        return null;
      }
    }
    logger?.warn(traceId, "[zcode-go goal 复核] 复核回复超时，放行完成", { sessionId });
    return null;
  } finally {
    replyCollectors.delete(wsKey);
    try {
      await agent.unsubscribeConversationV4({
        ...workspace,
        sessionId,
        subscriptionId: sub.ack.subscriptionId,
        subscriberScope: SUBSCRIBER_SCOPE,
      });
    } catch {
      /* 尽力而为 */
    }
  }
}

function judgmentPrompt(objective: string): string {
  return (
    `${ZCODE_GO_GOAL_VERIFY_MARKER} r1\n` +
    `本会话的目标（GOAL）原文如下：\n${objective}\n\n` +
    "该目标此前已被判定为完成，但判定可能有误。请你作为执行该目标的模型，认真核查它是否已经真正完成：\n" +
    "- 可以使用只读工具检查实际状态（读文件、运行只读命令、查看 todo 列表）。\n" +
    "- 不要修改任何文件、不要执行有副作用的命令。\n" +
    "- 逐条核对目标的每个显式要求（文件、命令、测试、验收条件）；表面完成、部分完成、仅计划完成都算未完成；有疑问按未完成处理。\n\n" +
    '第一行只输出复核结论 JSON：{"passed": true 或 false, "reason": "一句话依据"}，随后可补充简短说明。'
  );
}

function doubleCheckPrompt(objective: string): string {
  return (
    `${ZCODE_GO_GOAL_VERIFY_MARKER} r2\n` +
    "为避免复杂项目中的判断失误，请忽略你刚才的结论，重新独立核查一次上述目标是否真正完成：" +
    "再次逐条检查关键交付物、todo 状态与验收条件，宁可多查一轮。\n" +
    '第一行只输出 JSON：{"passed": true 或 false, "reason": "一句话依据"}。'
  );
}

async function retriggerGoal(
  workspace: { sessionId?: string; workspacePath?: string; workspaceIdentity?: string },
  sessionId: string,
  objective: string,
  traceId: string,
): Promise<void> {
  if (!agent) return;
  for (let attempt = 1; attempt <= RETRIGGER_ATTEMPTS; attempt += 1) {
    try {
      await agent.sendConversationCommandV4({
        ...workspace,
        sessionId,
        subscriberScope: SUBSCRIBER_SCOPE,
        envelope: {
          commandId: randomUUID(),
          clientId: CLIENT_ID,
          sessionId,
          type: "sendGoalCommand",
          payload: { text: objective },
          issuedAt: new Date().toISOString(),
        },
      });
      logger?.info(traceId, "[zcode-go goal 复核] 已重触发 goal（v4 sendGoalCommand → active + 自动续跑）", {
        sessionId,
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn(traceId, "[zcode-go goal 复核] 重触发失败（将重试）", {
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
  const snapshot = (await agent.readSessionState({
    sessionId,
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
    runtimePolicy: "existing-only",
  })) as SessionSnapshotShape | undefined;
  const objective = snapshot?.projection?.target?.objective?.trim();
  if (!objective) {
    logger?.debug(traceId, "[zcode-go goal 复核] 会话无 goal（可能已被清除），跳过", {
      sessionId,
    });
    return;
  }
  if (snapshot?.projection?.target?.status && snapshot.projection.target.status !== "complete") {
    logger?.debug(traceId, "[zcode-go goal 复核] goal 状态已变化，跳过", {
      sessionId,
      status: snapshot.projection.target.status,
    });
    return;
  }
  const oKey = `${sessionId}::${objective.length}::${objective.slice(0, 120)}`;
  if ((roundsByGoal.get(oKey) ?? 0) >= config.maxRounds) {
    logger?.info(traceId, "[zcode-go goal 复核] 达到最大复核轮数，放行完成", {
      sessionId,
      rounds: roundsByGoal.get(oKey),
    });
    return;
  }

  await sleep(SETTLE_DELAY_MS);
  roundsByGoal.set(oKey, (roundsByGoal.get(oKey) ?? 0) + 1);
  logger?.info(traceId, "[zcode-go goal 复核] 发送复核判定（原会话内，UI 隐藏）", {
    sessionId,
    round: roundsByGoal.get(oKey),
  });

  const first = await sendAndCollectVerdict(
    workspace,
    sessionId,
    judgmentPrompt(objective),
    traceId,
  );
  if (!first) {
    logger?.info(traceId, "[zcode-go goal 复核] 未取得有效判定，放行完成", { sessionId });
    return;
  }
  let verdict = first;
  if (verdict.passed) {
    logger?.info(traceId, "[zcode-go goal 复核] 首判通过，执行二次确认", {
      sessionId,
      reason: verdict.reason,
    });
    const second = await sendAndCollectVerdict(
      workspace,
      sessionId,
      doubleCheckPrompt(objective),
      traceId,
    );
    if (second) verdict = second;
    else {
      logger?.info(traceId, "[zcode-go goal 复核] 二次确认未取得有效判定，放行完成", {
        sessionId,
      });
      return;
    }
  }
  if (verdict.passed) {
    logger?.info(traceId, "[zcode-go goal 复核] 复核通过，保持完成", {
      sessionId,
      reason: verdict.reason,
    });
    return;
  }
  logger?.info(traceId, "[zcode-go goal 复核] 复核判定未完成，重触发 goal", {
    sessionId,
    reason: verdict.reason,
  });
  await retriggerGoal(workspace, sessionId, objective, traceId);
}

/** sessions-index 帧观察入口（goalStatus → "verified" 边沿）。 */
export function observeZcodeGoSessionsIndexFrame(
  workspace: { sessionId?: string; workspacePath?: string; workspaceIdentity?: string },
  wire: unknown,
): void {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  if (typeof wire !== "object" || wire === null) return;
  const w = wire as { payload?: unknown };
  const payload = w.payload as
    | {
        kind?: string;
        snapshot?: { sessions?: Array<{ sessionId?: unknown; goalStatus?: unknown }> };
        deltas?: Array<{ op?: unknown; session?: { sessionId?: unknown; goalStatus?: unknown } }>;
      }
      | undefined;
  const entries: Array<{ sessionId: string; goalStatus?: string }> = [];
  const push = (session: { sessionId?: unknown; goalStatus?: unknown } | undefined): void => {
    if (!session || typeof session !== "object") return;
    if (typeof session.sessionId === "string" && session.sessionId) {
      entries.push({
        sessionId: session.sessionId,
        goalStatus: typeof session.goalStatus === "string" ? session.goalStatus : undefined,
      });
    }
  };
  if (payload?.kind === "deltas" && Array.isArray(payload.deltas)) {
    for (const d of payload.deltas) if (d.op === "session.upserted") push(d.session);
  } else if (payload?.kind === "snapshot" && Array.isArray(payload.snapshot?.sessions)) {
    for (const s of payload.snapshot.sessions) push(s);
  }

  for (const entry of entries) {
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
    logger?.info(traceId, "[zcode-go goal 复核] 检测到 goal 完成，启动会话内复核", {
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
  replyCollectors.clear();
}
