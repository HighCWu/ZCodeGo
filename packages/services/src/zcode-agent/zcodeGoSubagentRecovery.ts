import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * zcode-go 并发子智能体断连自恢复（goal-keeper 标准版附属，桌面服务层实现）。
 *
 * 症状（实测）：一次派发 N 个并发后台子智能体时，共享协议通道一旦断开，N 个子
 * 智能体同一秒全部失败（连接关闭类错误），主模型收到全部失败结果后结束整轮——
 * 工作未完成即自动结束，且无重试。
 *
 * 产品意图（用户明确要求）：**让子智能体自己恢复**，不向父会话注入提示、不由父
 * 模型重新派发。恢复原语选型（源码核实）：
 *   - v4 retryTurn：投影 resolver 要求 row.actions.canRetry，而 canRetry 只标在
 *     「最新 assistant state===complete」的行上——失败轮被 guard.actionUnavailable 拒绝。
 *   - SendMessage（resumeTerminalAgentInBackground，resumeFromStore）：官方恢复路径，
 *     但它是父会话模型轮内的工具调用，host 层无法直接驱动。
 *   - ✅ v4 sendText 直达子会话：子会话是普通持久会话（官方 UI 本就支持下钻订阅
 *     conversation/<childSessionId>）；sendText 在其原有 transcript（任务 + 已有进度）
 *     上追加一轮，模型从既有进度继续——与 SendMessage resume 同构的「自己恢复」。
 *
 * 检测与门槛（全部走官方 v4 协议面，不 tail 日志）：
 *   1. 会话帧里 kind==="subagent" 且 status==="failed" 且带 childSessionId 的行，
 *      summaryText（投影自 SubagentStopped payload.error）命中连接关闭类错误正则；
 *   2. 静置 30s（等抖动窗口与通道重连稳定）且父会话 control.phase 非 running
 *      （父模型已无机会自行重派发，避免与父会话自己的失败处理撞车重复干活）；
 *   3. 恢复前订阅子会话核验：control.phase 非 running 且最后一轮 turnHeader.state
 *      ==="failed"（协议级区分真失败与用户中断 completedInterrupted，用户中断不恢复）；
 *   4. 去重：按失败行 endedAt 判「新失败」，快照重放的同一条失败不重复恢复。
 *
 * 边界：每子会话 60 分钟窗口内最多恢复 2 次；同时恢复中的子会话 ≤8；恢复消息
 * 可见地留在子会话 transcript 中（用户下钻即可见，透明可审计）。
 *
 * 配置：~/.zcode-go/config.json
 *   { "subagentRecovery": { "enabled": true, "maxPerChild": 2, "quietWindowSeconds": 30 } }
 */
const STATE_DIR = join(homedir(), ".zcode-go");

const CLIENT_ID = "zcode-go-subagent-recovery";
const SUBSCRIBER_SCOPE = "zcode-go-subagent-recovery";
/** 失败静置窗口默认值：最后一次看到该失败 30s 后才动手（等抖动过去、通道重连稳定）。 */
const DEFAULT_QUIET_WINDOW_MS = 30_000;
/** 失败 observation 有效期：超时未满足恢复条件则放弃（如父会话一直 running）。 */
const PENDING_TTL_MS = 10 * 60_000;
/** 每子会话恢复次数的滑动窗口。 */
const RETRY_WINDOW_MS = 60 * 60_000;
const MAX_CONCURRENT_RECOVERIES = 8;
const CHILD_SNAPSHOT_WAIT_MS = 15_000;
const SEND_ATTEMPTS = 3;

// 实测报错样例 "ZCode Protocol client connection closed"；另覆盖常见传输断开措辞。
const CONNECTION_ERROR =
  /connection closed|client is disposed|protocol disposed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network (failed|error)|fetch failed|terminated/i;

export interface ZcodeGoSubagentRecoveryLogger {
  info(traceId: string | undefined, message: string, extra?: unknown): void;
  warn(traceId: string | undefined, message: string, extra?: unknown): void;
  debug(traceId: string | undefined, message: string, extra?: unknown): void;
}

/** 会话寻址公共参数（workspace 透传自父会话帧观察点）。 */
type SessionTarget = {
  sessionId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  subscriberScope?: string;
};

