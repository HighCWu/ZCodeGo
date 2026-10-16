/**
 * zcode-go OPC → composer 桥：把委派/复盘/升级 prompt 注入既有输入框。
 * 走上游 requestComposerTextInsert（与推荐提示同一条链路），由用户确认发送——
 * OPC 不创建也不改写会话命令，完全复用既有 createSession 链路。
 *
 * 回执语义（根治「静默丢稿」）：requestComposerTextInsert 只入队即返回，
 * 真正的应用发生在草稿态 Composer（clearComposerTextInsertRequest 被调用
 * = 应用成功）。本桥在入队后轮询 workspace 的插入请求状态：被清空 =
 * 已注入；超时（活跃会话/非草稿态）= 未注入，调用方据此提示用户。
 */
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";

const APPLIED_POLL_INTERVAL_MS = 100;
const APPLIED_TIMEOUT_MS = 3000;

export function insertOpcPrompt(input: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  text: string;
}): boolean {
  try {
    const store = useZCodeSessionStore.getState();
    const result = store.requestComposerTextInsert(
      input.workspacePath,
      input.text,
      input.workspaceIdentity ?? undefined,
    );
    // requestComposerTextInsert 返回 requestId（数字）；0/undefined 视为未受理。
    const accepted =
      typeof result === "number" ? Number.isFinite(result) : Boolean(result);
    if (!accepted) {
      logger.warn(
        "[zcode-go][opc] composer 插入请求未被受理（当前非草稿态？）",
      );
    }
    return accepted;
  } catch (error) {
    logger.warn(
      `[zcode-go][opc] composer 插入异常: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * 带回执的注入：入队成功后等待草稿 Composer 真正应用（请求被清空）。
 * 返回 false = 超时未应用（活跃会话中 prompt 不会出现）——调用方应提示
 * 用户切换到草稿会话重试，而不是假装注入成功。
 */
export async function insertOpcPromptWithReceipt(input: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  text: string;
}): Promise<boolean> {
  const accepted = insertOpcPrompt(input);
  if (!accepted) return false;
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const readRequest = (): unknown => {
    const store = useZCodeSessionStore.getState();
    const snapshot = store.getWorkspaceState(
      input.workspacePath,
      input.workspaceIdentity ?? undefined,
    );
    return snapshot?.composerTextInsertRequest;
  };
  for (
    let attempt = 0;
    attempt * APPLIED_POLL_INTERVAL_MS < APPLIED_TIMEOUT_MS;
    attempt += 1
  ) {
    await sleep(APPLIED_POLL_INTERVAL_MS);
    // 请求被清空 = Composer 已应用（SessionPane applied 回调 → clear）
    if (readRequest() === null) return true;
  }
  logger.warn(
    "[zcode-go][opc] composer 插入超时未应用（活跃会话或非草稿态）——prompt 未注入",
  );
  return false;
}
