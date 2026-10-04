import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * zcode-go 队列排空看门狗（goal-keeper 标准版附属，桌面服务层实现）。
 *
 * 产品规则：**只有用户在 turn 进行中点击聊天框的中断按钮（Stop）才允许
 * 队列暂停（held）**；其它一切情况（自动排空提升失败的竞态、turn 报错、
 * cancelled 无 preserve 标记等，v4-bridge/product-projection/turn 里的
 * H2/H3/H5 切换点）队列都必须持续排空。
 *
 * 运行时的 held 切换点（H1-H6）位于 CLI 侧，不可修改——本模块在 host 层
 * 观察会话队列状态（v4 conversation 帧），发现「队列非空 + autoDrain=false +
 * 含定时/自动化消息 + 非用户刚点过中断」时，自动发官方 setAutoDrain{true}
 * 恢复排空（turn 运行中只会武装不抢占；空闲则立即提升队首）。
 *
 * 用户中断意图由 desktop 的 stop 入口调用 notifyUserQueueStop() 记录
 * （10 分钟内有效）；期间的 held 视为用户意图，只记日志不恢复。
 *
 * 配置：~/.zcode-go/config.json
 *   { "queueDrain": { "enabled": true, "maxAutoRestores": 3 } }
 */
const STATE_DIR = join(homedir(), ".zcode-go");

export interface ZcodeGoQueueDrainLogger {
  info(traceId: string | undefined, message: string, extra?: unknown): void;
  warn(traceId: string | undefined, message: string, extra?: unknown): void;
  debug(traceId: string | undefined, message: string, extra?: unknown): void;
}

