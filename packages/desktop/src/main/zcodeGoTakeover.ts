/**
 * zcode-go 桌面接管（takeover 模式，env ZCODE_GO_TAKEOVER=1）。
 *
 * 分工：插件是官方体内的"内应"（探测官方安装、写 ~/.zcode-go/official.json、
 * 拉起本应用并触碰 SHOW）；本模块是常驻主体：
 * - 就绪标记（desktop.pid）供插件编排探活
 * - 监听 ~/.zcode-go/SHOW → 隐藏官方窗口、显示自己（enterZCodeGo）
 * - returnToOfficial()：detached 启动官方二进制（其单实例锁自动唤回窗口）→
 *   隐藏自己 → 显示圆形悬浮气泡
 * - 跨平台隐藏官方窗口：linux xdotool windowunmap / darwin osascript / win32 ShowWindow
 * - 官方路径解析链：official.json（插件探测）→ config.json 覆盖 → 平台默认
 */
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createZCodeGoBubble,
  getZCodeGoBubbleDiagnostics,
  type ZCodeGoBubbleController,
} from "./zcodeGoBubble.js";

const ZCODE_GO_DIR = join(homedir(), ".zcode-go");
const OFFICIAL_JSON = join(ZCODE_GO_DIR, "official.json");
const CONFIG_JSON = join(ZCODE_GO_DIR, "config.json");
const STATE_JSON = join(ZCODE_GO_DIR, "takeover-state.json");
const PID_FILE = join(ZCODE_GO_DIR, "desktop.pid");
const SHOW_FILE = join(ZCODE_GO_DIR, "SHOW");

const OFFICIAL_BIN_DEFAULTS: Record<NodeJS.Platform, string[]> = {
  linux: ["/opt/ZCode/zcode", "/usr/lib/zcode/zcode", "/usr/local/zcode/zcode"],
  darwin: ["/Applications/ZCode.app/Contents/MacOS/zcode"],
  win32: [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "ZCode", "zcode.exe"),
    join(process.env.ProgramFiles ?? "", "ZCode", "zcode.exe"),
  ],
};

interface TakeoverContext {
  getMainWindow: () => BrowserWindow | null;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

let context: TakeoverContext | null = null;
let bubble: ZcodeGoBubbleController | null = null;
let showWatcher: ReturnType<typeof watch> | null = null;
let switching = false;
let officialWatchTimer: ReturnType<typeof setInterval> | null = null;

export function isZCodeGoTakeoverEnabled(): boolean {
  const value = process.env.ZCODE_GO_TAKEOVER;
  return value === "1" || value === "true";
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 官方 bin 解析链：official.json → config.json 覆盖 → 平台默认。 */
export function resolveOfficialBin(): string | null {
  const official = readJsonFile(OFFICIAL_JSON);
  const fromOfficial = typeof official?.bin === "string" ? official.bin : "";
  if (fromOfficial && existsSync(fromOfficial)) {
    return fromOfficial;
  }
  const config = readJsonFile(CONFIG_JSON);
  const fromConfig = typeof config?.officialBin === "string" ? config.officialBin : "";
  if (fromConfig && existsSync(fromConfig)) {
    return fromConfig;
  }
  for (const candidate of OFFICIAL_BIN_DEFAULTS[process.platform] ?? []) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function writeState(patch: Record<string, unknown>): void {
  try {
    mkdirSync(ZCODE_GO_DIR, { recursive: true });
    const previous = readJsonFile(STATE_JSON) ?? {};
    writeFileSync(STATE_JSON, JSON.stringify({ ...previous, ...patch }, null, 1), "utf8");
  } catch (error) {
    context?.logger.warn("[zcode-go] 写 takeover-state 失败", error);
  }
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 8000,
): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 16384) child.kill();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout });
      });
    } catch {
      resolve(null);
    }
  });
}

