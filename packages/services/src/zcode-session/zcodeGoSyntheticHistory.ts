/**
 * zcode-go：巨会话冷打开的合成订阅编排（host 服务层）。
 *
 * 官方 runtime 冷订阅以全量恢复为前提（144K part 实测 30s+，RPC 阻塞到超时）。
 * 本模块让「本地 + 巨会话 + 近期无 live 帧」的订阅立即拿到 host 合成的尾窗
 * 快照（DB 倒序懒读 + 行投影，见 zcodeGoHistorySynthesis），RPC 当即返回；
 * 真实 runtime 订阅在后台照常建立（不阻塞），其帧经中继层把 subscriptionId
 * 重写为合成号——renderer 全程只认一个订阅身份，live 帧无缝接管（快照
 * replace 语义自愈）。rowsRange 回填同样由 DB 直答，直到退订。
 *
 * 放行条件（缺一不可）：
 * - 本地 workspace（无 workspaceIdentity；远程 web 模式 V1 不启用）
 * - message 数 ≥ 阈值（~/.zcode-go/config.json lazyHistory.minMessages，默认 2000）
 * - 近期无该会话的 runtime 帧（live 会话走正常路径；帧到达即记 live，
 *   10 分钟懒过期——runtime 回收后允许再次合成）
 *
 * 订阅号重写与 silent-fork 的 topic 回写同技法、可叠加；重写按
 * (topic, 真实订阅号) 精确匹配，renderer 自行恢复重订时的新订阅不受影响。
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSessionHistoryLazyReader } from "./sessionHistoryLazyReader.js";
import { resolveZcodeGoSessionId } from "../zcode-agent/zcodeGoSessionRedirect.js";
import {
  SYNTHETIC_TAIL_MESSAGES,
  SYNTHETIC_PAGE_MESSAGES,
  synthesizeConversationSnapshot,
  synthesizeRowsRangePage,
} from "./zcodeGoHistorySynthesis.js";

const SYNTHETIC_PREFIX = "zgsynth-";
const LIVE_TTL_MS = 10 * 60 * 1000;

interface SyntheticWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface SyntheticSubscription {
  syntheticId: string;
  sessionId: string;
  topic: string;
  workspace: SyntheticWorkspace;
  realSubId: string | null;
  /** attach 时登记的回收回调：end 时调用方可能传 null（替换路径），仍要能回收真实订阅。 */
  unsubscribeReal: ((realSubId: string) => Promise<unknown>) | null;
  cancelled: boolean;
}

const syntheticSubscriptions = new Map<string, SyntheticSubscription>();
const syntheticBySession = new Map<string, string>();
/** topic → { realId → syntheticId }；中继层按 (topic, 真实订阅号) 重写。 */
const topicRewrites = new Map<string, Map<string, string>>();
const liveAt = new Map<string, number>();

function stateDir(): string {
  return process.env.ZCODE_GO_STATE_DIR_OVERRIDE || join(homedir(), ".zcode-go");
}

function readMinMessages(): number {
  try {
    const path = join(stateDir(), "config.json");
    if (!existsSync(path)) return 2000;
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      lazyHistory?: { minMessages?: number };
    };
    const value = raw.lazyHistory?.minMessages;
    return typeof value === "number" && value > 0 ? Math.round(value) : 2000;
  } catch {
    return 2000;
  }
}

function sessionDbPath(): string {
  // 与服务层数据根同源（ZCODE_DATA_BASE_DIR > HOME）
  const base = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(base, ".zcode", "cli", "db", "db.sqlite");
}

function isRecentlyLive(sessionId: string): boolean {
  const at = liveAt.get(sessionId);
  if (at === undefined) return false;
  if (Date.now() - at > LIVE_TTL_MS) {
    liveAt.delete(sessionId);
    return false;
  }
  return true;
}

export function isSyntheticSubscriptionId(subscriptionId: string): boolean {
  return subscriptionId.startsWith(SYNTHETIC_PREFIX);
}

