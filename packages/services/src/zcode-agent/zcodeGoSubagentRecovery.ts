/**
 * zcode-go 并发子智能体断连自动恢复（goal-keeper 标准版附属，桌面服务层实现）。
 *
 * 症状（实测）：一次派发 N 个并发后台子智能体时，共享的协议通道一旦断开，
 * N 个子智能体同一秒全部失败（"ZCode Protocol client connection closed"），
 * 主模型收到全部失败结果后结束整轮——工作未完成即自动结束，且无重试。
 *
 * 机制：低频尾随官方 CLI 日志（~/.zcode/cli/log/zcode-<date>.jsonl，与人工
 * 诊断同源），检出「subagent.background.failed 且错误为连接关闭类」的失败；
 * 失败静置 30 秒（等抖动窗口过去、通道重连稳定）后，向父会话发送一条续派
 * 提示（官方 session/send）——父模型带着原任务描述重新派发子智能体。
 * 非连接类失败（用户取消等）不触发；每会话每小时最多续派 2 次防风暴。
 *
 * 配置：~/.zcode-go/config.json
 *   { "subagentRecovery": { "enabled": true, "maxPerHour": 2 } }
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".zcode", "cli", "log");
const SCAN_INTERVAL_MS = 5_000;
/** 失败静置窗口：最后一次失败 30 秒后仍成立才恢复（等抖动与重连稳定）。 */
const QUIET_WINDOW_MS = 30_000;
const FAILURE_EVENT = '"event":"subagent.background.failed"';
const CONNECTION_ERROR = /connection closed|client is disposed|ECONNRESET|ECONNREFUSED|EPIPE|network failed/i;

export interface ZcodeGoSubagentRecoveryLogger {
  info(traceId: string | undefined, message: string, extra?: unknown): void;
  warn(traceId: string | undefined, message: string, extra?: unknown): void;
  debug(traceId: string | undefined, message: string, extra?: unknown): void;
}

export interface ZcodeGoSubagentRecoveryAgent {
  sendPrompt(params: {
    sessionId: string;
    content: string;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<unknown>;
}

interface GoalKeepAliveConfig {
  enabled: boolean;
  maxPerHour: number;
}

interface Incident {
  count: number;
  firstAt: number;
  lastAt: number;
  workspacePath?: string;
}

let agent: ZcodeGoSubagentRecoveryAgent | null = null;
let logger: ZcodeGoSubagentRecoveryLogger | null = null;
let disposed = false;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let logOffset: Record<string, number> = {};
/** sessionId → 未恢复的断连失败聚合。 */
const incidents = new Map<string, Incident>();
/** sessionId → 本小时已发送的续派次数。 */
const nudgesBySession = new Map<string, number[]>();
/** sessionId → 已知 workspacePath（从日志行机会性学习）。 */
const workspaceBySession = new Map<string, string>();

function readConfig(): GoalKeepAliveConfig {
  const defaults: GoalKeepAliveConfig = { enabled: true, maxPerHour: 2 };
  try {
    const path = join(STATE_DIR_CONFIG(), "config.json");
    if (!existsSync(path)) return defaults;
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      subagentRecovery?: { enabled?: boolean; maxPerHour?: number };
    };
    return {
      enabled: raw.subagentRecovery?.enabled !== false,
      maxPerHour: Math.max(1, Math.min(6, raw.subagentRecovery?.maxPerHour ?? defaults.maxPerHour)),
    };
  } catch {
    return defaults;
  }
}

function STATE_DIR_CONFIG(): string {
  return join(homedir(), ".zcode-go");
}

function logDateStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function logFilePath(): string {
  return join(LOG_DIR, `zcode-${logDateStamp()}.jsonl`);
}

function extractString(line: string, key: string): string | undefined {
  const m = line.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{0,300})"`));
  return m?.[1];
}

