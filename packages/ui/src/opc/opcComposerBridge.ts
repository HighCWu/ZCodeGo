/**
 * zcode-go OPC → composer 桥：把委派/复盘/升级 prompt 注入既有输入框。
 * 走上游 requestComposerTextInsert（与推荐提示同一条链路），由用户确认发送——
 * OPC 不创建也不改写会话命令，完全复用既有 createSession 链路。
 */
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";

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
