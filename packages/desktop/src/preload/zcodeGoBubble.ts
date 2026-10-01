/**
 * zcode-go 悬浮气泡专用 preload。
 *
 * 只暴露一件事：点击通知 main 进入 zcode-go。不复用主窗口 preload——
 * 气泡加载的是 data URL，攻击面越小越好（参考 cuaPermissionPanel）。
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("zcodeGoBubble", {
  enter: () => ipcRenderer.send("zcode:zcode-go-bubble-enter"),
});