function scanOnce(): void {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  const path = logFilePath();
  let stat: { size: number };
  try {
    stat = statSync(path);
  } catch {
    logOffset = {}; // 日志轮转
    return;
  }
  const key = logDateStamp();
  let start = logOffset[key] ?? 0;
  if (stat.size < start) start = 0; // 截断/轮转
  if (stat.size <= start) return;

  // 增量 tail 读取（单次上限 1MB；只推进到最后一个完整换行，半行留给下轮）
  const fd = openSync(path, "r");
  let text: string;
  try {
    const len = Math.min(stat.size - start, 1 << 20);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return;
    logOffset[key] = start + Buffer.byteLength(text.slice(0, lastNl + 1));
    text = text.slice(0, lastNl + 1);
  } finally {
    closeSync(fd);
  }

  for (const line of text.split("\n")) {
    if (!line.includes("sess_")) continue;
    // 机会性学习 sessionId → workspacePath
    const ws = extractString(line, "workspacePath");
    if (ws && sidAny?.startsWith("sess_")) workspaceBySession.set(sidAny, ws);
    if (!line.includes(FAILURE_EVENT)) continue;
    const errorMessage = extractString(line, "errorMessage") ?? "";
    if (!CONNECTION_ERROR.test(errorMessage)) continue; // 用户取消等非连接类失败不触发
    const sessionId = line.match(/sess_[0-9a-f-]{16,}/)?.[0];
    if (!sessionId) continue;
    const now = Date.now();
    const incident = incidents.get(sessionId);
    if (incident) {
      incident.count += 1;
      incident.lastAt = now;
      if (ws) incident.workspacePath = ws;
    } else {
      incidents.set(sessionId, { count: 1, firstAt: now, lastAt: now, workspacePath: ws });
    }
  }
}

function openSyncRead(path: string, offset: number): string {
  // 零依赖增量读取：readFileSync 后切片（日志文件当天可达数 MB，一次读入可接受；
  // 只读 offset 之后的尾部需 fd 读取，这里为稳妥取整段再切）
  const buf = readFileSync(path);
  const size = buf.length;
  const start = Math.min(offset, size);
  return buf.subarray(start, size).toString("utf8");
}

async function recoverPending(): Promise<void> {
  if (!agent || disposed) return;
  const config = readConfig();
  if (!config.enabled) return;
  const now = Date.now();
  for (const [sessionId, incident] of [...incidents.entries()]) {
    if (now - incident.lastAt < QUIET_WINDOW_MS) continue;
    // 静置期结束：若期间无新失败（lastAt 未变）→ 判定通道已稳定，发送续派
    const list = (nudgesBySession.get(sessionId) ?? []).filter((t) => now - t <= 3_600_000);
    if (list.length >= config.maxPerHour) {
      incidents.delete(sessionId);
      logger?.warn(undefined, "[zcode-go 子任务恢复] 续派次数达每小时上限，放行", {
        sessionId,
        failed: incident.count,
      });
      continue;
    }
    list.push(now);
    nudgesBySession.set(sessionId, list);
    incidents.delete(sessionId);
    const content =
      `检测到刚才并发派发的 ${incident.count} 个子任务因协议连接中断而失败，通道现已恢复。\n` +
      "请重新派发这些子任务（保持相同的任务描述与并发度；已完成的部分不要重复做），全部完成后按原计划汇总结果。";
    logger?.info(undefined, "[zcode-go 子任务恢复] 向父会话发送续派提示", {
      sessionId,
      failed: incident.count,
    });
    try {
      await agent.sendPrompt({
        sessionId,
        content,
        ...(incident.workspacePath ? { workspacePath: incident.workspacePath } : {}),
      });
    } catch (error) {
      logger?.warn(undefined, "[zcode-go 子任务恢复] 续派提示发送失败", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 桌面服务装配时调用（node.ts 容器）。 */
export function initZCodeGoSubagentRecovery(
  agentService: ZcodeGoSubagentRecoveryAgent,
  options?: { logger?: ZcodeGoSubagentRecoveryLogger },
): void {
  agent = agentService;
  logger = options?.logger ?? null;
  disposed = false;
  if (!scanTimer) {
    scanTimer = setInterval(() => {
      try {
        scanOnce();
      } catch {
        /* 单轮扫描异常不影响下一轮 */
      }
      void recoverPending();
    }, SCAN_INTERVAL_MS);
    scanTimer.unref?.();
  }
}

export function disposeZCodeGoSubagentRecovery(): void {
  disposed = true;
  agent = null;
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  logOffset = {};
  incidents.clear();
  nudgesBySession.clear();
  workspaceBySession.clear();
}
