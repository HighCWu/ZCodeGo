/**
 * zcode-go 试验执行桥（renderer 侧）：接收 main 转发的试验 prompt 请求，
 * 用 IZCodeTaskService 创建临时会话执行（编排器同款执行器，真实模型链路）。
 * 回复按 prompt 契约写入 .opc/exp/<fileTag>.json（由试验调用方轮询读取）——
 * 本桥只负责「执行」，不等待完成（headless 会话行无轻量读取面）。
 */
import { useEffect } from "react";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";

const EXEC_DENYLIST = [
  "Bash",
  "js",
  "js_reset",
  "js_add_node_module_dir",
  "mcp__node_repl__js",
  "mcp__node_repl__js_reset",
  "mcp__node_repl__js_add_node_module_dir",
];

export function useZCodeGoExpBridge(workspacePath: string | null): void {
  useEffect(() => {
    if (!workspacePath) return;
    const bridge = (
      window as unknown as {
        zcode?: {
          onZcodeGoExpRunPrompt?: (
            handler: (payload: {
              requestId: string;
              workspacePath: string;
              content: string;
              fileTag: string;
              model?: string;
            }) => void,
          ) => () => void;
          takeZcodeGoExpPending?: (payload: {
            workspacePath: string;
          }) => Promise<{
            request: {
              requestId: string;
              workspacePath: string;
              content: string;
              fileTag: string;
              model?: string;
            } | null;
          }>;
        };
      }
    ).zcode;
    const subscribe = bridge?.onZcodeGoExpRunPrompt;
    // 执行函数：推式/拉式两条路径共用
    const execute = (payload: {
      requestId: string;
      workspacePath: string;
      content: string;
      fileTag: string;
      model?: string;
    }) => {
      const taskService = useZCodeTaskService(
        payload.workspacePath,
        undefined,
        undefined,
      );
      void (async () => {
        try {
          const created = await taskService.createTask({
            workspacePath: payload.workspacePath,
            v4Create: true,
            deferPersistenceUntilFirstPrompt: true,
            permissionScope: "session",
            // 试验会话显式绑定模型：不继承桌面当前选择（可能被切到其他供应商模型，
            // 历史 v5 试验曾静默落到 openai/gpt-6-astra）。默认 GLM-5.3-Flash。
            modelSelection: {
              providerId: "account:bigmodel-individual-coding-plan",
              modelId: payload.model ?? "GLM-5.3-Flash",
              options: { reasoningLevel: "high" },
            },
          });
          // 回复走文件中转契约：prompt 尾部追加写文件指令（.opc/exp/）
          const prompt = [
            payload.content,
            "",
            '完成后用 Write 工具把你的最终回答以 JSON {"text": "<回答>"} 写入这个文件（这是你唯一允许写的文件）：',
            `.opc/exp/${payload.fileTag}.json`,
            "写完后回复 done。",
          ].join("\n");
          await taskService.sendPrompt({
            taskId: created.taskId,
            traceId: `exp:${payload.requestId}`,
            content: prompt,
            toolDenylist: EXEC_DENYLIST,
          });
          logger.debug("[zcode-go][opc] 试验 prompt 已派发", {
            requestId: payload.requestId,
            taskId: created.taskId,
          });
        } catch (error) {
          logger.warn("[zcode-go][opc] 试验执行失败", error);
        }
      })();
    };
    if (!subscribe) {
      // 无推式 API 时仅拉模式亦可工作
      return;
    }
    const unsubscribe = subscribe(execute);
    // 拉模式轮询（主路径）：推式 webContents.send 在 Electron 41 实测不达，
    // invoke 方向（桌面全部功能同款）可靠——renderer 每 1.5s 取一次待执行请求。
    const poll = window.setInterval(() => {
      void (async () => {
        try {
          const taken = await bridge.takeZcodeGoExpPending?.({
            workspacePath: workspacePath ?? "",
          });
          if (taken?.request) execute(taken.request);
        } catch {
          /* 轮询失败静默重试 */
        }
      })();
    }, 1500);
    return () => {
      unsubscribe();
      window.clearInterval(poll);
    };
  }, [workspacePath]);
}
