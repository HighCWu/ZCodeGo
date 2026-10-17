/**
 * zcode-go 试验执行桥（renderer 侧）：接收 main 的试验 prompt 请求，
 * 用 IZCodeTaskService 创建临时会话执行（编排器同款执行器，真实模型链路）。
 * 回复按 prompt 契约写入 .opc/exp/<fileTag>.json（由试验调用方轮询读取）——
 * 本桥只负责「执行」，不等待完成（headless 会话行无轻量读取面）。
 *
 * 取请求走拉模式（renderer 每 1.5s invoke 轮询）：推式 webContents.send 在
 * Electron 41 实测不达（通道值一致、executeJavaScript 可达、on 不触发），
 * invoke 方向为桌面全部功能的既有通路，可靠性已验证。
 */
import { useEffect, useRef } from "react";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
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

interface ExpRequest {
  requestId: string;
  workspacePath: string;
  content: string;
  fileTag: string;
  model?: string;
}

export function useZCodeGoExpBridge(workspacePath: string | null): void {
  // service 在组件 render 层解析（hook 规则）；非 render 的轮询/订阅回调只用引用。
  // 试验请求的 workspacePath 必须与本组件 workspace 一致才执行（service 按
  // workspace 身份解析到对应 host，跨 workspace 复用会话会落错 host）。
  const taskService = useZCodeTaskService(
    workspacePath ?? undefined,
    undefined,
    undefined,
  );
  const serviceRef = useRef(taskService);
  serviceRef.current = taskService;
  const workspaceRef = useRef(workspacePath);
  workspaceRef.current = workspacePath;

  useEffect(() => {
    if (!workspacePath) return;
    const bridge = (
      window as unknown as {
        zcode?: {
          takeZcodeGoExpPending?: (payload: {
            workspacePath: string;
          }) => Promise<{ request: ExpRequest | null }>;
        };
      }
    ).zcode;
    const take = bridge?.takeZcodeGoExpPending;
    if (!take) {
      logger.warn("[zcode-go][opc] 试验桥缺失 takeZcodeGoExpPending（preload 过旧）");
      return;
    }
    const execute = (payload: ExpRequest) => {
      if (payload.workspacePath !== workspacePath) {
        logger.warn("[zcode-go][opc] 丢弃 workspace 不匹配的试验请求", {
          request: payload.workspacePath,
          bridge: workspacePath,
        });
        return;
      }
      const service = serviceRef.current;
      if (!service) {
        logger.warn("[zcode-go][opc] 试验桥 service 未就绪");
        return;
      }
      void (async () => {
        try {
          const created = await service.createTask({
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
          await service.sendPrompt({
            taskId: created.taskId,
            traceId: `exp:${payload.requestId}`,
            content: prompt,
            toolDenylist: EXEC_DENYLIST,
            // 执行轮显式模型：v4 admission 把 sendPrompt 的 modelSelection 固定进
            // canonical intent——这是不被桌面当前选择劫持的最强保证点。
            modelSelection: {
              providerId: "account:bigmodel-individual-coding-plan",
              modelId: payload.model ?? "GLM-5.3-Flash",
              options: { reasoningLevel: "high" },
            },
          });
          console.error("[exp-debug] 已派发", created.taskId, JSON.stringify(created).slice(0, 120));
          logger.debug("[zcode-go][opc] 试验 prompt 已派发", {
            requestId: payload.requestId,
            taskId: created.taskId,
          });
        } catch (error) {
          // 试验调试：生产 logger 为 no-op，用原生 console 透出（CDP 可抓）
          console.error("[exp-debug] 执行失败", error);
          logger.warn("[zcode-go][opc] 试验执行失败", error);
        }
      })();
    };
    // 拉模式轮询（主路径）
    const poll = window.setInterval(() => {
      void (async () => {
        try {
          const taken = await take({ workspacePath });
          if (taken?.request) execute(taken.request);
        } catch (error) {
          logger.warn("[zcode-go][opc] 试验轮询失败", error);
        }
      })();
    }, 1500);
    return () => {
      window.clearInterval(poll);
    };
  }, [workspacePath]);
}
