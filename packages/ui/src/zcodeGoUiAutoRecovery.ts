/**
 * zcode-go UI 崩溃自动恢复——额度/计划逻辑（从 ErrorBoundary.tsx 拆出：
 * 上游合并门控点 = ErrorBoundary 的 import + 两个边界类内的纯新增插桩）。
 * 局部边界先 reset（仅重渲染出错区域），同 scope 再崩升级整页 reload；
 * 根级边界直接 reload。会话级滑动额度（每 scope 5 分钟 3 次）防无限循环，
 * 超限退回手动恢复。
 */
import { useEffect } from "react";
import { logger } from "@/logger.js";
import { useSettings } from "@/hooks/useSettingService.js";

// ── zcode-go：UI 崩溃自动恢复 ─────────────────────────────
// 官方错误边界只提供手动恢复按钮；go 版在崩溃进入 fallback 后自动恢复：
// 局部（Scoped）边界先 reset 重渲染（比整页 reload 轻得多，侧栏/其他面板状态
// 不受影响），同一 scope 再次崩溃则升级为整页 reload；根级（App）边界直接
// reload。会话级滑动额度（每 scope 5 分钟 3 次）防无限循环，超限退回手动。
const ZCODE_GO_AUTO_RECOVERY_KEY = "zcodeGoUiAutoRecovery";
export const ZCODE_GO_AUTO_RECOVERY_DELAY_MS = 8_000;

// 设置页「ZCode Go」开关的运行态镜像（App 挂载时经 useZcodeGoUiAutoRecoverySync
// 同步；ErrorBoundary 是 class 组件读不到 hook，plan 阶段读本标志短路）。
let zcodeGoUiAutoRecoveryEnabled = true;
export function setZcodeGoUiAutoRecoveryEnabled(enabled: boolean): void {
  zcodeGoUiAutoRecoveryEnabled = enabled;
}
export function isZcodeGoUiAutoRecoveryEnabled(): boolean {
  return zcodeGoUiAutoRecoveryEnabled;
}
const ZCODE_GO_AUTO_RECOVERY_WINDOW_MS = 5 * 60_000;
const ZCODE_GO_AUTO_RECOVERY_MAX = 3;

export function readZcodeGoAutoRecoveryStore(): Record<string, number[]> {
  try {
    return JSON.parse(sessionStorage.getItem(ZCODE_GO_AUTO_RECOVERY_KEY) ?? "{}") as Record<
      string,
      number[]
    >;
  } catch {
    return {};
  }
}

/**
 * 计划一次自动恢复；返回恢复动作（"reset" | "reload" | null——额度用尽）。
 * scoped 边界第 1 次 reset、后续 reload；App 边界恒 reload。
 */
export function planZcodeGoAutoRecovery(scope: string, preferReset: boolean): "reset" | "reload" | null {
  if (!zcodeGoUiAutoRecoveryEnabled) {
    return null;
  }
  const now = Date.now();
  const store = readZcodeGoAutoRecoveryStore();
  const history = (store[scope] ?? []).filter((at) => now - at < ZCODE_GO_AUTO_RECOVERY_WINDOW_MS);
  if (history.length >= ZCODE_GO_AUTO_RECOVERY_MAX) return null;
  history.push(now);
  try {
    sessionStorage.setItem(ZCODE_GO_AUTO_RECOVERY_KEY, JSON.stringify({ ...store, [scope]: history }));
  } catch {
    /* 隐私模式等 sessionStorage 不可用时退化为本次会话不限额（崩溃循环仍受 8s 延迟约束） */
  }
  return preferReset && history.length === 1 ? "reset" : "reload";
}

/** 设置同步 hook：App 挂载时把「ZCode Go」设置镜像进本模块运行态标志。 */
export function useZcodeGoUiAutoRecoverySync(): void {
  const { settings } = useSettings();
  useEffect(() => {
    setZcodeGoUiAutoRecoveryEnabled(settings?.zcodeGoUiAutoRecovery !== false);
  }, [settings?.zcodeGoUiAutoRecovery]);
}
