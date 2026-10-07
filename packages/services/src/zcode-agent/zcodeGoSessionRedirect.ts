/**
 * zcode-go 静默 fork 的会话重定向表（redirect map）。
 *
 * 设计定稿（会话推导）：
 * - 原会话 S 是稳定键：任务行、定时任务/goal/看门狗注册、分享、搜索、UI 全部
 *   永远指向 S；重定向表是唯一翻译层——轮换（S'→S''）只更新表，不改任何注册。
 * - 服务层 choke points（subscribeConversationV4 / sendConversationCommandV4 /
 *   resync / unsubscribe / readSession）入参过 resolveZcodeGoSessionId；
 *   下行帧在中继处把 conversation/<fork> 回写为 conversation/<原会话>，
 *   renderer 与所有观察者（goal-keeper 等）全程无感。
 * - 状态文件 ~/.zcode-go/session-redirect.json；mtime 缓存（热路径毫秒级）。
 * - 仅在 host/主进程使用（node:fs）——renderer 不得直接 import。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 测试可用 ZCODE_GO_STATE_DIR_OVERRIDE 隔离状态目录（生产恒为 ~/.zcode-go）。
// 惰性求值：模块加载时机早于测试设置 env，加载期捕获会让隔离失效写入真实文件。
function stateDir(): string {
  return process.env.ZCODE_GO_STATE_DIR_OVERRIDE || join(homedir(), ".zcode-go");
}
function redirectFile(): string {
  return join(stateDir(), "session-redirect.json");
}

export interface ZcodeGoSessionRedirectEntry {
  /** 活跃隐形子会话（silent fork）。 */
  forkSessionId: string;
  createdAt: number;
  createdBy: "manual" | "auto-compaction";
}

interface RedirectFile {
  version: 1;
  redirects: Record<string, ZcodeGoSessionRedirectEntry>;
}

let cachedFile: RedirectFile | null = null;
let cachedMtimeMs = -1;

function readRedirectFile(): RedirectFile {
  try {
    const stats = statSync(redirectFile());
    if (cachedFile && stats.mtimeMs === cachedMtimeMs) return cachedFile;
    const raw = existsSync(redirectFile()) ? readFileSync(redirectFile(), "utf8") : "";
    const parsed = raw
      ? (JSON.parse(raw) as Partial<RedirectFile>)
      : null;
    const file: RedirectFile = {
      version: 1,
      redirects:
        parsed && typeof parsed.redirects === "object" && parsed.redirects !== null
          ? parsed.redirects
          : {},
    };
    cachedFile = file;
    cachedMtimeMs = stats.mtimeMs;
    return file;
  } catch {
    // 文件缺失/损坏：无重定向（首次运行/手动清理），不阻塞任何调用方。
    return { version: 1, redirects: {} };
  }
}

function writeRedirectFile(file: RedirectFile): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(redirectFile(), JSON.stringify(file, null, 2), "utf8");
  cachedFile = file;
  try {
    cachedMtimeMs = statSync(redirectFile()).mtimeMs;
  } catch {
    cachedMtimeMs = -1;
  }
}

/**
 * 会话域操作统一寻址：命中重定向则返回活跃隐形子会话，否则原样返回。
 * 链长恒为 1（轮换原地更新表项），无需递归。
 */
export function resolveZcodeGoSessionId(sessionId: string): string {
  if (!sessionId.startsWith("sess_")) return sessionId;
  return readRedirectFile().redirects[sessionId]?.forkSessionId ?? sessionId;
}

/** 反查：给定会话是否是某个原会话的活跃隐形 fork；是则返回原会话 id。 */
export function lookupZcodeGoOriginalSession(forkSessionId: string): string | null {
  const file = readRedirectFile();
  for (const [original, entry] of Object.entries(file.redirects)) {
    if (entry.forkSessionId === forkSessionId) return original;
  }
  return null;
}

/** 读取当前生效的重定向（无则 null）。 */
export function getZcodeGoSessionRedirect(originalSessionId: string): ZcodeGoSessionRedirectEntry | null {
  return readRedirectFile().redirects[originalSessionId] ?? null;
}

/** 建立/更新重定向（轮换 = 对同一原会话再次 set）。 */
export function setZcodeGoSessionRedirect(
  originalSessionId: string,
  entry: ZcodeGoSessionRedirectEntry,
): void {
  const file = readRedirectFile();
  file.redirects[originalSessionId] = entry;
  writeRedirectFile(file);
}

/** 清除重定向（回退直连原会话 / 轮换收尾）。 */
export function clearZcodeGoSessionRedirect(originalSessionId: string): void {
  const file = readRedirectFile();
  if (!(originalSessionId in file.redirects)) return;
  delete file.redirects[originalSessionId];
  writeRedirectFile(file);
}

/** 全量列表（轮换巡检/崩溃恢复用）。 */
export function listZcodeGoSessionRedirects(): Array<{
  originalSessionId: string;
  entry: ZcodeGoSessionRedirectEntry;
}> {
  return Object.entries(readRedirectFile().redirects).map(([originalSessionId, entry]) => ({
    originalSessionId,
    entry,
  }));
}

/** 测试专用：清空进程内缓存（测试改写文件后强制重读）。 */
export function resetZcodeGoSessionRedirectCacheForTest(): void {
  cachedFile = null;
  cachedMtimeMs = -1;
}
