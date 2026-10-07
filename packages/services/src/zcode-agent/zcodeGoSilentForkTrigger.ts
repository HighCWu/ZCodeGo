/**
 * zcode-go 静默 fork 第二批：compaction 观测 armed + 静默点门控 + 自动触发。
 *
 * 设计（与用户共同推导定稿）：
 * - compaction part 在帧中继处观测到 → armed[S]（幂等，持续有效）；
 * - 静默点 = 复合判定（无活跃 turn ∧ 无未决后台），事件驱动 + 周期巡检；
 * - 满足即发 host → main ZcodeGoSilentForkArm，main 执行 direct fork + redirect；
 * - 派发门闩（fork 事务期间短暂 hold 新派发）在 main 侧实现（第三批）。
 *
 * 本模块在 host（utility process）运行，通过 observeZcodeGoSilentForkFrame
 * 挂入帧中继；quiescence 用 readSession existing-only（不拉起新 runtime）。
 */
import type { ConversationTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";
import { getZcodeGoSessionRedirect } from "./zcodeGoSessionRedirect.js";

/** armed 会话表：sessionId → { workspacePath, armedAt } */
const armedSessions = new Map<
  string,
  { workspacePath: string; workspaceIdentity?: string; armedAt: number }
>();

/** 已通知 main 的会话（防止重复发消息；main fork 成功/失败后由 map 变化隐式去重） */
const notifiedSessions = new Set<string>();

export interface ZcodeGoSilentForkArmDelegate {
  /** host → main 的信号通道（由 zcodeAgentService 注入 postMessage 路由）。 */
  notifyArm(params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): void;
  /** quiescence 检查（existing-only readSession；由 zcodeAgentService 注入）。 */
  checkQuiescence(params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean>;
}

let delegate: ZcodeGoSilentForkArmDelegate | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;

export function setZcodeGoSilentForkDelegate(d: ZcodeGoSilentForkArmDelegate): void {
  delegate = d;
}

/**
 * 帧中继观察者：检测 compaction part → armed。
 * 判据与 zcodeGoDirectFork / CLI isActiveCompactionBoundaryPart 同源：
 * type=compaction 且带 compactBoundary（或无 timelineStatus）。
 *
 * redirect 已存在时同样 arm（batch 4 轮换）：帧中继把 fork 的下行 topic 回写为
 * 原会话，活跃 fork 自身发生 compaction 也以原会话身份到达这里——静默点后由
 * main 轮换到新 fork。伪帧/重放的空转轮换由 main 的「新边界晚于当前 entry
 * 创建时间」DB 校验拦截，这里不重复设防。
 */
export function observeZcodeGoSilentForkFrame(
  workspace: { workspacePath: string; workspaceIdentity?: string },
  frame: ConversationTopicWireCandidate,
): void {
  if (typeof frame.topic !== "string" || !frame.topic.startsWith("conversation/")) return;
  const sessionId = frame.topic.slice("conversation/".length);
  if (!sessionId.startsWith("sess_")) return;

  // 帧的 payload 里是否有 compaction part？
  // wire candidate 的 payload 可能是 JSON 字符串或已解析对象
  const raw = typeof frame.payload === "string" ? frame.payload : JSON.stringify(frame.payload ?? "");
  if (!raw.includes('"type":"compaction"')) return;
  if (!raw.includes("compactBoundary") && raw.includes('"timelineStatus"')) return;

  // 确认是活跃压缩边界（不是 timeline 展示用的 compaction）
  if (raw.includes('"timelineStatus"') && !raw.includes("compactBoundary")) return;

  if (!armedSessions.has(sessionId)) {
    armedSessions.set(sessionId, {
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      armedAt: Date.now(),
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
    delegate.notifyArm({
      sessionId,
      workspacePath: info.workspacePath,
      ...(info.workspaceIdentity ? { workspaceIdentity: info.workspaceIdentity } : {}),
    });
    // 触发后清出 armed（main fork 成功 → map 有条目 → 后续 compaction 重新 arm）
    armedSessions.delete(sessionId);
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
