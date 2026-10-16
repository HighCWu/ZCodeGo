/**
 * zcode-go OPC 渠道桥（Telegram 长轮询 → 入站队列）。
 *
 * 渠道 worker 的第一实现（spec「入站队列」节）：把 Telegram 文本消息投递为
 * `<workspace>/.opc/inbox/*.json`，走既有审批流转工作项。
 *
 * 门控与边界（零配置 = 零足迹）：
 * - 仅当 ~/.zcode-go/config.json 配置了 channels.telegram.botToken 才启动轮询；
 * - deny-by-default：channels.telegram.allowFrom（chat id 数组）为空时丢弃一切
 *   入站消息（对齐 OpenOPC channels 的 allow_from 语义）；
 * - 投递目标 channels.telegram.workspacePath 必须显式配置（inbox 是按工作区的）；
 * - 轮询 offset 持久化于 ~/.zcode-go/channels-telegram-state.json（重启不重放）。
 * 官方 zcode 的 bots 基建（services/bots）路由的是 bot 会话；本桥只喂 OPC 入站，
 * 两者独立。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseOpcInboxFile } from "@zcode/shared";
import type { OpcInboxItem } from "@zcode/shared";

const ZCODE_GO_DIR = join(homedir(), ".zcode-go");

const CHANNELS_STATE_FILE = join(ZCODE_GO_DIR, "channels-telegram-state.json");
const DEFAULT_API_BASE = "https://api.telegram.org";

export interface TelegramChannelConfig {
  botToken: string;
  workspacePath: string;
  allowFrom: Array<number | string>;
  apiBase?: string;
}
const POLL_INTERVAL_MS = 10_000;

export function readTelegramChannelConfig(): TelegramChannelConfig | null {
  try {
    const configPath = join(homedir(), ".zcode-go", "config.json");
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      channels?: { telegram?: Partial<TelegramChannelConfig> };
    };
    const telegram = parsed.channels?.telegram;
    if (
      !telegram ||
      typeof telegram.botToken !== "string" ||
      telegram.botToken.length === 0 ||
      typeof telegram.workspacePath !== "string" ||
      telegram.workspacePath.length === 0
    ) {
      return null;
    }
    return {
      botToken: telegram.botToken,
      workspacePath: telegram.workspacePath,
      allowFrom: Array.isArray(telegram.allowFrom)
        ? (telegram.allowFrom as Array<number | string>)
        : [],
      apiBase:
        typeof telegram.apiBase === "string"
          ? telegram.apiBase
          : DEFAULT_API_BASE,
    };
  } catch {
    return null;
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id?: number | string }; date?: number };
  edited_message?: { text?: string; chat?: { id?: number | string } };
}

/** 解析 getUpdates 响应（宽松：非 200/坏 JSON 返回 null 由调用方保 offset）。 */
export function parseTelegramUpdatesBody(
  body: string,
): TelegramUpdate[] | null {
  try {
    const parsed = JSON.parse(body) as { ok?: unknown; result?: unknown };
    if (parsed.ok !== true || !Array.isArray(parsed.result)) return null;
    return parsed.result as TelegramUpdate[];
  } catch {
    return null;
  }
}

/** chat id 白名单过滤（deny-by-default）+ 文本消息提取。 */
export function selectAllowedTexts(
  updates: TelegramUpdate[],
  allowFrom: Array<number | string>,
): Array<{ chatId: string; text: string }> {
  const allowed = new Set(allowFrom.map((id) => String(id)));
  const results: Array<{ chatId: string; text: string }> = [];
  for (const update of updates) {
    const chatId = update.message?.chat?.id ?? update.edited_message?.chat?.id;
    const text = update.message?.text ?? update.edited_message?.text;
    if (chatId === undefined || !text) continue;
    // deny-by-default：allowFrom 空数组 = 拒绝一切入站
    if (!allowed.has(String(chatId))) continue;
    results.push({ chatId: String(chatId), text, updateId: update.update_id });
  }
  return results;
}