export interface ZcodeGoQueueDrainAgent {
  sendConversationCommandV4(params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    subscriberScope?: string;
    envelope: {
      commandId: string;
      clientId: string;
      sessionId: string | null;
      type: "setAutoDrain";
      payload: { autoDrain: boolean };
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

interface QueueDrainConfig {
  enabled: boolean;
  maxAutoRestores: number;
}

let agent: ZcodeGoQueueDrainAgent | null = null;
let logger: ZcodeGoGoalKeepAliveLoggerAlias | null = null;
let disposed = false;

type ZcodeGoGoalKeepAliveLoggerAlias = {
  info(traceId: string | undefined, message: string, extra?: unknown): void;
  warn(traceId: string | undefined, message: string, extra?: unknown): void;
  debug(traceId: string | undefined, message: string, extra?: unknown): void;
};

/** 用户中断意图（desktop stop 入口记录），10 分钟内有效。 */
const userStopIntents = new Map<string, number>();
/** 每会话自动恢复计数（滑动窗口：30 分钟内 ≤3 次）。 */
const autoRestoreLog = new Map<string, number[]>();

/** 配置读取带 10s TTL 缓存：readConfig 位于每帧分发路径，同步文件 I/O 不可每帧做。 */
let configCache: { at: number; value: QueueDrainConfig } | null = null;
const CONFIG_TTL_MS = 10_000;

function readConfig(): QueueDrainConfig {
  if (configCache && Date.now() - configCache.at <= CONFIG_TTL_MS) return configCache.value;
  const defaults: QueueDrainConfig = { enabled: true, maxAutoRestores: 3 };
  const resolved = (() => {
    try {
      const path = join(STATE_DIR, "config.json");
      if (!existsSync(path)) return defaults;
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        queueDrain?: { enabled?: boolean; maxAutoRestores?: number };
      };
      return {
        enabled: raw.queueDrain?.enabled !== false,
        maxAutoRestores: Math.max(1, Math.min(10, raw.queueDrain?.maxAutoRestores ?? defaults.maxAutoRestores)),
      };
    } catch {
      return defaults;
    }
  })();
  configCache = { at: Date.now(), value: resolved };
  return resolved;
}

export function notifyUserQueueStop(sessionId: string): void {
  userStopIntents.set(sessionId, Date.now());
}

function recentUserStop(sessionId: string): boolean {
  const at = userStopIntents.get(sessionId);
  return at !== undefined && Date.now() - at <= 10 * 60_000;
}

function restoreCountInWindow(sessionId: string): number {
  const now = Date.now();
  const list = (autoRestoreLog.get(sessionId) ?? []).filter((t) => now - t <= 30 * 60_000);
  autoRestoreLog.set(sessionId, list);
  return list.length;
}

interface QueueFrameShape {
  sessionId?: string;
  queue?: {
    autoDrain?: boolean;
    items?: Array<{
      queueItemId?: string;
      sourceCommandId?: string;
      automationId?: string;
      dispatch?: { state?: string };
    }>;
  } | null;
  stopReason?: string;
}

/** conversation 帧观察入口（zcodeAgentService 帧分发点调用）。 */
export function observeZcodeGoQueueDrainFrame(
  workspace: { sessionId?: string; workspacePath: string; workspaceIdentity?: string },
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
        snapshot?: { queue?: QueueFrameShape["queue"]; sessionId?: string };
        deltas?: Array<{ op?: unknown; state?: { queue?: QueueFrameShape["queue"]; sessionId?: string } }>;
      }
      | undefined;

  const states: Array<NonNullable<QueueFrameShape["queue"]>> = [];
  const pull = (queue: unknown, sessionId: unknown): void => {
    if (typeof queue === "object" && queue !== null && typeof sessionId === "string") {
      states.push(queue as NonNullable<QueueFrameShape["queue"]>);
    }
  };
  if (payload?.kind === "snapshot" && typeof payload.snapshot === "object" && payload.snapshot !== null) {
    const snap = payload.snapshot as { queue?: unknown; sessionId?: unknown };
    pull(snap.queue, snap.sessionId);
  } else if (payload?.kind === "deltas" && Array.isArray(payload.deltas)) {
    for (const d of payload.deltas) {
      const st = (d as { state?: unknown }).state as
        | { queue?: unknown; sessionId?: unknown }
        | undefined;
      if (st) pull(st.queue, st.sessionId);
    }
  }

  for (const q of states) {
    const sessionId = (q as { sessionId?: string }).sessionId;
    if (!sessionId) continue;
    const items = q.items ?? [];
    const queued = items.filter((i) => i.dispatch?.state === "queued");
    const hasAutomation = queued.some(
      (i) =>
        (typeof i.sourceCommandId === "string" && i.sourceCommandId.startsWith("automation-")) ||
        (typeof i.automationId === "string" && i.automationId),
    );
    if (q.autoDrain !== false || items.length === 0 || !hasAutomation) continue;

    if (recentUserStop(sessionId)) {
      logger?.debug(trace(), "[zcode-go 队列看门狗] 检测到用户中断后的 held，保持", {
        sessionId,
        queued: queued.length,
      });
      continue;
    }
    const restores = restoreCountInWindow(sessionId);
    if (restores >= config.maxAutoRestores) {
      logger?.warn(trace(), "[zcode-go 队列看门狗] 自动恢复次数达上限，保持 held", {
        sessionId,
        queued: queued.length,
      });
      continue;
    }
    const list = autoRestoreLog.get(sessionId) ?? [];
    list.push(Date.now());
    autoRestoreLog.set(sessionId, list);
    const traceId = trace();
    logger?.info(traceId, "[zcode-go 队列看门狗] 检测到非用户暂停的滞留队列，恢复排空", {
      sessionId,
      queued: queued.length,
      pauseReason: (q as { pauseReason?: string }).pauseReason ?? null,
      attempt: restores + 1,
    });
    void agent
      .sendConversationCommandV4({
        ...workspace,
        sessionId,
        subscriberScope: "zcode-go-queue-drain",
        envelope: {
          commandId: randomUUID(),
          clientId: CLIENT_ID,
          sessionId,
          type: "setAutoDrain",
          payload: { autoDrain: true },
          issuedAt: Date.now(),
        },
      })
      .catch((error: unknown) => {
        logger?.warn(traceId, "[zcode-go 队列看门狗] 恢复命令失败", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
}
}

function trace(): string {
  return `zcode-go-queue-drain-${Date.now()}`;
}

/** 桌面 stop 入口调用（用户点击中断按钮时）。 */
export function initZCodeGoQueueDrain(
  _agentService: ZcodeGoQueueDrainAgent,
  options?: { logger?: ZcodeGoGoalKeepAliveLoggerAlias },
): void {
  agent = _agentService;
  logger = options?.logger ?? null;
  disposed = false;
}

export function disposeZCodeGoQueueDrain(): void {
  disposed = true;
  agent = null;
  userStopIntents.clear();
  autoRestoreLog.clear();
}

const CLIENT_ID = "zcode-go-queue-drain";