export interface ZcodeGoSubagentRecoveryAgent {
  subscribeConversationV4(params: SessionTarget & { visibility?: "foreground" | "background" }): Promise<{
    ack: { subscriptionId: string };
  }>;
  unsubscribeConversationV4(params: SessionTarget & { subscriptionId: string }): Promise<unknown>;
  sendConversationCommandV4(params: SessionTarget & {
    envelope: {
      commandId: string;
      clientId: string;
      sessionId: string | null;
      type: "sendText";
      payload: { text: string };
      issuedAt: number;
    };
  }): Promise<unknown>;
}

interface SubagentRecoveryConfig {
  enabled: boolean;
  maxPerChild: number;
  quietWindowMs: number;
}

interface WorkspaceRef {
  sessionId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}

interface PendingRecovery {
  childSessionId: string;
  parentSessionId: string;
  failedRowEndedAt: number | undefined;
  workspace: WorkspaceRef;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface ChildSnapshotObservation {
  seen: boolean;
  phase: string | undefined;
  lastTurnHeaderState: string | undefined;
}

let agent: ZcodeGoSubagentRecoveryAgent | null = null;
let logger: ZcodeGoSubagentRecoveryLogger | null = null;
let disposed = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

const pending = new Map<string, PendingRecovery>();
/** sessionId → 最近观察到的 control.phase（父会话空闲门槛）。 */
const phaseBySession = new Map<string, string>();
/** childSessionId → 已执行的恢复时间戳列表（滑动窗口限额）。 */
const attemptsByChild = new Map<string, number[]>();
/** childSessionId → 已处理失败行的 endedAt（快照重放去重）。 */
const handledFailureEndedAt = new Map<string, number>();
const inFlight = new Set<string>();
/** childSessionId → 恢复流程等待的子会话快照观察器。 */
const childObservers = new Map<string, ChildSnapshotObservation>();

/** 配置读取带 10s TTL 缓存：readConfig 位于每帧分发路径，同步文件 I/O 不可每帧做。 */
let configCache: { at: number; value: SubagentRecoveryConfig } | null = null;
const CONFIG_TTL_MS = 10_000;

function readConfig(): SubagentRecoveryConfig {
  if (configCache && Date.now() - configCache.at <= CONFIG_TTL_MS) return configCache.value;
  const defaults: SubagentRecoveryConfig = { enabled: true, maxPerChild: 2, quietWindowMs: DEFAULT_QUIET_WINDOW_MS };
  const resolved = (() => {
    try {
      const path = join(STATE_DIR, "config.json");
      if (!existsSync(path)) return defaults;
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        subagentRecovery?: { enabled?: boolean; maxPerChild?: number; quietWindowSeconds?: number };
      };
      return {
        enabled: raw.subagentRecovery?.enabled !== false,
        maxPerChild: Math.max(1, Math.min(5, raw.subagentRecovery?.maxPerChild ?? 2)),
        quietWindowMs: Math.max(5_000, Math.min(300_000, (raw.subagentRecovery?.quietWindowSeconds ?? 30) * 1_000)),
      };
    } catch {
      return defaults;
    }
  })();
  configCache = { at: Date.now(), value: resolved };
  return resolved;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function attemptsInWindow(childSessionId: string): number {
  const now = Date.now();
  const list = (attemptsByChild.get(childSessionId) ?? []).filter((t) => now - t <= RETRY_WINDOW_MS);
  attemptsByChild.set(childSessionId, list);
  return list.length;
}

interface FrameRowShape {
  rowId?: number;
  kind?: string;
  status?: string;
  summaryText?: string;
  childSessionId?: string;
  endedAt?: number;
  state?: string;
}

interface FrameShape {
  topic?: string;
  sentAt?: number;
  payload?: {
    kind?: string;
    snapshot?: {
      sessionId?: unknown;
      control?: { phase?: unknown };
      rows?: { window?: unknown };
    };
    deltas?: Array<{ op?: string; row?: unknown; patch?: { control?: { phase?: unknown } } }>;
  };
}

function topicSessionId(frame: FrameShape): string | undefined {
  const topic = frame.topic;
  return typeof topic === "string" && topic.startsWith("conversation/")
    ? topic.slice("conversation/".length)
    : undefined;
}

function extractFailedSubagentRows(frame: FrameShape): FrameRowShape[] {
  const payload = frame.payload;
  if (!payload) return [];
  const rows: FrameRowShape[] = [];
  const consider = (row: unknown): void => {
    if (typeof row !== "object" || row === null) return;
    const r = row as FrameRowShape;
    if (r.kind !== "subagent" || r.status !== "failed") return;
    if (typeof r.childSessionId !== "string" || !r.childSessionId.startsWith("sess_")) return;
    rows.push(r);
  };
  if (payload.kind === "snapshot" && payload.snapshot) {
    const window = payload.snapshot.rows?.window;
    if (Array.isArray(window)) for (const row of window) consider(row);
  } else if (payload.kind === "deltas" && Array.isArray(payload.deltas)) {
    for (const d of payload.deltas) if (d.op === "row.appended" || d.op === "row.upserted") consider(d.row);
  }
  return rows;
}

function trackPhase(frame: FrameShape): void {
  const payload = frame.payload;
  if (!payload) return;
  const apply = (sessionId: unknown, phase: unknown): void => {
    if (typeof sessionId === "string" && sessionId && typeof phase === "string" && phase) {
      phaseBySession.set(sessionId, phase);
    }
  };
  if (payload.kind === "snapshot" && payload.snapshot) {
    apply(payload.snapshot.sessionId, payload.snapshot.control?.phase);
    return;
  }
  if (payload.kind === "deltas" && Array.isArray(payload.deltas)) {
    const sessionId = topicSessionId(frame);
    for (const d of payload.deltas) {
      if (d.patch?.control?.phase !== undefined) apply(sessionId, d.patch.control.phase);
    }
  }
}

/**
 * conversation 帧观察入口（zcodeAgentService 帧分发点调用，该 workspace 全部会话帧
 * 流经此处）。按 topic 路由：恢复流程等待中的子会话快照喂给核验观察器；失败子智能
 * 体行入待恢复队列。
 */
export function observeZcodeGoSubagentRecoveryFrame(workspace: WorkspaceRef, wire: unknown): void {
  if (!agent || disposed) return;
  if (typeof wire !== "object" || wire === null) return;
  const frame = wire as FrameShape;
  trackPhase(frame);

  const frameSessionId = topicSessionId(frame);
  if (frameSessionId && childObservers.size > 0 && frame.payload?.kind === "snapshot" && frame.payload.snapshot) {
    const observer = childObservers.get(frameSessionId);
    const snap = frame.payload.snapshot;
    if (observer) {
      observer.phase = typeof snap.control?.phase === "string" ? snap.control.phase : undefined;
      const window = snap.rows?.window;
      if (Array.isArray(window)) {
        let latestHeader: FrameRowShape | null = null;
        for (const row of window) {
          if (typeof row !== "object" || row === null) continue;
          const r = row as FrameRowShape;
          if (r.kind === "turnHeader" && typeof r.rowId === "number" && (!latestHeader || r.rowId > (latestHeader.rowId ?? -1))) {
            latestHeader = r;
          }
        }
        if (latestHeader) observer.lastTurnHeaderState = latestHeader.state;
      }
      observer.seen = true;
    }
  }

  const config = readConfig();
  if (!config.enabled) return;

  for (const row of extractFailedSubagentRows(frame)) {
    const childSessionId = row.childSessionId as string;
    // 快照重放去重：同一条失败（endedAt 相同）只处理一次。
    const handledAt = handledFailureEndedAt.get(childSessionId);
    const endedAt = typeof row.endedAt === "number" ? row.endedAt : undefined;
    if (handledAt !== undefined && (endedAt === undefined || endedAt <= handledAt)) continue;
    // 失败年龄守卫（host 重启后内存水位清零，历史失败随快照重放不可再恢复）：
    // endedAt 与帧 sentAt 同为 CLI 时钟，相减无跨钟偏差；超过 observation 有效期即放弃。
    if (endedAt !== undefined && typeof frame.sentAt === "number" && frame.sentAt - endedAt > PENDING_TTL_MS) {
      handledFailureEndedAt.set(childSessionId, endedAt);
      continue;
    }
    const errorText = typeof row.summaryText === "string" ? row.summaryText : "";
    if (!CONNECTION_ERROR.test(errorText)) {
      logger?.debug(randomUUID(), "[zcode-go 子任务恢复] 非连接类失败，不自动恢复", { childSessionId, errorText: errorText.slice(0, 160) });
      handledFailureEndedAt.set(childSessionId, endedAt ?? Date.now());
      continue;
    }
    const existing = pending.get(childSessionId);
    const now = Date.now();
    if (existing) {
      existing.lastSeenAt = now;
      if (endedAt !== undefined) existing.failedRowEndedAt = endedAt;
    } else {
      const parentSessionId = frameSessionId ?? workspace.sessionId ?? "";
      pending.set(childSessionId, {
        childSessionId,
        parentSessionId,
        failedRowEndedAt: endedAt,
        workspace: { workspacePath: workspace.workspacePath, workspaceIdentity: workspace.workspaceIdentity },
        firstSeenAt: now,
        lastSeenAt: now,
      });
      logger?.info(randomUUID(), "[zcode-go 子任务恢复] 检测到连接类子智能体失败，进入静置窗口", {
        childSessionId,
        parentSessionId,
        errorText: errorText.slice(0, 160),
      });
    }
  }
}

/** 恢复前核验：订阅子会话，等首份快照，确认空闲且最后一轮确为失败态。 */
async function verifyChildIdleAndFailed(
  workspace: WorkspaceRef,
  childSessionId: string,
  traceId: string,
): Promise<boolean> {
  const svc = agent;
  if (!svc) return false;
  const observer: ChildSnapshotObservation = { seen: false, phase: undefined, lastTurnHeaderState: undefined };
  childObservers.set(childSessionId, observer);
  let subscriptionId: string | null = null;
  try {
    const sub = await svc.subscribeConversationV4({
      ...workspace,
      sessionId: childSessionId,
      subscriberScope: SUBSCRIBER_SCOPE,
      visibility: "background",
    });
    subscriptionId = sub.ack.subscriptionId;
    const deadline = Date.now() + CHILD_SNAPSHOT_WAIT_MS;
    while (Date.now() < deadline && !observer.seen) await sleep(500);
    if (!observer.seen) {
      logger?.warn(traceId, "[zcode-go 子任务恢复] 子会话快照超时，放弃本次恢复", { childSessionId });
      return false;
    }
    if (observer.phase === "running" || observer.phase === "prewarming" || observer.phase === "draft") {
      logger?.debug(traceId, "[zcode-go 子任务恢复] 子会话仍在运行，不恢复", { childSessionId, phase: observer.phase });
      return false;
    }
    if (observer.lastTurnHeaderState !== "failed") {
      logger?.debug(traceId, "[zcode-go 子任务恢复] 子会话最后一轮非失败态，不恢复", { childSessionId, lastTurnState: observer.lastTurnHeaderState ?? "none" });
      return false;
    }
    return true;
  } catch (error) {
    logger?.warn(traceId, "[zcode-go 子任务恢复] 子会话核验异常，放弃本次恢复", {
      childSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    childObservers.delete(childSessionId);
    if (subscriptionId) {
      void svc
        .unsubscribeConversationV4({
          ...workspace,
          sessionId: childSessionId,
          subscriptionId,
          subscriberScope: SUBSCRIBER_SCOPE,
        })
        .catch(() => {});
    }
  }
}

async function sendResume(workspace: WorkspaceRef, childSessionId: string, traceId: string): Promise<boolean> {
  if (!agent) return false;
  // 英文提示词（与 goal 复核同规则：避免用户选择无中文能力的提供商）。
  const text =
    "Your previous turn was cut off by a transport failure (the connection dropped mid-turn); the connection has now been restored.\n\n" +
    "Continue your assigned task from your existing progress in this conversation. Do not redo work that already succeeded — pick up exactly where you stopped. " +
    "If the remaining work is already done, verify it briefly and produce the final result/summary as originally requested.";
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    try {
      const ack = (await agent.sendConversationCommandV4({
        ...workspace,
        sessionId: childSessionId,
        subscriberScope: SUBSCRIBER_SCOPE,
        envelope: {
          commandId: randomUUID(),
          clientId: CLIENT_ID,
          sessionId: childSessionId,
          type: "sendText",
          payload: { text },
          issuedAt: Date.now(),
        },
      })) as { status?: string } | undefined;
      if (ack?.status === "accepted" || ack?.status === "duplicate") {
        logger?.info(traceId, "[zcode-go 子任务恢复] 已向子会话发送续跑消息（子智能体自行恢复）", { childSessionId });
        return true;
      }
      logger?.warn(traceId, "[zcode-go 子任务恢复] 续跑消息未被接受，将重试", { childSessionId, attempt, status: ack?.status ?? "no-ack" });
    } catch (error) {
      logger?.warn(traceId, "[zcode-go 子任务恢复] 续跑消息发送异常，将重试", {
        childSessionId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (attempt < SEND_ATTEMPTS) await sleep(5_000);
  }
  return false;
}

async function recoverChild(entry: PendingRecovery, config: SubagentRecoveryConfig): Promise<void> {
  const traceId = randomUUID();
  const { childSessionId } = entry;
  inFlight.add(childSessionId);
  try {
    if (!(await verifyChildIdleAndFailed(entry.workspace, childSessionId, traceId))) return;
    if (attemptsInWindow(childSessionId) >= config.maxPerChild) {
      logger?.warn(traceId, "[zcode-go 子任务恢复] 该子会话恢复次数达窗口上限，放行", { childSessionId, attempts: config.maxPerChild });
    } else if (await sendResume(entry.workspace, childSessionId, traceId)) {
      const list = attemptsByChild.get(childSessionId) ?? [];
      list.push(Date.now());
      attemptsByChild.set(childSessionId, list);
    }
    // 无论发送成功与否，这条失败已处理；更新水位防止快照重放重复触发。
    handledFailureEndedAt.set(childSessionId, entry.failedRowEndedAt ?? Date.now());
  } finally {
    inFlight.delete(childSessionId);
  }
}

function parentIdle(parentSessionId: string): boolean {
  const phase = phaseBySession.get(parentSessionId);
  // 未见父会话相位时保守放行（失败静置窗口已隔离大多数竞态）。
  return phase === undefined || (phase !== "running" && phase !== "prewarming");
}

function sweep(): void {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  const now = Date.now();
  // Map 迭代中删除当前项是安全的（JS 规范保证）。
  for (const [childSessionId, entry] of pending.entries()) {
    if (inFlight.has(childSessionId)) continue;
    if (now - entry.firstSeenAt > PENDING_TTL_MS) {
      pending.delete(childSessionId);
      logger?.warn(randomUUID(), "[zcode-go 子任务恢复] 等待恢复条件超时，放弃", { childSessionId, parentPhase: phaseBySession.get(entry.parentSessionId) ?? "unknown" });
      continue;
    }
    if (now - entry.lastSeenAt < config.quietWindowMs) continue;
    if (!parentIdle(entry.parentSessionId)) continue;
    if (inFlight.size >= MAX_CONCURRENT_RECOVERIES) return;
    pending.delete(childSessionId);
    void recoverChild(entry, config).catch((error: unknown) => {
      logger?.warn(randomUUID(), "[zcode-go 子任务恢复] 恢复流程异常", {
        childSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/** 桌面服务装配时调用（node.ts 容器）；重复调用幂等。 */
export function initZCodeGoSubagentRecovery(
  agentService: ZcodeGoSubagentRecoveryAgent,
  options?: { logger?: ZcodeGoSubagentRecoveryLogger },
): void {
  agent = agentService;
  logger = options?.logger ?? null;
  disposed = false;
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      try {
        sweep();
      } catch {
        /* 单轮扫描异常不影响下一轮 */
      }
    }, 5_000);
    sweepTimer.unref?.();
  }
}

export function disposeZCodeGoSubagentRecovery(): void {
  disposed = true;
  agent = null;
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  pending.clear();
  phaseBySession.clear();
  attemptsByChild.clear();
  handledFailureEndedAt.clear();
  inFlight.clear();
  childObservers.clear();
}
