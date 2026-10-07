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
 * 复核消息带隐藏标记（shared ZCODE_GO_GOAL_VERIFY_MARKER + 本次复核唯一
 * tag），UI 渲染层按前缀隐藏复核轮的行；消息保留在会话存储中作为模型后续
 * 上下文。回复收集按「标记 tag → turnId」绑定：只有本次发送的判定输入行
 * 才能绑定 collector——订阅快照重放的旧复核轮、其它轮次的行一律不参与，
 * 多轮/并发复核互不串扰。
 *
 * 帧结构注意（历史教训，zcodeGoSubagentRecovery 头注）：分发点传入的是
 * wire 层候选——complete 帧逻辑载荷在 frame 键内、大帧为 fragment 分片，
 * 必须经 extractLogicalFramePayload 提取；直接读 wire 顶层 payload 键恒空。
 * sessions-index 的快照重放只建基线不触发边沿（活跃会话必先以非终态进入
 * 基线，与 taskIndexSyncer/keepAlive 同口径），否则启动即对全部历史
 * verified goal 复核风暴。
 *
 * 不修改运行时 goal 状态机——全部走官方 v4 协议面。
 * （150% 额度签名链路经实测位于官方 CLI 运行时 zcode.cjs 而非 host，
 * host 为开源账户面代码，本修改不影响额度链路。）
 *
 * 配置：~/.zcode-go/config.json
 *   { "goalVerify": { "enabled": true, "maxRounds": 3 } }
 */
import { existsSync, readFileSync } from "node:fs";
import { extractLogicalFramePayload } from "./zcodeGoWireFrame.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isZcodeGoGoalVerifyMarkerText,
  ZCODE_GO_GOAL_VERIFY_MARKER,
} from "@zcode/shared";

