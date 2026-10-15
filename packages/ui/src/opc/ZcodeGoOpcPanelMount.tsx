/**
 * zcode-go OPC 面板挂载点（App.tsx 的唯一门控：import + 一行渲染）。
 * 预热投影缓存并渲染全局公司面板（面板内 CustomEvent 唤起，无 props 通道）。
 */
import { useEffect } from "react";
import { useIsOpcMode } from "@/hooks/useInterfaceMode.js";
import { ZcodeGoOpcPanelRoot } from "@/opc/ZcodeGoOpcPanelRoot.js";
import { useOpcStore } from "@/store/opcStore.js";

export function ZcodeGoOpcPanelMount({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string | null;
  workspaceIdentity?: string | null;
}) {
  const initialize = useOpcStore((s) => s.initialize);
  // 预热门控到 OPC 模式：非 OPC 用户（含全部既有 E2E）启动期零 OPC 开销
  // （main 侧 initialize 会写 company.json + 24 技能文件 + packs 扫描，慢盘
  // 环境与既有 E2E 的渲染窗口竞争）；面板打开时 initialize 幂等短路兜底。
  const isOpcMode = useIsOpcMode();

  useEffect(() => {
    if (!workspacePath || !isOpcMode) return;
    // 预热：提前建好状态变化订阅。
    void initialize(workspacePath, workspaceIdentity ?? undefined).catch(() => {
      /* 初始化失败由面板内错误态呈现 */
    });
  }, [initialize, workspacePath, workspaceIdentity, isOpcMode]);

  return <ZcodeGoOpcPanelRoot workspaceIdentity={workspaceIdentity ?? null} />;
}
