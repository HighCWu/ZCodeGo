/**
 * zcode-go 文案（zh-CN）——独立文件，locale 主文件的门控点仅 import + 一行 spread。
 */
export const zcodeGoMessagesZhCN: Record<string, string> = {
  "zcodeGoMobileBridge.signalingOrigin.title": "P2P 信令服务器",
  "zcodeGoMobileBridge.signalingOrigin.description": "默认使用官方服务；自部署可改为你的 Worker 地址。",
  "zcodeGoMobileBridge.signalingOrigin.apply": "确认变更",
  "zcodeGoMobileBridge.signalingOrigin.applied": "已保存，二维码已刷新",
  "zcodeGoMobileBridge.signalingOrigin.resetHint": "清空后确认可恢复默认服务",
  "zcodeGoMobileBridge.signalingOrigin.saveFailed": "保存失败，请重试",
  "zcodeGoMobileBridge.signalingOrigin.invalidUrl": "地址需为有效的 https:// URL（本地调试可用 http://localhost）",
  "zcodeGoMobileBridge.signalingOrigin.envOverride": "环境变量 ZCODE_GO_SIGNALING_ORIGIN 覆盖中，配置已保存但未生效",
  "zcodeGoMobileBridge.section": "P2P 直连",
  "zcodeGoMobileBridge.hint": "扫码或在手机上打开链接，即可远程控制当前桌面。连接为手机与桌面直连（WebRTC P2P）。",
  "zcodeGoMobileBridge.copyLink.copied": "已复制",
  "zcodeGoMobileBridge.refresh": "重新生成配对码",
  "zcodeGo.fork.inProgress": "正在分叉 {count} 条历史（官方分叉完整复制需较长时间；模型上下文从压缩摘要处继续），完成后自动切换…",
  "taskList.openInNewWindow": "在新窗口打开",
  "taskList.openInNewWindowFailed": "在新窗口打开会话失败：{error}",
};
