/**
 * zcode-go 静默 fork 第二批：compaction 观测 armed + 静默点门控 + 自动触发。
 *
 * 设计（与用户共同推导定稿）：
 * - compaction 在帧流中以 timelineMarker 行投影（marker.type="compact"，
 *   status="success"）；观察者在帧中继处检测 online 增量 → armed[S]；
 * - 静默点 = 复合判定（无活跃 turn ∧ 无未决后台），事件驱动 + 周期巡检；
 * - 满足即发 host → main ZcodeGoSilentForkArm，main 执行 direct fork + redirect；
 * - 派发门闩（fork 事务期间短暂 hold 新派发）在 main 侧实现（第三批）。
 *
 * 本模块在 host（utility process）运行，通过 observeZcodeGoSilentForkFrame
 * 挂入帧中继；quiescence 用 readSession existing-only（不拉起新 runtime）。
 * delegate 未接线（CLI/server 无 silentForkArmSignal）时整个模块空转跳过。
 */
import type { ConversationTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";
import { getZcodeGoSessionRedirect } from "./zcodeGoSessionRedirect.js";
import { extractLogicalFramePayload, wireFrameTopic } from "./zcodeGoWireFrame.js";

/** armed 会话表：sessionId → { workspacePath, armedAt } */
const armedSessions = new Map<
  string,
  { workspacePath: string; workspaceIdentity?: string; armedAt: number }
>();

/**
 * arm 通知在途互斥：进入静默判定前占位、notify/拒绝后即清——事件与周期巡检
 * 并发时防同一会话双发。历史语义（「已通知永久去重」）是轮换链泄漏根因，
 * cb6051c 已改为此瞬时锁语义。
 */
const notifiedSessions = new Set<string>();

export interface ZcodeGoSilentForkArmDelegate {
  /** host → main 的信号通道（由 zcodeAgentService 注入 postMessage 路由）。 */
  notifyArm(params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): void;
  /** 诊断日志（轮换链静默性问题定位：arm/良性拒绝今天完全不可见）。 */
  log?(message: string, meta?: Record<string, unknown>): void;
  /** quiescence 检查（existing-only readSession；由 zcodeAgentService 注入）。 */
  checkQuiescence(params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean>;
}

let delegate: ZcodeGoSilentForkArmDelegate | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;

export function setZcodeGoSilentForkDelegate(d: ZcodeGoSilentForkArmDelegate | null): void {
  delegate = d;
}

/**
 * 帧中继观察者：检测 compaction 成功标记 → armed。
 *
 * 帧结构：分发点传入的是 wire 层候选（complete 帧逻辑载荷在 frame 键内、大帧
 * 为 fragment 分片）——必须经 extractLogicalFramePayload 提取，直接读 wire
 * 顶层 payload 键恒为 undefined（历史教训见 zcodeGoSubagentRecovery 头注）。
 * 逻辑载荷是 UI 行投影而非原始 part：compaction 以 timelineMarker 行出现。
 *
 * 只认 online 增量：initial/recovery 投递会重放历史 compact 标记（快照窗口、
 * 断线恢复），按标记无条件 arm 会在每次订阅建立时触发 fork 风暴；缺省按
 * online 处理（与 zcodeTaskIndexSyncer.deliveryKindOf 同惯例）。
 * running/failed/cancelled/noop 的 compact 不 arm。
 *
 * redirect 已存在时同样 arm（batch 4 轮换）：帧中继把 fork 的下行 topic 回写为
 * 原会话，活跃 fork 自身发生 compaction 也以原会话身份到达这里——静默点后由
 * main 轮换到新 fork。伪帧/重放的空转轮换由 main 的「新边界晚于当前 entry
 * 创建时间」DB 校验拦截，这里不重复设防。
 */
export function observeZcodeGoSilentForkFrame(
  workspace: { workspacePath: string; workspaceIdentity?: string },
  wire: ConversationTopicWireCandidate,
): void {
  // CLI/server 未接线（无 host→main 信号通道）时整个触发链不工作，观测也跳过
  if (!delegate) return;
  const topic = wireFrameTopic(wire);
  if (!topic || !topic.startsWith("conversation/")) return;
  const sessionId = topic.slice("conversation/".length);
  if (!sessionId.startsWith("sess_")) return;
  // 只认 online 增量：initial/recovery 投递会重放历史 compact 标记（快照窗口、
  // 断线恢复），按标记无条件 arm 会在每次订阅建立时触发 fork 风暴。缺省值按
  // online 处理（与 zcodeTaskIndexSyncer.deliveryKindOf 同惯例）。
  const deliveryKind = (wire as { deliveryKind?: unknown }).deliveryKind;
  if (deliveryKind === "initial" || deliveryKind === "recovery") return;

  const logical = extractLogicalFramePayload(wire);
  if (!logical || logical.kind !== "deltas") return;
  let compactSucceeded = false;
  for (const delta of logical.deltas ?? []) {
    const d = delta as {
      op?: unknown;
      row?: { kind?: unknown; marker?: { type?: unknown; status?: unknown } };
    };
    if (d.op !== "row.appended" && d.op !== "row.upserted") continue;
    if (d.row?.kind !== "timelineMarker") continue;
    if (d.row.marker?.type !== "compact") continue;
    if (d.row.marker?.status !== "success") continue;
    compactSucceeded = true;
    break;
  }
  if (!compactSucceeded) return;

  if (!armedSessions.has(sessionId)) {
    armedSessions.set(sessionId, {
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      armedAt: Date.now(),
    });
    delegate.log?.("[zcode-go-silent-fork] compaction 成功标记已 arm（等待静默点）", {
      sessionId,
    });
  }
  // 事件驱动加速：armed 会话有任何后续帧（turn 收尾/part 完成）都尝试一次
  // 近期检查（2s 滞后 + 5s armed debounce + quiescence 复核三重防抖）。
  scheduleEventDrivenCheck();
}

let eventCheckTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleEventDrivenCheck(): void {
  if (eventCheckTimer) return;
  eventCheckTimer = setTimeout(() => {
    eventCheckTimer = null;
    void checkArmedSessionsAndTrigger().catch(() => {});
  }, 2_000);
  eventCheckTimer.unref?.();
}

/**
 * 静默点判定 + 触发。由周期巡检和事件（turn 结束/后台完成）调用。
 * 复合判定：无活跃 turn ∧ 无未决后台请求。debounce 由调用方控制。
 */
export async function checkArmedSessionsAndTrigger(): Promise<void> {
  if (!delegate) return;
  const now = Date.now();
  for (const [sessionId, info] of armedSessions) {
    // debounce：armed 后至少等 5 秒（防 compaction 刚完成时在途收尾）
    if (now - info.armedAt < 5_000) continue;
    // 已通知过的跳过（main 处理或失败后由 map 变化自然去重）
    if (notifiedSessions.has(sessionId)) continue;
    // 先占位再 await：并发调用（事件 + 巡检重叠）不会对同一会话双发
    notifiedSessions.add(sessionId);
    // 轮换时效检查：redirect 已存在时，armed 必须晚于该 entry 的建立（含 2s
    // 容差）——否则是重放/启动期回放的老边界信号，丢弃等真正的下次 compaction。
    const existing = getZcodeGoSessionRedirect(sessionId);
    if (existing && info.armedAt <= existing.createdAt + 2_000) {
      armedSessions.delete(sessionId);
      notifiedSessions.delete(sessionId);
      continue;
    }
    // 静默判定
    let quiet = false;
    try {
      quiet = await delegate.checkQuiescence({
        sessionId,
        workspacePath: info.workspacePath,
        ...(info.workspaceIdentity ? { workspaceIdentity: info.workspaceIdentity } : {}),
      });
    } catch {
      quiet = false;
    }
    if (!quiet) {
      notifiedSessions.delete(sessionId);
      continue;
    }
    // 派发门闩：fork 事务期间短暂 hold 该会话的新发送（send 咽喉点轮询等
    // redirect 表项出现即放行；超时兜底防 main 卡死拖住用户输入）。
    armZcodeGoSilentForkLatch(sessionId);
    delegate.log?.("[zcode-go-silent-fork] 静默点达成，通知 main 执行 fork/轮换", { sessionId });
    delegate.notifyArm({
      sessionId,
      workspacePath: info.workspacePath,
      ...(info.workspaceIdentity ? { workspaceIdentity: info.workspaceIdentity } : {}),
    });
    // 触发后清出 armed + notified（main fork 成功 → map 有条目 → 后续 compaction
    // 重新 arm → 轮换）。notifiedSessions 不清会让首次 fork 后的该会话被
    // has() 去重永久跳过——轮换链从未真正触发（E2E 实测：fork 连续压缩 8 次
    // 零轮换）。并发双发的兜底由 main 事务互斥 + 边界校验承担。
    armedSessions.delete(sessionId);
    notifiedSessions.delete(sessionId);
  }
}

/** 启动/停止周期巡检（30s）。unref：空转巡检绝不拖住进程退出。 */
export function startZcodeGoSilentForkPeriodicCheck(): void {
  if (periodicTimer) return;
  periodicTimer = setInterval(() => {
    void checkArmedSessionsAndTrigger().catch(() => {});
  }, 30_000);
  periodicTimer.unref?.();
}

export function stopZcodeGoSilentForkPeriodicCheck(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 派发门闩：arm → main 完成 fork/轮换 + redirect 写入之间，短暂 hold 该会话的
// 新发送。放行条件（先到先得）：
//   1. redirect 表项的 forkSessionId 相对 arm 时刻发生变化（首 fork：null→S'；
//      轮换：S'→S''——轮换期间旧表项恒存在，必须比对身份而非存在性）；
//   2. 超时（fork 失败 / main 卡死时不拖死用户输入，回落当前端点发送）。
// ---------------------------------------------------------------------------

const FORK_LATCH_TIMEOUT_MS = 5_000;
const FORK_LATCH_POLL_MS = 25;

const forkLatches = new Map<string, { until: number; prevForkId: string | null }>();

export function armZcodeGoSilentForkLatch(sessionId: string, timeoutMs = FORK_LATCH_TIMEOUT_MS): void {
  forkLatches.set(sessionId, {
    until: Date.now() + timeoutMs,
    prevForkId: getZcodeGoSessionRedirect(sessionId)?.forkSessionId ?? null,
  });
}

export function clearZcodeGoSilentForkLatch(sessionId: string): void {
  forkLatches.delete(sessionId);
}

/** 发送咽喉点调用：latch 存在时轮询等待 redirect 指向新 fork 或超时。 */
export async function waitForZcodeGoSilentForkGate(sessionId: string): Promise<void> {
  const latch = forkLatches.get(sessionId);
  if (!latch) return;
  while (Date.now() < latch.until) {
    const currentForkId = getZcodeGoSessionRedirect(sessionId)?.forkSessionId ?? null;
    if (currentForkId !== latch.prevForkId) {
      forkLatches.delete(sessionId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, FORK_LATCH_POLL_MS));
  }
  forkLatches.delete(sessionId);
}

/** 测试重置。 */
export function resetZcodeGoSilentForkForTest(): void {
  armedSessions.clear();
  notifiedSessions.clear();
  forkLatches.clear();
  if (eventCheckTimer) {
    clearTimeout(eventCheckTimer);
    eventCheckTimer = null;
  }
  stopZcodeGoSilentForkPeriodicCheck();
}

/** 测试专用：把 armed 时间回拨，跳过 5s debounce。 */
export function backdateZcodeGoSilentForkArmedAtForTest(sessionId: string, ageMs: number): void {
  const info = armedSessions.get(sessionId);
  if (info) {
    info.armedAt = Date.now() - ageMs;
  }
}