/** 跨平台隐藏官方应用全部窗口（进程与会话不中断）。 */
export async function hideOfficialWindows(officialBin: string): Promise<boolean> {
  if (process.platform === "linux") {
    // 官方主进程的 cmdline 被 Electron 改写为 "ZCode"（comm 同），pgrep -f 官方路径
    // 只能命中无窗口的 zygote（实测 hiddenWindows=0 的根因）——改按窗口 class 锚定
    // 搜索再按 pid 过滤：官方主窗 class="ZCode"，本应用为 "ZCode Go"，互不重叠；
    // class="Zcode" 的辅助窗口按 _NET_WM_PID 排除本进程后一并处理（unmap 不可见
    // 辅助窗无害）。被 unmap 的窗口在 X 窗口树仍可被 search 到，恢复见 returnToOfficial。
    const search = await runCommand("xdotool", ["search", "--class", "^(ZCode|zcode)$"]);
    let windowIds =
      search && search.code === 0
        ? search.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
        : [];
    if (windowIds.length === 0) {
      // 回退：pgrep 路径匹配（非 Electron 改写场景，如官方以脚本包装启动）
      const pgrep = await runCommand("pgrep", ["-f", officialBin]);
      const pids = (pgrep?.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
      for (const pid of pids) {
        const byPid = await runCommand("xdotool", ["search", "--pid", pid]);
        if (byPid && byPid.code === 0) {
          windowIds.push(...byPid.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
        }
      }
    }
    let hidden = 0;
    const unmapped: string[] = [];
    for (const windowId of windowIds) {
      const pidProp = await runCommand("xprop", ["-id", windowId, "_NET_WM_PID"]);
      const ownerPid = Number(pidProp?.stdout.match(/(\d+)\s*$/)?.[1] ?? 0);
      if (ownerPid === process.pid) continue;
      const unmap = await runCommand("xdotool", ["windowunmap", windowId]);
      if (unmap && unmap.code === 0) {
        hidden += 1;
        unmapped.push(windowId);
      }
    }
    writeState({
      officialBin,
      hiddenWindows: hidden,
      ...(unmapped.length > 0 ? { unmappedWindowIds: unmapped } : {}),
      officialHiddenAt: Date.now(),
    });
    return hidden > 0;
  }
  if (process.platform === "darwin") {
    const appName = officialBin.includes(".app/")
      ? (officialBin.split(".app/")[0] ?? "").split("/").pop() || "ZCode"
      : "ZCode";
    const result = await runCommand("osascript", ["-e", `tell application "${appName}" to hide`]);
    const ok = result?.code === 0;
    writeState({ officialBin, officialHiddenAt: Date.now(), lastError: ok ? undefined : "osascript-failed" });
    return ok;
  }
  if (process.platform === "win32") {
    const script = [
      "Add-Type 'using System;using System.Runtime.InteropServices;public class W{",
      "[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);}",
      `Get-Process | Where-Object { $_.Path -eq '${officialBin.replace(/'/g, "''")}' -and $_.MainWindowHandle -ne 0 } |`,
      "ForEach-Object { [W]::ShowWindow($_.MainWindowHandle, 0) | Out-Null }",
    ].join(" ");
    const result = await runCommand("powershell", ["-NoProfile", "-Command", script], 15000);
    const ok = result?.code === 0;
    writeState({ officialBin, officialHiddenAt: Date.now(), lastError: ok ? undefined : "powershell-failed" });
    return ok;
  }
  return false;
}

/** 显示自己、隐藏官方（SHOW 信号与气泡点击共用路径）。 */
export async function enterZCodeGo(): Promise<void> {
  if (!context || switching) return;
  switching = true;
  try {
    bubble?.hide();
    const officialBin = resolveOfficialBin();
    if (officialBin) {
      await hideOfficialWindows(officialBin);
    } else {
      writeState({ lastError: "official-bin-not-found", at: Date.now() });
    }
    const main = context.getMainWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
    context.logger.info("[zcode-go] enterZCodeGo 完成");
  } finally {
    switching = false;
  }
}

/** 返回官方：唤回官方窗口、自己转气泡。 */
export async function returnToOfficial(): Promise<void> {
  if (!context || switching) return;
  switching = true;
  try {
    const officialBin = resolveOfficialBin();
    if (!officialBin) {
      context.logger.warn("[zcode-go] 未找到官方安装（official.json / config.json / 平台默认均未命中）");
      writeState({ lastError: "official-bin-not-found", at: Date.now() });
      return;
    }
    if (process.platform === "linux") {
      // 被 unmap 的官方窗口，Electron 单实例唤回的 show() 未必重新 map——按隐藏时
      // 记录的窗口 id（缺省按 class 重搜）显式 map + 激活，保证切回时窗口必回。
      const state = readJsonFile(STATE_JSON) ?? {};
      const recorded = Array.isArray(state.unmappedWindowIds)
        ? (state.unmappedWindowIds as unknown[]).filter((id): id is string => typeof id === "string")
        : [];
      let windowIds = recorded;
      if (windowIds.length === 0) {
        const search = await runCommand("xdotool", ["search", "--class", "^(ZCode|zcode)$"]);
        windowIds =
          search && search.code === 0
            ? search.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
            : [];
      }
      for (const windowId of windowIds) {
        await runCommand("xdotool", ["windowmap", windowId]);
      }
      if (windowIds.length > 0) {
        await runCommand("xdotool", ["windowactivate", windowIds[0]!]);
      }
      writeState({ unmappedWindowIds: [] });
    }
    // 官方单实例锁保证已运行时只唤回窗口；未运行则冷启动。
    // zcode-go：带上 /zcode-go 来源工作区的 --open-workspace 深链——唤回后激活该
    // 工作区而非停留在已裁剪/已删除的空会话视图（hook 写 return-workspace）。
    // 部分缓解：若该工作区标签本就开着且停在原会话上，深链只聚焦不导航。
    const spawnArgs: string[] = [];
    try {
      const returnWorkspace = readFileSync(join(ZCODE_GO_DIR, "return-workspace"), "utf8").trim();
      if (returnWorkspace && returnWorkspace.startsWith("/") && !returnWorkspace.includes("..")) {
        spawnArgs.push("--open-workspace", returnWorkspace);
      }
    } catch {
      /* 无记录：普通唤回 */
    }
    const child = spawn(officialBin, spawnArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const main = context.getMainWindow();
    if (main && !main.isDestroyed()) {
      main.hide();
    }
    bubble?.show();
    writeState({ officialBin, returnedAt: Date.now() });
    context.logger.info("[zcode-go] returnToOfficial 完成");
  } finally {
    switching = false;
  }
}

/** renderer 侧"返回官方版"按钮（executeDesktopCommand）与窗口关闭共用。 */
export function getZCodeGoTakeoverHandler(): { returnToOfficial: () => void } | null {
  return isZCodeGoTakeoverEnabled() ? { returnToOfficial: () => void returnToOfficial() } : null;
}

async function dumpWindowStates(trigger: string): Promise<void> {
  try {
    const snapshot = () =>
      BrowserWindow.getAllWindows().map((w) => ({
        id: w.id,
        title: w.getTitle(),
        visible: w.isVisible(),
        minimized: w.isMinimized(),
        destroyed: w.isDestroyed(),
        focusable: w.isFocusable(),
        bounds: w.getBounds(),
        mainWindowListed: (() => {
          try {
            return context?.getMainWindow()?.id === w.id;
          } catch {
            return false;
          }
        })(),
      }));
    let bubbleDiag: Record<string, unknown> = {};
    try {
      bubbleDiag = getZCodeGoBubbleDiagnostics();
    } catch { /* 模块未初始化 */ }
    const before = snapshot();
    const main = context?.getMainWindow();
    main?.show();
    await new Promise((r) => setTimeout(r, 800));
    const after = snapshot();
    mkdirSync(ZCODE_GO_DIR, { recursive: true });
    writeFileSync(
      join(ZCODE_GO_DIR, "debug-dump.json"),
      JSON.stringify({ trigger, mainId: main?.id ?? null, bubble: bubbleDiag, before, after }, null, 1),
      "utf8",
    );
    context?.logger.info("[zcode-go] DEBUG dump 已写入", { trigger, mainId: main?.id ?? null });
  } catch (error) {
    context?.logger.warn("[zcode-go] DEBUG dump 失败", error);
  }
}

function handleShowSignal(): void {
  try {
    if (existsSync(SHOW_FILE)) unlinkSync(SHOW_FILE);
  } catch {
    /* 忽略 */
  }
  void enterZCodeGo();
}

export function initZCodeGoTakeover(options: TakeoverContext): void {
  if (!isZCodeGoTakeoverEnabled()) return;
  context = options;
  try {
    mkdirSync(ZCODE_GO_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid), "utf8");
  } catch (error) {
    options.logger.warn("[zcode-go] 写 desktop.pid 失败", error);
  }
  bubble = createZCodeGoBubble({
    onEnter: () => void enterZCodeGo(),
    logger: options.logger,
  });
  try {
    showWatcher = watch(ZCODE_GO_DIR, (_event, filename) => {
      if (filename === "SHOW") handleShowSignal();
    });
    showWatcher.on("error", () => {
      /* 目录被删等：编排的 SHOW 信号退化为下次启动处理 */
    });
  } catch (error) {
    options.logger.warn("[zcode-go] 监听 SHOW 失败", error);
  }
  app.on("will-quit", () => {
    try {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch {
      /* 忽略 */
    }
    if (officialWatchTimer) {
      clearInterval(officialWatchTimer);
      officialWatchTimer = null;
    }
    showWatcher?.close();
    bubble?.destroy();
  });
  // 取证探针：触碰 ~/.zcode-go/DEBUG → dump 全部窗口状态（含强制 show 前后）
  try {
    const debugFile = join(ZCODE_GO_DIR, "DEBUG");
    watch(ZCODE_GO_DIR, (_event, filename) => {
      if (filename !== "DEBUG") return;
      try {
        if (existsSync(debugFile)) unlinkSync(debugFile);
      } catch { /* 忽略 */ }
      void dumpWindowStates("manual");
    });
    if (existsSync(debugFile)) void dumpWindowStates("startup");
  } catch (error) {
    options.logger.warn("[zcode-go] 监听 DEBUG 失败", error);
  }
  // 编排可能在 watcher 就绪前已触碰 SHOW
  if (existsSync(SHOW_FILE)) handleShowSignal();
  startOfficialExitWatch();
  options.logger.info("[zcode-go] takeover 模式就绪", { pid: process.pid });
}

/**
 * 官方退出联动（用户要求）：官方 zcode 全部进程消失后，zcode-go 桌面与气泡跟随
 * 退出。仅当启动时官方在运行才武装（独立冷启动的 zcode-go 不受影响）。检测用
 * pgrep -f 官方 bin 路径：主进程 cmdline 虽被改写，但 zygote/子进程仍带路径，主
 * 进程退出时它们一并消失 → 计数归零即官方已退出。连续两轮为空才退出（防抖）。
 */
function startOfficialExitWatch(): void {
  if (officialWatchTimer) return;
  const officialBin = resolveOfficialBin();
  if (!officialBin) return;
  let armed = false;
  let emptyStreak = 0;
  officialWatchTimer = setInterval(() => {
    void (async () => {
      try {
        const pgrep = await runCommand("pgrep", ["-f", officialBin]);
        const alive = (pgrep?.stdout ?? "").split("\n").some((line) => /^\d+$/.test(line.trim()));
        if (alive) {
          armed = true;
          emptyStreak = 0;
          return;
        }
        if (!armed) return;
        emptyStreak += 1;
        if (emptyStreak >= 2) {
          context?.logger.info("[zcode-go] 官方已退出，zcode-go 跟随退出");
          if (officialWatchTimer) {
            clearInterval(officialWatchTimer);
            officialWatchTimer = null;
          }
          app.quit();
        }
      } catch {
        /* 单轮检测异常不影响下一轮 */
      }
    })();
  }, 5_000);
  officialWatchTimer.unref?.();
}