const CLIENT_ID = "zcode-go-goal-verify";
const SUBSCRIBER_SCOPE = "zcode-go-goal-verify";
// 测试可整体缩放节奏（阈值与轮询同乘一个因子，判定语义不变）
const TIMING_SCALE = Math.max(
  0.001,
  Number(process.env.ZCODE_GO_GOAL_VERIFY_TIMING_SCALE ?? "1") || 1,
);
const SETTLE_DELAY_MS = Math.round(3_000 * TIMING_SCALE);
const REPLY_TIMEOUT_MS = Math.round(240_000 * TIMING_SCALE);
const REPLY_STABLE_MS = Math.round(4_000 * TIMING_SCALE);
const NO_TURN_ABORT_MS = Math.round(30_000 * TIMING_SCALE);
const POLL_MS = Math.max(5, Math.round(1_000 * TIMING_SCALE));
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
    workspacePath: string;
    workspaceIdentity?: string;
    subscriberScope?: string;
    visibility?: "foreground" | "background";
  }): Promise<{ ack: { subscriptionId: string } }>;
  unsubscribeConversationV4(params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    subscriptionId: string;
    subscriberScope?: string;
  }): Promise<unknown>;
  sendConversationCommandV4(params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    subscriberScope?: string;
    envelope: {
      commandId: string;
      clientId: string;
      sessionId: string | null;
      type: "sendText" | "sendGoalCommand";
      payload: unknown;
      issuedAt: number;
    };
  }): Promise<unknown>;
  readSession(params: {
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

/** legacy 会话快照的 goal（zcodeSessionInfoSchema.target，status 枚举含 "complete"）。 */
interface SessionSnapshotShape {
  session?: {
    target?: {
      objective?: string;
      status?: string;
    } | null;
  };
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

/** 回复收集器：按会话 id 键控（同一 workspace 多会话并发复核互不覆盖）。 */
const replyCollectors = new Map<
  string,
  { verifyTag: string; turnId: string | null; text: string; lastAppendAt: number }
>();

// STATE_DIR 惰性求值（测试可用 ZCODE_GO_STATE_DIR_OVERRIDE 隔离，防读到真实配置）。
function stateDir(): string {
  return process.env.ZCODE_GO_STATE_DIR_OVERRIDE || join(homedir(), ".zcode-go");
}

function readConfig(): GoalVerifyConfig {
  const defaults: GoalVerifyConfig = { enabled: true, maxRounds: 3 };
  try {
    const path = join(stateDir(), "config.json");
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
  const logical = extractLogicalFramePayload(wire);
  if (!logical) return [];
  const rows: FrameRowShape[] = [];
  if (logical.kind === "deltas") {
    for (const d of logical.deltas ?? []) {
      const delta = d as { op?: string; row?: unknown };
      if (
        (delta.op === "row.appended" || delta.op === "row.upserted") &&
        typeof delta.row === "object" &&
        delta.row !== null
      ) {
        rows.push(delta.row as FrameRowShape);
      }
    }
  } else {
    const window = (logical.snapshot as { rows?: { window?: unknown } } | null)?.rows?.window;
    if (Array.isArray(window)) for (const r of window) rows.push(r as FrameRowShape);
  }
  return rows;
}

/**
 * 复核输入行的标记解析：`<marker> <verifyTag> r1`。旧格式（无 tag，直接
 * `r1`）返回 null——旧轮次的行不匹配任何新 collector，天然不串扰。
 */
function goalVerifyMarkerTag(text: string): string | null {
  if (!isZcodeGoGoalVerifyMarkerText(text)) return null;
  const rest = text.slice(ZCODE_GO_GOAL_VERIFY_MARKER.length).trimStart();
  const first = rest.split(/\s+/, 1)[0] ?? "";
  // 旧格式首 token 即轮次标签（r1/r2），没有唯一 tag
  if (/^r\d/.test(first)) return null;
  return first || null;
}

export function observeZcodeGoConversationFrame(workspace: unknown, wire: unknown): void {
  if (replyCollectors.size === 0) return;
  const rows = extractConversationRows(wire);
  if (rows.length === 0) return;
  for (const row of rows) {
    if (row.kind === "userInput" && typeof row.text === "string") {
      const tag = goalVerifyMarkerTag(row.text);
      if (tag === null) continue;
      for (const collector of replyCollectors.values()) {
        if (collector.verifyTag === tag && !collector.turnId && row.turnId) {
          collector.turnId = row.turnId;
        }
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
  workspace: { sessionId?: string; workspacePath: string; workspaceIdentity?: string },
  sessionId: string,
  verifyTag: string,
  text: string,
  traceId: string,
): Promise<{ passed: boolean; reason: string } | null> {
  if (!agent) return null;

  const sub = await agent.subscribeConversationV4({
    ...workspace,
    sessionId,
    subscriberScope: SUBSCRIBER_SCOPE,
    visibility: "background",
  });
  const collector = { verifyTag, turnId: null as string | null, text: "", lastAppendAt: Date.now() };
  replyCollectors.set(sessionId, collector);
  try {
    // 发送失败（传输异常/被拒）重试数次
    let accepted = false;
    for (let attempt = 1; attempt <= 3 && !accepted; attempt += 1) {
      try {
        const ack = (await agent.sendConversationCommandV4({
          ...workspace,
          sessionId,
          subscriberScope: SUBSCRIBER_SCOPE,
          envelope: {
            commandId: randomUUID(),
            clientId: CLIENT_ID,
            sessionId,
            type: "sendText",
            payload: { text },
            issuedAt: Date.now(),
          },
        })) as { status?: string } | undefined;
        accepted = ack?.status === "accepted";
        if (!accepted) {
          logger?.warn(traceId, "[zcode-go goal 复核] 复核消息未被接受，将重试", {
            sessionId,
            attempt,
            status: ack?.status ?? "no-ack",
          });
        }
      } catch (error) {
        logger?.warn(traceId, "[zcode-go goal 复核] 复核消息发送异常，将重试", {
          sessionId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!accepted && attempt < 3) await sleep(5_000);
    }
    if (!accepted) {
      logger?.warn(traceId, "[zcode-go goal 复核] 复核消息多次发送失败，放行完成", { sessionId });
      return null;
    }
    const startedAt = Date.now();
    const deadline = startedAt + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const stableFor = Date.now() - collector.lastAppendAt;
      if (collector.text) {
        const verdict = verdictFromText(collector.text);
        if (verdict && stableFor >= REPLY_STABLE_MS) return verdict;
      }
      if (!collector.turnId && Date.now() - startedAt > NO_TURN_ABORT_MS) {
        logger?.warn(traceId, "[zcode-go goal 复核] 复核输入未被运行时确认（30s 无 turn）", {
          sessionId,
        });
        return null;
      }
    }
    logger?.warn(traceId, "[zcode-go goal 复核] 复核回复超时，放行完成", { sessionId });
    return null;
  } finally {
    replyCollectors.delete(sessionId);
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

function judgmentPrompt(verifyTag: string, objective: string): string {
  return (
    `${ZCODE_GO_GOAL_VERIFY_MARKER} ${verifyTag} r1\n` +
    `The session goal (GOAL) is:\n${objective}\n\n` +
    "This goal was previously marked as complete, but that verdict may be wrong.\n" +
    "Judge from the conversation context alone whether the goal has actually been completed.\n" +
    "Do not call tools and do not investigate files or commands \u2014 context awareness only. Reply immediately and briefly, without an extended reasoning phase.\n" +
    "Superficial, partial, or plan-only completion counts as not complete; when in doubt, treat it as not complete.\n\n" +
    'On the first line, output only the verdict JSON: {"passed": true or false, "reason": "one-sentence justification"}. ' +
    "A brief explanation may follow. Write the reason in the primary natural language of the objective."
  );
}

function doubleCheckPrompt(verifyTag: string, objective: string): string {
  return (
    `${ZCODE_GO_GOAL_VERIFY_MARKER} ${verifyTag} r2\n` +
    `The session goal (GOAL) is:\n${objective}\n\n` +
    "To avoid misjudgment on complex projects, discard your previous conclusion and re-judge from the " +
    "conversation context alone whether the goal above has truly been completed. Do not call tools or investigate. Reply immediately and briefly.\n" +
    "Superficial, partial, or plan-only completion counts as not complete; when in doubt, treat it as not complete.\n" +
    'On the first line, output only the JSON: {"passed": true or false, "reason": "one-sentence justification"}.'
  );
}

async function retriggerGoal(
  workspace: { sessionId?: string; workspacePath: string; workspaceIdentity?: string },
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
          issuedAt: Date.now(),
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
  workspace: { sessionId?: string; workspacePath: string; workspaceIdentity?: string },
  sessionId: string,
  config: GoalVerifyConfig,
  traceId: string,
): Promise<void> {
  if (!agent) return;
  const snapshot = (await agent.readSession({
    sessionId,
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
    runtimePolicy: "existing-only",
  })) as SessionSnapshotShape | undefined;
  // goal 在 legacy 快照的 session.target（zcodeSessionInfoSchema.target；
  // status 枚举 active/paused/budget_limited/complete）
  const goal = snapshot?.session?.target ?? null;
  const objective = goal?.objective?.trim();
  if (!objective) {
    logger?.debug(traceId, "[zcode-go goal 复核] 会话无 goal（可能已被清除），跳过", {
      sessionId,
    });
    return;
  }
  if (goal?.status && goal.status !== "complete") {
    logger?.debug(traceId, "[zcode-go goal 复核] goal 状态已变化，跳过", {
      sessionId,
      status: goal.status,
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

  const verifyTag = `v${randomUUID().slice(0, 8)}`;
  const first = await sendAndCollectVerdict(
    workspace,
    sessionId,
    verifyTag,
    judgmentPrompt(verifyTag, objective),
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
      verifyTag,
      doubleCheckPrompt(verifyTag, objective),
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
  workspace: { sessionId?: string; workspacePath: string; workspaceIdentity?: string },
  wire: unknown,
): void {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  const logical = extractLogicalFramePayload(wire);
  if (!logical) return;
  const fromSnapshot = logical.kind === "snapshot";
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
  if (logical.kind === "deltas") {
    for (const d of logical.deltas ?? []) {
      const delta = d as { op?: unknown; session?: { sessionId?: unknown; goalStatus?: unknown } };
      if (delta.op === "session.upserted") push(delta.session);
    }
  } else {
    const sessions = (logical.snapshot as { sessions?: unknown } | null)?.sessions;
    if (Array.isArray(sessions)) for (const s of sessions) push(s as never);
  }

  for (const entry of entries) {
    const prev = lastGoalStatusBySession.get(entry.sessionId);
    if (entry.goalStatus) lastGoalStatusBySession.set(entry.sessionId, entry.goalStatus);
    // 快照重放/无基线只建基线不触发边沿：活跃会话必先以非 verified 状态进入
    // 基线（gateway 每事件 fan-out），启动时对历史 verified goal 的快照回放
    // 不是新完成。
    if (fromSnapshot || prev === undefined) continue;
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
