/**
 * zcode-go OPC 面板挂载点（App.tsx 的唯一门控：import + 一行渲染）。
 * 预热投影缓存并渲染全局公司面板（面板内 CustomEvent 唤起，无 props 通道）。
 */
import { useEffect } from "react";
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

  useEffect(() => {
    if (!workspacePath) return;
    // 预热：面板/驾驶舱打开时 initialize 幂等短路，这里只为提前建好状态变化订阅。
    void initialize(workspacePath, workspaceIdentity ?? undefined).catch(() => {
      /* 初始化失败由面板内错误态呈现 */
    });
  }, [initialize, workspacePath, workspaceIdentity]);

  return <ZcodeGoOpcPanelRoot workspaceIdentity={workspaceIdentity ?? null} />;
}
