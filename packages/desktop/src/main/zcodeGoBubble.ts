/**
 * zcode-go 圆形悬浮气泡（"返回官方版"后的再入口）。
 *
 * 120×120 透明无框画布（56px 圆居中，hover 放大与阴影完整余量）、
 * 置顶（screen-saver 级）、不进任务栏，固定于主显示器工作区右下角；
 * 视觉 = 官方 ZCode logo 背景 + 右下角 "Go" 角标；
 * 点击经独立小 preload 发 IPC 回主进程进入 zcode-go。
 * 参考实现：windowsCuaOperationIndicator（同为透明置顶小窗）。
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";

const BUBBLE_CANVAS = 120; // 窗口画布：56 圆 + hover 放大 + 24px 阴影模糊的完整余量
const BUBBLE_MARGIN = 24;
const VISUAL_CAPTURE_RADIUS = 34; // 圆 28px + 角标右下外扩 ≈6px
const BUBBLE_ENTER_CHANNEL = "zcode:zcode-go-bubble-enter";

export interface ZCodeGoBubbleController {
  show(): void;
  hide(): void;
  destroy(): void;
}

let cachedLogoDataUrl: string | null = null;

/** Linux 指针位置探针：xdotool getmouselocation（同步、~2ms）。 */
function cursorProbe(): { x: number; y: number } | null {
  try {
    const out = spawnSync("xdotool", ["getmouselocation"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const m = /x:(-?\d+)\s+y:(-?\d+)/.exec(out.stdout ?? "");
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

/** 官方 ZCode logo（resources/icon_512x512.png）→ data URL，缓存一次。 */
function officialLogoDataUrl(): string {
  if (cachedLogoDataUrl) return cachedLogoDataUrl;
  try {
    const iconPath = join(process.resourcesPath, "icon_512x512.png");
    cachedLogoDataUrl = `data:image/png;base64,${readFileSync(iconPath).toString("base64")}`;
  } catch {
    cachedLogoDataUrl = ""; // 读不到时退化为纯色渐变底
  }
  return cachedLogoDataUrl;
}

function bubbleDataUrl(): string {
  const logo = officialLogoDataUrl();
  const logoLayer = logo
    ? `background-image:url(${logo});background-size:cover;background-position:center;`
    : `background:radial-gradient(circle at 32% 28%, #6ee7ff, #2563eb 62%, #1e3a8a);`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}
  #stage{position:relative;width:120px;height:120px;display:flex;align-items:center;justify-content:center}
  #bubble{position:relative;width:56px;height:56px;border-radius:50%;cursor:pointer;overflow:visible;
    ${logoLayer}
    box-shadow:0 4px 18px rgba(15,23,42,.45);
    user-select:none;-webkit-app-region:no-drag;transition:transform .12s ease, box-shadow .12s ease}
  #bubble:hover{transform:scale(1.08);box-shadow:0 6px 26px rgba(15,23,42,.6)}
  #bubble:active{transform:scale(.96)}
  #badge{position:absolute;right:-4px;bottom:-4px;min-width:22px;height:22px;padding:0 4px;
    border-radius:11px;display:inline-flex;align-items:center;justify-content:center;
    background:linear-gradient(180deg,#9aa5b1 0%,#5c6673 38%,#3f4854 62%,#5b6572 100%);
    color:#fff;font:700 11px/1 system-ui,-apple-system,"PingFang SC",sans-serif;
    letter-spacing:.2px;box-sizing:border-box;
    border:2px solid #fff;
    box-shadow:inset 0 1px 1px rgba(255,255,255,.55), inset 0 -1px 1px rgba(0,0,0,.5), 0 1px 6px rgba(15,23,42,.55)}
  /* 视觉光学居中：em 盒下延空间 + 无降部字形 → 轻微上提；阴影会压低视觉重心，已去除 */
  #badge .t{display:block;transform:translateY(-1px)}
</style></head>
<body><div id="stage"><div id="bubble" title="进入 ZCode Go"><span id="badge"><span class="t">Go</span></span></div></div>
<script>
  document.getElementById("bubble").addEventListener("click", function () {
    if (window.zcodeGoBubble) window.zcodeGoBubble.enter();
  });
</script></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

/**
 * skipTaskbar 兜底：部分 WM（xfwm）对透明无框窗不落实 SKIP_TASKBAR hint，
 * 直接以 xprop 写入 state 原子（直写为整体替换，须带上 ABOVE）。
 */
function enforceSkipTaskbarViaXprop(target: BrowserWindow): void {
  if (process.platform !== "linux") return;
  try {
    // BrowserWindow.id 是 Electron 序号，xprop 需要 X 窗口 id（XID）。
    // getNativeWindowHandle 在 X11 返回 4 字节小端 XID（旧版可能为 hex 字符串）。
    const handle = target.getNativeWindowHandle();
    const xid =
      handle.length === 4
        ? handle.readUInt32LE(0)
        : Number.parseInt(handle.toString("utf8").trim(), 16);
    if (!Number.isFinite(xid) || xid <= 0) return;
    const child = spawn(
      "xprop",
      [
        "-id",
        String(xid),
        "-f",
        "_NET_WM_STATE 32a",
        "-set",
        "_NET_WM_STATE",
        "_NET_WM_STATE_ABOVE, _NET_WM_STATE_SKIP_TASKBAR",
      ],
      { stdio: "ignore" },
    );
    child.on("error", () => {
      /* xprop 缺失时静默 */
    });
  } catch {
    /* best-effort */
  }
}

/** 当前气泡窗口 id（未创建/已销毁为 null）——供主窗选择逻辑显式排除。 */
let ownedBubbleId: number | null = null;

let diagnosticsProvider: (() => Record<string, unknown>) | null = null;

/** DEBUG dump 读取气泡输入轮询诊断。 */
export function getZCodeGoBubbleDiagnostics(): Record<string, unknown> {
  return diagnosticsProvider ? diagnosticsProvider() : { watchRunning: false };
}

export function isZCodeGoBubbleWindow(target: BrowserWindow): boolean {
  return ownedBubbleId !== null && target.id === ownedBubbleId;
}

export function createZCodeGoBubble(options: {
  onEnter: () => void;
  logger: { warn: (...args: unknown[]) => void };
}): ZCodeGoBubbleController {
  let window: BrowserWindow | null = null;

  function positionWindow(target: BrowserWindow): void {
    const workArea = screen.getPrimaryDisplay().workArea;
    // 画布右下对齐；圆心相对画布居中，角标贴圆右下 → 整体视觉略内缩一个边距差
    const x = workArea.x + workArea.width - BUBBLE_CANVAS - BUBBLE_MARGIN;
    const y = workArea.y + workArea.height - BUBBLE_CANVAS - BUBBLE_MARGIN;
    target.setPosition(x, y, false);
  }

  function createWindow(): BrowserWindow | null {
    try {
      const created = new BrowserWindow({
        width: BUBBLE_CANVAS,
        height: BUBBLE_CANVAS,
        icon: join(process.resourcesPath, "icon_512x512.png"),
        // X11: _NET_WM_WINDOW_TYPE_TOOLBAR —— 任务栏按窗口类型排除
        // （skipTaskbar hint 在部分 WM 的透明无框窗上不生效，类型是更底层保险）
        type: "toolbar",
        alwaysOnTop: true,
        focusable: true,
        frame: false,
        hasShadow: false,
        resizable: false,
        show: false,
        skipTaskbar: true,
        transparent: true,
        backgroundColor: "#00000000",
        fullscreenable: false,
        maximizable: false,
        minimizable: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: join(import.meta.dirname, "../preload/zcodeGoBubble.cjs"),
        },
      });
      created.setAlwaysOnTop(true, "screen-saver");
      ownedBubbleId = created.id;
      created.on("closed", () => {
        if (window === created) window = null;
        ownedBubbleId = null;
      });
      void created.loadURL(bubbleDataUrl()).catch((error) => {
        options.logger.warn("[zcode-go] 气泡内容加载失败", error);
      });
      return created;
    } catch (error) {
      options.logger.warn("[zcode-go] 创建气泡失败", error);
      return null;
    }
  }

  ipcMain.removeAllListeners(BUBBLE_ENTER_CHANNEL);
  ipcMain.on(BUBBLE_ENTER_CHANNEL, () => options.onEnter());
  diagnosticsProvider = diagnostics;

  let cursorWatchTimer: NodeJS.Timeout | null = null;
  let lastIgnoreState: boolean | null = null;
  let tickCount = 0;
  let lastHeartbeatAt = 0;
  let lastDist = -1;

  /** 排障：气泡输入轮询诊断（DEBUG dump 读取）。 */
  function diagnostics(): Record<string, unknown> {
    return {
      watchRunning: cursorWatchTimer !== null,
      tickCount,
      lastIgnoreState,
      lastDist,
    };
  }

  /**
   * 透明画布的点击穿透：指针在视觉圆（含角标外扩）内才捕获事件，圆外穿透到下层窗口。
   * 只在状态翻转时调用 setIgnoreMouseEvents——高频重复同态调用会在部分 WM（xfwm）
   * 上把 input shape 打入失效态（表现为整个窗口永久点击穿透）。
   */
  function startCursorWatch(): void {
    stopCursorWatch();
    lastIgnoreState = null;
    cursorWatchTimer = setInterval(() => {
      if (!window || window.isDestroyed()) {
        stopCursorWatch();
        return;
      }
      try {
        // Linux 下 screen.getCursorScreenPoint 有读数冻结怪癖（应用无 X 指针事件时不更新），
        // 用 xdotool getmouselocation 直读；其余平台走原生 API。
        let point: { x: number; y: number };
        if (process.platform === "linux") {
          const out = cursorProbe();
          if (!out) return; // xdotool 缺失则保持现状（捕获态，安全侧）
          point = out;
        } else {
          point = screen.getCursorScreenPoint();
        }
        const bounds = window.getBounds();
        const dx = point.x - (bounds.x + Math.floor(bounds.width / 2));
        const dy = point.y - (bounds.y + Math.floor(bounds.height / 2));
        const dist = Math.hypot(dx, dy);
        const ignore = dist > VISUAL_CAPTURE_RADIUS;
        tickCount += 1;
        lastDist = Math.round(dist);
        if (Date.now() - lastHeartbeatAt > 5000) {
          lastHeartbeatAt = Date.now();
          options.logger.info?.(
            `[zcode-go] 气泡心跳 tick=${tickCount} dist=${lastDist} ignore=${String(ignore)} applied=${String(lastIgnoreState)}`,
          );
        }
        if (ignore === lastIgnoreState) return; // 无翻转不动 input shape
        lastIgnoreState = ignore;
        window.setIgnoreMouseEvents(ignore);
        options.logger.info?.(`[zcode-go] 气泡 input ${ignore ? "穿透" : "捕获"} (dist=${lastDist})`);
      } catch {
        /* 窗口瞬时状态异常则跳过本轮 */
      }
    }, 80);
  }

  function stopCursorWatch(): void {
    if (cursorWatchTimer) {
      clearInterval(cursorWatchTimer);
      cursorWatchTimer = null;
    }
    lastIgnoreState = null;
    try {
      window?.setIgnoreMouseEvents(false);
    } catch { /* 已销毁则忽略 */ }
  }

  return {
    show() {
      try {
        if (!window || window.isDestroyed()) {
          window = createWindow();
        }
        if (!window) return;
        positionWindow(window);
        window.show();
        startCursorWatch();
        // 部分 WM（xfwm）对透明无框窗在构造期设置的 hint 不落盘，show 后重设确保
        // 气泡不出现在任务栏（SKIP_TASKBAR）且图标生效。
        window.setSkipTaskbar(true);
        window.setAlwaysOnTop(true, "screen-saver");
        enforceSkipTaskbarViaXprop(window);
        // 部分 WM（openbox）在窗口映射后会整体重写 _NET_WM_STATE，晚些再补写
        for (const delay of [400, 1200]) {
          setTimeout(() => {
            if (window && !window.isDestroyed()) enforceSkipTaskbarViaXprop(window);
          }, delay);
        }
      } catch (error) {
        options.logger.warn("[zcode-go] 显示气泡失败", error);
      }
    },
    hide() {
      stopCursorWatch();
      try {
        if (window && !window.isDestroyed()) window.hide();
      } catch {
        /* 忽略 */
      }
    },
    destroy() {
      stopCursorWatch();
      try {
        if (window && !window.isDestroyed()) window.destroy();
      } catch {
        /* 忽略 */
      }
      window = null;
      ipcMain.removeAllListeners(BUBBLE_ENTER_CHANNEL);
    },
  };
}
