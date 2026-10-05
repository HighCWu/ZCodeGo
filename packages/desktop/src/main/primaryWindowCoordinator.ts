import type { StartupWindowBootstrap } from "./startupWorkspace.js";

interface WindowLike {
  destroy?(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized?(): boolean;
  isRendererCrashed?(): boolean;
  webContents?: {
    isCrashed?: () => boolean;
  };
  restore?(): void;
  show(): void;
  focus?(): void;
}

interface PrimaryWindowCoordinatorDeps {
  listWindows(): WindowLike[];
  resolveStartupWindowBootstrap(): Promise<StartupWindowBootstrap>;
  createWindow(startupBootstrap: StartupWindowBootstrap): void;
  canCreateWindow?: (reason: string) => boolean;
  logger: {
    info(message: string): void;
  };
}

export function createPrimaryWindowCoordinator(deps: PrimaryWindowCoordinatorDeps) {
  let pendingEnsurePromise: Promise<void> | null = null;

  function isRendererCrashed(window: WindowLike): boolean {
    return Boolean(window.isRendererCrashed?.() || window.webContents?.isCrashed?.());
  }

  // 应用窗口按隐藏（关闭到托盘/dock 隐藏）先后顺序记录；重复 hide 幂等移到队尾。
  const hiddenWindows: WindowLike[] = [];

  /** 窗口隐藏时记录（index.ts 在应用窗口的 hide 事件上调用；销毁窗口惰性清理）。 */
  function noteWindowHidden(window: WindowLike): void {
    const index = hiddenWindows.indexOf(window);
    if (index >= 0) hiddenWindows.splice(index, 1);
    hiddenWindows.push(window);
    while (hiddenWindows.length > 0 && hiddenWindows[0]!.isDestroyed()) {
      hiddenWindows.shift();
    }
  }

  function discardCrashedWindows(windows: WindowLike[]): WindowLike[] {
    const alive: WindowLike[] = [];
    for (const window of windows) {
      if (window.isDestroyed()) {
        continue;
      }
      if (isRendererCrashed(window)) {
        // renderer native crash 后 BrowserWindow 仍可能存活；继续复用会让 macOS 激活时只显示白屏空壳。
        window.destroy?.();
        deps.logger.info("[primary-window] discarded crashed renderer window");
        continue;
      }
      alive.push(window);
    }
    return alive;
  }

  function focusLatestVisible(windows: WindowLike[]): boolean {
    let focusTarget: WindowLike | null = null;
    for (const window of windows) {
      if (window.isMinimized?.()) {
        window.restore?.();
      }
      focusTarget = window;
    }
    focusTarget?.focus?.();
    return windows.length > 0;
  }

  function revealExistingWindow(): boolean {
    const alive = discardCrashedWindows(deps.listWindows());
    if (alive.length === 0) {
      return false;
    }
    // 多窗口语义（zcode-go「在新窗口打开」）：还有开着的窗口就不恢复被隐藏的
    // ——它们是用户主动关闭的，点托盘/dock 只把现有可见窗口带到前台；全部窗口
    // 都被关闭时，恢复最后一个被关闭的那个（隐藏顺序记录）。
    const visible = alive.filter((window) => window.isVisible());
    if (visible.length > 0) {
      return focusLatestVisible(visible);
    }
    for (let i = hiddenWindows.length - 1; i >= 0; i -= 1) {
      const window = hiddenWindows[i]!;
      if (window.isDestroyed()) {
        hiddenWindows.splice(i, 1);
        continue;
      }
      if (isRendererCrashed(window)) {
        window.destroy?.();
        hiddenWindows.splice(i, 1);
        continue;
      }
      window.show();
      window.focus?.();
      return true;
    }
    // 无隐藏记录（进程内从未走 hide 路径的兜底）：显示最早的存活窗口。
    return focusLatestVisible([alive[0]!]);
  }

  async function ensurePrimaryWindow(reason: string) {
    if (deps.canCreateWindow && !deps.canCreateWindow(reason)) {
      // 强制升级是进程级 gate，activate/dock/tray/open-url 等入口也必须共享同一阻断边界。
      deps.logger.info(`[primary-window] window creation blocked (${reason})`);
      return;
    }

    if (revealExistingWindow()) {
      deps.logger.info(`[primary-window] reused existing window (${reason})`);
      return;
    }

    if (pendingEnsurePromise) {
      deps.logger.info(`[primary-window] window creation already pending (${reason})`);
      return pendingEnsurePromise;
    }

    // macOS 上应用冷启动时，app.activate 可能和启动阶段异步并发到达。
    // 如果 ready 和 activate 都各自 resolveStartupWindowBootstrap 后直接 createWindow，
    // 最新版首次启动就可能并发创建两个主窗口。这里用单飞 promise 收敛成一次创建。
    deps.logger.info(`[primary-window] creating main window (${reason})`);
    pendingEnsurePromise = deps
      .resolveStartupWindowBootstrap()
      .then((startupBootstrap) => {
        if (revealExistingWindow()) {
          deps.logger.info(`[primary-window] window became available before create (${reason})`);
          return;
        }

        deps.createWindow(startupBootstrap);
      })
      .finally(() => {
        pendingEnsurePromise = null;
      });

    return pendingEnsurePromise;
  }

  return {
    ensurePrimaryWindow,
    noteWindowHidden,
  };
}
