/**
 * zcode-go 桌面接管（takeover 模式，env ZCODE_GO_TAKEOVER=1）。
 *
 * 交互模型（用户定版：不做气泡返回）：/zcode-go → 本应用就绪后**直接退出原版
 * zcode**，zcode-go 作为唯一桌面独立运行。独立性的依据：
 *   - Electron 二进制是磁盘克隆（~/.zcode-go/electron），不是官方进程；
 *   - CLI 运行时是本应用自己 spawn 的子进程（官方 zcode.cjs + 官方 Electron
 *     以 run-as-node 跑），父进程是本应用；
 *   - 会话存储是磁盘共享（~/.zcode/cli/db/db.sqlite）。
 * 原版退出不影响以上任何一环，额度签名链路在官方 bundle 内同样不受影响。
 * 回官方 = 用户直接退出本应用后自行启动官方（无内建返回入口）。
 *
 * 生命周期：
 * - 就绪标记（desktop.pid）供插件编排探活
 * - 监听 ~/.zcode-go/SHOW（编排就绪信号）→ 显示自己 + 退出原版（enterZCodeGo）
 * - 官方路径解析链：official.json（插件探测）→ config.json 覆盖 → 平台默认
 */
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
let showWatcher: ReturnType<typeof watch> | null = null;
let switching = false;

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

function isOwnTreePid(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // 必须 readlink：readFileSync 读 /proc/<pid>/exe 会把整个二进制内容读进内存。
    const exe = readlinkSync(`/proc/${pid}/exe`);
    return exe.length > 0 && exe.startsWith(ZCODE_GO_DIR);
  } catch {
    return false;
  }
}

/**
 * 退出原版 zcode（用户定版：接管即独占，不再气泡共存）。
 * linux：主进程 cmdline 被 Electron 改写为 "ZCode"，pgrep -f 官方路径只能命中
 * zygote/子进程——两个来源并集（路径匹配 + 精确名 ZCode）并排除本应用进程树
 * （本应用 comm 为 "ZCode Go"，运行时子进程在 ~/.zcode-go 下）。SIGTERM 宽限后
 * SIGKILL。darwin 走 osascript 优雅退出；win32 走 taskkill。
 */
export async function killOfficialProcesses(): Promise<boolean> {
  const officialBin = resolveOfficialBin();
  if (!officialBin) return false;
  if (process.platform === "darwin") {
    const appName = officialBin.includes(".app/")
      ? (officialBin.split(".app/")[0] ?? "").split("/").pop() || "ZCode"
      : "ZCode";
    const result = await runCommand("osascript", ["-e", `tell application "${appName}" to quit`]);
    const ok = result?.code === 0;
    writeState({ officialQuitAt: Date.now(), lastError: ok ? undefined : "osascript-quit-failed" });
    return ok;
  }
  if (process.platform === "win32") {
    const exeName = officialBin.split("\\").pop() ?? "zcode.exe";
    const result = await runCommand("taskkill", ["/F", "/T", "/IM", exeName], 15000);
    const ok = result?.code === 0;
    writeState({ officialQuitAt: Date.now(), lastError: ok ? undefined : "taskkill-failed" });
    return ok;
  }
  // linux
  // 候选集：pgrep -f 官方路径 ∪ pgrep -x ZCode；再按 /proc/<pid>/exe 符号链接
  // 精确等于官方 bin 才动手——pgrep -f 会命中「命令行里碰巧含该路径」的无关进程
  // （bash 包装、编辑器等，演练实证），exe 判定把它们全部排除。
  const pids = new Set<number>();
  const byPath = await runCommand("pgrep", ["-f", officialBin]);
  for (const line of (byPath?.stdout ?? "").split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  const byName = await runCommand("pgrep", ["-x", "ZCode"]);
  for (const line of (byName?.stdout ?? "").split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  const targets: number[] = [];
  for (const pid of pids) {
    if (isOwnTreePid(pid)) continue;
    let exe = "";
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      continue; // exe 不可读（已退出/权限）：宁可放过
    }
    if (exe === officialBin) targets.push(pid);
  }
  if (targets.length === 0) {
    writeState({ officialQuitAt: Date.now(), lastError: "official-process-not-found" });
    return false;
  }
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  let killed = 0;
  for (const pid of targets) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      killed += 1; // SIGTERM 已生效
    }
  }
  writeState({ officialQuitAt: Date.now(), officialQuitPids: targets.length });
  return killed > 0;
}

/** 接管完成：显示自己 + 退出原版（SHOW 信号触发；不再隐藏/气泡共存）。 */
export async function enterZCodeGo(): Promise<void> {
  if (!context || switching) return;
  switching = true;
  try {
    const main = context.getMainWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
    await killOfficialProcesses();
    context.logger.info("[zcode-go] enterZCodeGo 完成（原版已退出，zcode-go 独立运行）");
  } finally {
    switching = false;
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
    showWatcher?.close();
  });
  // 编排可能在 watcher 就绪前已触碰 SHOW
  if (existsSync(SHOW_FILE)) handleShowSignal();
  // 接管意图即启动即退官方：不依赖 hook 的 SHOW 定时器（hook 在 emit 结果后可能
  // 提前退出，定时器等不到——实测 SHOW 路径漏触发）。稍缓 800ms 让主窗先上屏。
  setTimeout(() => {
    if (!switching) void enterZCodeGo();
  }, 800);
  options.logger.info("[zcode-go] takeover 模式就绪", { pid: process.pid });
}