export function readTelegramOffset(): number {
  try {
    const parsed = JSON.parse(readFileSync(CHANNELS_STATE_FILE, "utf8")) as {
      offset?: unknown;
    };
    return typeof parsed.offset === "number" ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export function writeTelegramOffset(offset: number): void {
  try {
    mkdirSync(CHANNELS_STATE_FILE.replace(/[/\\][^/\\]+$/, ""), {
      recursive: true,
    });
    // tmp + rename：直写在崩溃时可能留半文件，下次启动解析失败归 0 → 全量重放
    const tmp = `${CHANNELS_STATE_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ offset }, null, 1), "utf8");
    renameSync(tmp, CHANNELS_STATE_FILE);
  } catch {
    /* 尽力而为 */
  }
}

export interface TelegramPollDeps {
  config: TelegramChannelConfig;
  fetchImpl?: typeof fetch;
  /** 投递回调（写 inbox 文件 + 可选广播由调用方接）。 */
  onInbound: (item: OpcInboxItem) => void;
  onError?: (message: string) => void;
}

/** 单次长轮询：拉取 → 白名单过滤 → 投递 inbox → 推进 offset。 */
export async function pollTelegramOnce(
  deps: TelegramPollDeps,
): Promise<number | null> {
  const { config, fetchImpl = fetch, onInbound, onError } = deps;
  const offset = readTelegramOffset();
  let response: Response;
  try {
    response = await fetchImpl(
      `${config.apiBase ?? DEFAULT_API_BASE}/bot${config.botToken}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "edited_message"]))}`,
    );
  } catch (error) {
    onError?.(
      `Telegram getUpdates 失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (!response.ok) {
    onError?.(`Telegram getUpdates HTTP ${response.status}`);
    return null;
  }
  const updates = parseTelegramUpdatesBody(await response.text());
  if (updates === null) {
    onError?.("Telegram getUpdates 响应格式无效");
    return null;
  }
  const messages = selectAllowedTexts(updates, config.allowFrom);
  const inboxDir = join(config.workspacePath, ".opc", "inbox");
  if (messages.length > 0) {
    mkdirSync(inboxDir, { recursive: true });
  }
  let maxUpdateId = offset;
  let delivered = 0;
  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id + 1);
  }
  for (const message of messages) {
    // update_id 唯一化文件名：时间戳 + 内容哈希在同毫秒同文本时互相覆盖丢消息
    const fileName = `${Date.now()}-telegram-u${message.updateId}-${Math.abs(hashString(message.text + message.chatId))}.json`;
    const item = parseOpcInboxFile(
      fileName,
      JSON.stringify({
        title: message.text.split("\n")[0]?.slice(0, 80) || "Telegram 消息",
        detail: message.text,
        source: "telegram",
        receivedAt: new Date().toISOString(),
      }),
    );
    if (!item) continue;
    writeFileSync(
      join(inboxDir, fileName),
      JSON.stringify(item, null, 1),
      "utf8",
    );
    onInbound(item);
    delivered += 1;
  }
  if (maxUpdateId !== offset) {
    writeTelegramOffset(maxUpdateId);
  }
  return delivered;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

export function startTelegramChannelPolling(
  deps: Omit<TelegramPollDeps, "config"> & { onStarted?: () => void },
): (() => void) | null {
  const config = readTelegramChannelConfig();
  if (!config) return null; // 零配置零足迹
  // 防重入：上轮 fetch 挂起超过轮询间隔时，并发轮询拿同一 offset 会重复投递
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void pollTelegramOnce({ ...deps, config })
      .catch(() => {
        /* 轮询失败静默（下轮重试） */
      })
      .finally(() => {
        polling = false;
      });
  }, POLL_INTERVAL_MS);
  deps.onStarted?.();
  return () => clearInterval(timer);
}

/**
 * index.ts 的启动门控入口（零配置 = 立即返回，零足迹）。
 * 返回的停止函数当前无人消费：app 进程退出时定时器随之消亡；
 * 若未来需要运行中停用，把返回值接进设置开关即可。
 */
export function initZcodeGoOpcChannels(logger: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}): void {
  const stop = startTelegramChannelPolling({
    onInbound: () => {
      /* 入站文件落盘即可：面板下次 GetState 扫描时可见（无面板打开时零打扰） */
    },
    onError: (message) => logger.warn(`[zcode-go] OPC 渠道桥: ${message}`),
    onStarted: () =>
      logger.info("[zcode-go] OPC Telegram 渠道桥已启动（长轮询 → 入站队列）"),
  });
  if (stop) {
    logger.info("[zcode-go] OPC 渠道桥配置生效（bot token 已配置）");
  }
}
