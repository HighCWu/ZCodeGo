/**
 * zcode-go 渲染进程崩溃自动恢复（render-process-gone → reload）。
 *
 * 官方对 render-process-gone 只做遥测上报与 dump 归档（desktopStabilityTelemetry
 * 的 markWebContentsCrash/classifyRenderProcessCrash），渲染进程死后主窗口保持
 * 白屏，只能重启应用。go 版在这里补上自动恢复：
 *
 *   - 仅作用于窗口型 webContents（type === "window"），辅助 webContents 不动
 *   - clean-exit（关闭窗口的正常退出）不恢复
 *   - 防崩溃循环：单个 webContents 在 5 分钟滑动窗口内最多自动恢复 3 次，
 *     超出后放弃并打日志（崩溃循环里高频 reload 只会打满 CPU）
 *   - 延迟 1.5s 再 reload：进程刚死时立即重载可能失败，留出清理窗口
 *
 * React 组件树级的崩溃恢复（ErrorBoundary 自动 reset/reload）在 ui 层
 * ErrorBoundary.tsx 的 zcode-go 自动恢复逻辑里，两层互不替代：
 * 进程级崩溃连错误页都渲染不出来，组件级崩溃则进程还活着。
 */
import { app, BrowserWindow } from "electron";

const RECOVERY_DELAY_MS = 1_500;
const WINDOW_MS = 5 * 60_000;
const MAX_RECOVERIES_PER_WINDOW = 3;

interface RecoveryLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

const recoveryHistory = new Map<number, number[]>();
let registered = false;

export function initZcodeGoRendererRecovery(logger: RecoveryLogger): void {
  if (registered) return;
  registered = true;

  app.on("render-process-gone", (_event, webContents, details) => {
    if (details.reason === "clean-exit") return;
    if (webContents.getType() !== "window") return;
    const win = BrowserWindow.fromWebContents(webContents);
    if (!win || win.isDestroyed()) return;

    const now = Date.now();
    const history = (recoveryHistory.get(webContents.id) ?? []).filter(
      (at) => now - at < WINDOW_MS,
    );
    if (history.length >= MAX_RECOVERIES_PER_WINDOW) {
      logger.warn(
        "[zcode-go-renderer-recovery] 渲染进程 5 分钟内崩溃次数超限，停止自动恢复（reason=" +
          details.reason +
          "，可手动重启应用）",
      );
      return;
    }
    history.push(now);
    recoveryHistory.set(webContents.id, history);
    logger.info(
      "[zcode-go-renderer-recovery] 渲染进程崩溃，自动重载窗口",
      {
        reason: details.reason,
        exitCode: details.exitCode,
        attempt: history.length,
      },
    );
    setTimeout(() => {
      try {
        if (!win.isDestroyed() && !webContents.isDestroyed()) {
          webContents.reload();
        }
      } catch (error) {
        logger.warn(
          "[zcode-go-renderer-recovery] 自动重载失败",
          error instanceof Error ? error.message : String(error),
        );
      }
    }, RECOVERY_DELAY_MS).unref?.();
  });
}