/** 巨会话判定 + 合成快照构造（不 fire；调用方负责 emitter 与后台订阅）。 */
export function beginSyntheticHistorySubscription(
  params: SyntheticWorkspace & { sessionId: string; clientMode?: string },
): { subscriptionId: string; frame: unknown } | null {
  const sessionId = params.sessionId;
  if (!sessionId.startsWith("sess_")) return null;
  // 已有 redirect（此前 fork 过）→ 正常路径直接订阅小 fork，不再合成
  if (resolveZcodeGoSessionId(sessionId) !== sessionId) return null;
  // V1 仅本地桌面（远程 web 模式的 replayable 语义另议）
  if (params.workspaceIdentity?.trim()) return null;
  if (params.clientMode === "web-remote-replayable") return null;
  if (isRecentlyLive(sessionId)) return null;
  const dbPath = sessionDbPath();
  if (!existsSync(dbPath)) return null;
  const reader = openSessionHistoryLazyReader(dbPath);
  try {
    if (reader.countMessages(sessionId) < readMinMessages()) return null;
    const window = reader.readTailWindow(sessionId, SYNTHETIC_TAIL_MESSAGES);
    const modelSelection = reader.readModelSelection(sessionId);
    const snapshot = synthesizeConversationSnapshot(sessionId, window, "", modelSelection);
    const syntheticId = `${SYNTHETIC_PREFIX}${randomUUID()}`;
    const topic = `conversation/${sessionId}`;
    const subscriptionId = syntheticId;
    const frame = {
      wireVersion: 3,
      kind: "complete" as const,
      deliveryKind: "initial" as const,
      logicalFrameId: `lf-${randomUUID()}`,
      logicalFrameOrdinal: 1,
      topic,
      subscriptionId,
      frame: {
        topic,
        subscriptionId,
        fromSeq: 0,
        toSeq: 0,
        sentAt: Date.now(),
        payload: { kind: "snapshot" as const, snapshot },
      },
    };
    const previous = syntheticBySession.get(sessionId);
    if (previous) endSyntheticSubscription(previous, null);
    syntheticSubscriptions.set(syntheticId, {
      syntheticId,
      sessionId,
      topic,
      workspace: {
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
      realSubId: null,
      unsubscribeReal: null,
      cancelled: false,
    });
    syntheticBySession.set(sessionId, syntheticId);
    return { subscriptionId: syntheticId, frame };
  } finally {
    reader.close();
  }
}

/** 后台真实订阅完成：登记订阅号重写；若期间已退订则立即回收真实订阅。 */
export function attachRealSubscription(
  syntheticId: string,
  realSubId: string,
  unsubscribeReal: (realSubId: string) => Promise<unknown>,
): void {
  const entry = syntheticSubscriptions.get(syntheticId);
  if (!entry) {
    // 合成订阅已被 end（如 renderer 在后台订阅在途时重订）：真实订阅没人认领，
    // 必须当场回收——留着会在 runtime 侧成为僵尸订阅（帧持续下发但无人改写）。
    void unsubscribeReal(realSubId).catch(() => {});
    return;
  }
  if (entry.cancelled) {
    void unsubscribeReal(realSubId).catch(() => {});
    return;
  }
  entry.realSubId = realSubId;
  entry.unsubscribeReal = unsubscribeReal;
  let byReal = topicRewrites.get(entry.topic);
  if (!byReal) {
    byReal = new Map();
    topicRewrites.set(entry.topic, byReal);
  }
  byReal.set(realSubId, syntheticId);
}

/**
 * 中继层帧改写：真实订阅号 → 合成订阅号（renderer 只认合成身份）。
 * 同时记录 live（后续订阅不再合成）。返回改写后的 wire（原样返回非匹配帧）。
 */
export function rewriteSyntheticFrame<T extends { topic?: unknown; subscriptionId?: unknown }>(
  wire: T,
): T {
  const topic = typeof wire.topic === "string" ? wire.topic : null;
  const subId = typeof wire.subscriptionId === "string" ? wire.subscriptionId : null;
  if (!topic || !subId) return wire;
  const sessionId = topic.startsWith("conversation/") ? topic.slice("conversation/".length) : null;
  if (sessionId) liveAt.set(sessionId, Date.now());
  const rewrite = topicRewrites.get(topic)?.get(subId);
  if (!rewrite) return wire;
  const patched = { ...wire, subscriptionId: rewrite } as T;
  const inner = (wire as { frame?: { subscriptionId?: unknown; payload?: { kind?: unknown; snapshot?: { logEpoch?: unknown } } } })
    .frame;
  if (inner && typeof inner === "object") {
    // 内部快照的 logEpoch 一并改成合成 ack 的 epoch：否则 renderer 按 epoch
    // 失配走恢复环（fault.subscribe.resumeFailed 实测 ×10）。
    const payload =
      inner.payload && typeof inner.payload === "object" && inner.payload.kind === "snapshot"
        ? {
            ...inner.payload,
            snapshot:
              inner.payload.snapshot && typeof inner.payload.snapshot === "object"
                ? { ...inner.payload.snapshot, logEpoch: "zcode-go-synthetic" }
                : inner.payload.snapshot,
          }
        : inner.payload;
    (patched as { frame?: unknown }).frame = { ...inner, subscriptionId: rewrite, ...(payload ? { payload } : {}) };
  }
  return patched;
}

/** rowsRange 合成应答（该会话存在活跃合成订阅时）；否则 null 走正常路径。 */
export function syntheticRowsRange(params: {
  sessionId: string;
  beforeRowId?: number;
  limit?: number;
}): {
  rows: import("@zcode/shared/zcode-protocol-v4").ConversationRow[];
  atSeq: number;
  atRevision: number;
  atLogEpoch: string;
  hasMore: boolean;
} | null {
  const syntheticId = syntheticBySession.get(params.sessionId);
  if (!syntheticId || !syntheticSubscriptions.has(syntheticId)) return null;
  const dbPath = sessionDbPath();
  if (!existsSync(dbPath)) return null;
  const reader = openSessionHistoryLazyReader(dbPath);
  try {
    // rowId 基数 = sequence×1000；beforeRowId 反解为 message 序游标
    const before =
      typeof params.beforeRowId === "number" && params.beforeRowId > 0
        ? Math.floor(params.beforeRowId / 1000)
        : null;
    const limit =
      typeof params.limit === "number" && params.limit > 0
        ? Math.min(params.limit, SYNTHETIC_PAGE_MESSAGES)
        : SYNTHETIC_PAGE_MESSAGES;
    const window =
      before !== null
        ? reader.readPageBefore(params.sessionId, before, limit)
        : reader.readTailWindow(params.sessionId, limit);
    return synthesizeRowsRangePage(window, before);
  } finally {
    reader.close();
  }
}

/**
 * 合成订阅退订（renderer 侧）：标记取消 + 清理重写；真实订阅由调用方回收
 * （已挂接则退真实号，未挂接则由 attachRealSubscription 兜底回收）。
 * unsubscribeReal 参数为 null 时（begin 替换旧合成路径）使用 attach 时登记的
 * 回调——否则旧真实订阅泄漏成 runtime 僵尸。
 */
export function endSyntheticSubscription(
  subscriptionId: string,
  unsubscribeReal: ((realSubId: string) => Promise<unknown>) | null,
): void {
  const entry = syntheticSubscriptions.get(subscriptionId);
  if (!entry) return;
  entry.cancelled = true;
  syntheticSubscriptions.delete(subscriptionId);
  if (syntheticBySession.get(entry.sessionId) === subscriptionId) {
    syntheticBySession.delete(entry.sessionId);
  }
  const byReal = topicRewrites.get(entry.topic);
  if (entry.realSubId) {
    byReal?.delete(entry.realSubId);
    const recycle = unsubscribeReal ?? entry.unsubscribeReal;
    if (recycle) void recycle(entry.realSubId).catch(() => {});
  }
  if (byReal && byReal.size === 0) topicRewrites.delete(entry.topic);
}

/** 测试重置。 */
export function resetSyntheticHistoryForTest(): void {
  syntheticSubscriptions.clear();
  syntheticBySession.clear();
  topicRewrites.clear();
  liveAt.clear();
}
