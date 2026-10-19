/**
 * zcode-go preload 暴露面（从 preload/index.ts 拆出——上游合并门控点 =
 * import + 对象内一行 spread）。全部经 ipcRenderer.invoke/on 与 main 通讯。
 */
import type { Electron } from "electron";
// 子路径直取纯常量文件：shared barrel 会被打满 node 依赖，sandbox preload
// 禁用全部 node 内置模块（node:path/crypto 均实测崩 preload → window.zcode 全灭）。
import { PlatformChannels } from "@zcode/shared/channels";

export function installZcodeGoPreloadEntries({
  ipcRenderer,
}: {
  ipcRenderer: Electron.IpcRenderer;
}) {
  return {
    /** zcode-go：分叉 ack 后裁剪子会话存储（剔除最后压缩边界前的惰性历史）。 */
    zcodeGoTrimForkedSessionHistory: (payload: {
      childSessionId: string;
      parentSessionId: string;
    }): Promise<{
      ok: boolean;
      childSessionId: string;
      removedMessages: number;
      keptMessages: number;
      error?: string;
    }> =>
      ipcRenderer.invoke(
        PlatformChannels.ZcodeGoTrimForkedSessionHistory,
        payload,
      ),
    /** zcode-go：在新窗口打开会话（同实例多窗口）。 */
    /** zcode-go：静默 fork（手动触发，第一批验证入口）。 */
    zcodeGoSilentFork: (payload: {
      sessionId: string;
    }): Promise<{ ok: boolean; forkSessionId?: string; error?: string }> =>
      ipcRenderer.invoke(PlatformChannels.ZcodeGoSilentFork, payload),
    /** zcode-go：hover fork（direct 流程：child 立即可用，边界前历史后台补齐）。 */
    zcodeGoHoverFork: (payload: {
      sessionId: string;
    }): Promise<{ ok: boolean; childSessionId?: string; error?: string }> =>
      ipcRenderer.invoke(PlatformChannels.ZcodeGoHoverFork, payload),
    /** zcode-go：会话被静默转接（原会话 → 隐形 fork）事件；返回退订函数。 */
    zcodeGoOnSessionRedirected: (
      callback: (payload: { from: string; to: string }) => void,
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { from: string; to: string },
      ) => callback(payload);
      ipcRenderer.on(PlatformChannels.ZcodeGoSessionRedirected, listener);
      return () =>
        ipcRenderer.removeListener(
          PlatformChannels.ZcodeGoSessionRedirected,
          listener,
        );
    },
    zcodeGoOpenSessionInNewWindow: (payload: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(
        PlatformChannels.ZcodeGoOpenSessionInNewWindow,
        payload,
      ),
    /** zcode-go：移动端远程控制——开始配对。 */
    zcodeGoMobileBridgeStart: (): Promise<{
      state:
        | "idle"
        | "signaling"
        | "waiting-mobile"
        | "connecting"
        | "connected"
        | "error";
      pairingUrl?: string;
      qrUrl?: string;
      token?: string;
      error?: string;
    }> => ipcRenderer.invoke(PlatformChannels.ZcodeGoMobileBridgeStart),
    /** zcode-go：移动端远程控制——停止。 */
    zcodeGoMobileBridgeStop: (): Promise<void> =>
      ipcRenderer.invoke(PlatformChannels.ZcodeGoMobileBridgeStop),
    /** zcode-go：移动端远程控制——对话框可见性（关闭且无连接时触发空闲收摊保险丝）。 */
    zcodeGoMobileBridgeSetDialogVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke(
        PlatformChannels.ZcodeGoMobileBridgeSetDialogVisible,
        visible,
      ),
    /** zcode-go：移动端远程控制——状态查询。 */
    zcodeGoMobileBridgeGetStatus: (): Promise<{
      state:
        | "idle"
        | "signaling"
        | "waiting-mobile"
        | "connecting"
        | "connected"
        | "error";
      pairingUrl?: string;
      qrUrl?: string;
      token?: string;
      error?: string;
    }> => ipcRenderer.invoke(PlatformChannels.ZcodeGoMobileBridgeGetStatus),
    /** zcode-go：移动端远程控制——信令服务器读取（自部署覆盖/默认）。 */
    zcodeGoMobileBridgeGetSignalingOrigin: (): Promise<{
      effective: string;
      configured: string | null;
      source: "env" | "config" | "default";
    }> =>
      ipcRenderer.invoke(
        PlatformChannels.ZcodeGoMobileBridgeGetSignalingOrigin,
      ),
    /** zcode-go：移动端远程控制——设置信令服务器（写配置；有会话则重建刷新二维码）。 */
    zcodeGoMobileBridgeSetSignalingOrigin: (
      origin: string | null,
    ): Promise<{
      ok: boolean;
      error?: string;
      effective?: string;
    }> =>
      ipcRenderer.invoke(
        PlatformChannels.ZcodeGoMobileBridgeSetSignalingOrigin,
        {
          origin,
        },
      ),
    onZcodeGoMobileBridgeStatusChanged: (
      handler: (status: {
        state:
          | "idle"
          | "signaling"
          | "waiting-mobile"
          | "connecting"
          | "connected"
          | "error";
        pairingUrl?: string;
        token?: string;
        error?: string;
      }) => void,
    ): (() => void) => {
      const listener = (
        _event: unknown,
        status: Parameters<typeof handler>[0],
      ): void => handler(status);
      ipcRenderer.on(
        PlatformChannels.ZcodeGoMobileBridgeStatusChanged,
        listener,
      );
      return () =>
        ipcRenderer.removeListener(
          PlatformChannels.ZcodeGoMobileBridgeStatusChanged,
          listener,
        );
    },
    /** zcode-go：新窗口启动时领取待打开的初始会话（一次性质询）。 */
    zcodeGoTakeSessionInitial: (): Promise<{
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    } | null> => ipcRenderer.invoke(PlatformChannels.ZcodeGoTakeSessionInitial),
    /** zcode-go：OPC 模式——读取工作区公司状态（缺失时 main 初始化默认公司）。 */
    zcodeGoOpcGetState: (payload: {
      workspacePath: string;
    }): Promise<{ ok: boolean; state: unknown; error?: string }> =>
      ipcRenderer.invoke(PlatformChannels.ZcodeGoOpcGetState, payload),
    /** zcode-go：OPC 模式——应用 mutation 批（唯一写路径；成功后广播全窗口）。 */
    zcodeGoOpcApply: (payload: {
      workspacePath: string;
      mutations: unknown[];
    }): Promise<{
      ok: boolean;
      state: unknown;
      events: unknown[];
      promotedSkillIds: string[];
      error?: string;
    }> => ipcRenderer.invoke(PlatformChannels.ZcodeGoOpcApply, payload),
    /** zcode-go：OPC 模式——导入角色模板目录（OpenOPC talent 五字段格式）。 */
    zcodeGoOpcImportRoleTemplates: (payload: {
      workspacePath: string;
      sourcePath: string;
    }): Promise<{
      ok: boolean;
      imported: number;
      state: unknown;
      error?: string;
    }> =>
      ipcRenderer.invoke(
        PlatformChannels.ZcodeGoOpcImportRoleTemplates,
        payload,
      ),
    /** zcode-go：OPC 模式——导入技能目录（claude-skills SKILL.md 格式，递归）。 */
    zcodeGoOpcImportSkillFolder: (payload: {
      workspacePath: string;
      sourcePath: string;
    }): Promise<{
      ok: boolean;
      imported: number;
      state: unknown;
      error?: string;
    }> =>
      ipcRenderer.invoke(PlatformChannels.ZcodeGoOpcImportSkillFolder, payload),
    /** zcode-go：OPC 模式——消费入站队列条目（转工作项或忽略；文件名须纯 basename）。 */
    zcodeGoOpcConsumeInbox: (payload: {
      workspacePath: string;
      fileName: string;
      convert?: {
        title: string;
        detail?: string;
        priority?: string;
        assigneeId?: string | null;
      } | null;
    }): Promise<{
      ok: boolean;
      state: unknown;
      inbox: unknown[];
      error?: string;
    }> => ipcRenderer.invoke(PlatformChannels.ZcodeGoOpcConsumeInbox, payload),
    /** zcode-go：OPC 模式——读模型指纹采集样本（文件不存在返回 null 由采集端轮询）。 */
    zcodeGoOpcReadFingerprintSample: (payload: {
      workspacePath: string;
      fileName: string;
    }): Promise<{ ok: boolean; content: string | null; error?: string }> =>
      ipcRenderer.invoke(
        PlatformChannels.ZcodeGoOpcReadFingerprintSample,
        payload,
      ),
    onZcodeGoOpcStateChanged: (
      handler: (payload: { workspacePath: string }) => void,
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { workspacePath: string },
      ) => handler(payload);
      ipcRenderer.on(PlatformChannels.ZcodeGoOpcStateChanged, listener);
      return () =>
        ipcRenderer.removeListener(
          PlatformChannels.ZcodeGoOpcStateChanged,
          listener,
        );
    },
  };
}
