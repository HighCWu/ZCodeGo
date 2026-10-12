/**
 * zcode-go 文案（en-US）——独立文件，locale 主文件的门控点仅 import + 一行 spread。
 */
export const zcodeGoMessagesEnUs: Record<string, string> = {
  "zcodeGoMobileBridge.signalingOrigin.title": "P2P signaling server",
  "zcodeGoMobileBridge.signalingOrigin.description": "Defaults to the official service; point to your own Worker for self-deployment.",
  "zcodeGoMobileBridge.signalingOrigin.apply": "Apply",
  "zcodeGoMobileBridge.signalingOrigin.applied": "Saved, QR refreshed",
  "zcodeGoMobileBridge.signalingOrigin.resetHint": "Clear and apply to restore the default service",
  "zcodeGoMobileBridge.signalingOrigin.saveFailed": "Save failed, please retry",
  "zcodeGoMobileBridge.signalingOrigin.invalidUrl": "Enter a valid https:// URL (http://localhost allowed for local testing)",
  "zcodeGoMobileBridge.signalingOrigin.envOverride": "Env ZCODE_GO_SIGNALING_ORIGIN is overriding — saved but not effective",
  "zcodeGoMobileBridge.section": "P2P direct",
  "zcodeGoMobileBridge.hint": "Scan the QR code or open the link on your phone to control this desktop. The connection is phone-to-desktop directly (WebRTC P2P).",
  "zcodeGoMobileBridge.copyLink.copied": "Copied",
  "zcodeGoMobileBridge.refresh": "Regenerate pairing code",
  "zcodeGo.fork.inProgress": "Forking {count} messages — the official fork copies full history and may take a while; the model context continues from the compaction summary. Switching automatically…",
  "taskList.openInNewWindow": "Open in new window",
  "taskList.openInNewWindowFailed": "Failed to open session in a new window: {error}",
  "settings.zcodeGo.title": "ZCode Go",
  "settings.zcodeGo.p2pBridge": "P2P direct remote bridge",
  "settings.zcodeGo.p2pBridgeDescription": "Enable the ZCode Go WebRTC direct channel in the remote dialog (zero relay when phone and desktop share a network; no third-party server). When off, the dialog keeps only the official relay entry.",
  "settings.zcodeGo.hoverForkDualSession": "Hover fork dual-session model",
  "settings.zcodeGo.hoverForkDualSessionDescription": "Manual fork produces a visible task row plus a lean active endpoint with hover redirect and background history backfill. When off, manual fork uses the compatible rotation model.",
  "settings.zcodeGo.mobileDrawer": "Mobile drawer viewport",
  "settings.zcodeGo.mobileDrawerDescription": "Render the sidebar as a slide-in drawer on mobile viewports. When off, mobile viewports render with the desktop layout.",
  "settings.zcodeGo.uiAutoRecovery": "UI crash auto-recovery",
  "settings.zcodeGo.uiAutoRecoveryDescription": "Automatically re-render or reload after a UI subtree crash (max 3 times per area within 5 minutes). When off, only manual recovery buttons are offered.",
};
