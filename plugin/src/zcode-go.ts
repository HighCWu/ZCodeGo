/**
 * zcode-go 插件单文件入口（编译为 hooks/zcode-go.cjs）。
 *
 * 由官方 Electron 以 ELECTRON_RUN_AS_NODE=1 执行（见 bootstrap.sh / bootstrap.ps1），
 * 用户机无需任何额外运行时。
 *
 * 子命令：
 *   hook      —— UserPromptSubmit hook 模式：stdin 读事件 JSON，拦截 /zcode-go 指令
 *   takeover  —— detached 编排模式：探活/拉起 ZCode Go 桌面 → 触碰 SHOW
 *   status    —— 打印官方安装探测与接管状态（排障用）
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const STATE_DIR = join(homedir(), ".zcode-go");
const OFFICIAL_JSON = join(STATE_DIR, "official.json");
const CONFIG_JSON = join(STATE_DIR, "config.json");
const PID_FILE = join(STATE_DIR, "desktop.pid");
const SHOW_FILE = join(STATE_DIR, "SHOW");
const DISABLE_FILE = join(STATE_DIR, "DISABLE");
const RETURN_WORKSPACE_FILE = join(STATE_DIR, "return-workspace");
const SESSION_DB = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

/**
 * 清理 /zcode-go 空会话：提交动作先于 hook 把草稿会话持久化，continue:false 拦得住
 * 消息拦不住会话行——每次在全新聊天里输 /zcode-go 都留一个标题为 /zcode-go 的
 * 0 消息会话。判定即「message 计数 = 0」，直删 session/session_input/input_history
 * 三行（空会话无任何级联面）。限制（如实）：官方桌面只听自己 CLI 的通道，直删不会
 * 触发它的 session.removed——官方侧栏 ghost 与停留视图保留到官方重启；已尽量以
 * return-workspace 深链让返回时导航到工作区而非停在已删会话。
 */
function deleteEmptyJunkSession(event: Record<string, unknown>): void {
  try {
    const sessionId = String(event.session_id ?? event.sessionId ?? "");
    if (!sessionId.startsWith("sess_")) return;
    const builtin = (
      process as unknown as { getBuiltinModule?: (id: string) => { DatabaseSync: new (path: string, options?: { timeout?: number }) => any } | undefined }
    ).getBuiltinModule?.("node:sqlite");
    if (!builtin) return;
    const db = new builtin.DatabaseSync(SESSION_DB, { timeout: 5_000 });
    try {
      const row = db.prepare("select count(*) as n from message where session_id = ?").get(sessionId) as
        | { n: number }
        | undefined;
      if (!row || row.n !== 0) return;
      db.exec("begin immediate");
      try {
        db.prepare("delete from input_history where session_id = ?").run(sessionId);
        db.prepare("delete from session_input where session_id = ?").run(sessionId);
        db.prepare("delete from session where id = ?").run(sessionId);
        db.exec("commit");
        log(`已清理 /zcode-go 空会话: ${sessionId}`);
      } catch (transactionError) {
        try {
          db.exec("rollback");
        } catch {
          /* 尽力而为 */
        }
        throw transactionError;
      }
    } finally {
      db.close();
    }
  } catch (error) {
    log(`清理空会话失败（放行）: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const PLUGIN_LOG = join(STATE_DIR, "plugin.log");

function log(message: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(PLUGIN_LOG, `${new Date().toISOString()} ${message}\n`, { flag: "a" });
  } catch {
    /* 排障日志尽力而为 */
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── 官方安装自主发现（祖先链回溯，跨平台；与 bootstrap 的启发式一致）──────

interface ProcInfo {
  pid: number;
  ppid: number;
  exe: string;
}

function procInfoLinux(pid: number): ProcInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(parts[1]);
    let exe = "";
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      try {
        exe = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
      } catch {
        /* keep empty */
      }
    }
    return Number.isFinite(ppid) ? { pid, ppid, exe } : null;
  } catch {
    return null;
  }
}

function procInfoPs(pid: number): ProcInfo | null {
  const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  if (ppid.status !== 0 || !ppid.stdout.trim()) return null;
  const exeProbe = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
  return { pid, ppid: Number(ppid.stdout.trim()), exe: exeProbe.stdout.trim() };
}

function procInfoWindows(pid: number): ProcInfo | null {
  const ppidOut = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`],
    { encoding: "utf8", timeout: 8000 },
  );
  const ppid = Number((ppidOut.stdout ?? "").trim());
  if (!Number.isFinite(ppid) || ppid <= 0) return null;
  const exeOut = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`],
    { encoding: "utf8", timeout: 8000 },
  );
  return { pid, ppid, exe: (exeOut.stdout ?? "").trim() };
}

function ancestors(): ProcInfo[] {
  const info =
    process.platform === "linux"
      ? procInfoLinux
      : process.platform === "darwin"
        ? procInfoPs
        : procInfoWindows;
  const result: ProcInfo[] = [];
  let pid = process.pid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 64 && pid > 0 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const item = info(pid);
    if (!item) break;
    result.push(item);
    pid = item.ppid;
  }
  return result;
}

function isOfficialExe(exe: string): boolean {
  if (!exe) return false;
  const name = exe.split(/[\\/]/).pop() ?? "";
  return /zcode/i.test(name) && !/zcode[-_]go/i.test(name);
}

function resourcesDirOf(binPath: string): string {
  const resolved = resolve(binPath);
  if (process.platform === "darwin" && resolved.includes(".app/Contents/MacOS")) {
    return join(resolved.slice(0, resolved.indexOf(".app") + 4), "Contents", "Resources");
  }
  return join(dirname(resolved), "resources");
}

export function discoverOfficial(): Record<string, unknown> | null {
  // 显式覆盖（测试注入 / 非标准安装位置）：ZCODE_GO_OFFICIAL_BIN
  const override = (process.env.ZCODE_GO_OFFICIAL_BIN ?? "").trim();
  if (override && existsSync(override)) {
    const resourcesDir = resourcesDirOf(override);
    const runtimeBundle = join(resourcesDir, "glm", "zcode.cjs");
    const info = {
      platform: process.platform,
      bin: resolve(override),
      resourcesDir,
      runtimeBundle: existsSync(runtimeBundle) ? runtimeBundle : null,
      discoveredAt: Date.now(),
      source: "env-override",
    };
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(OFFICIAL_JSON, JSON.stringify(info, null, 1), "utf8");
    } catch {
      /* 尽力而为 */
    }
    return info;
  }
  let best = "";
  for (const { exe } of ancestors()) {
    if (isOfficialExe(exe)) best = exe; // 取最上层（主进程）
  }
  if (!best) return null;
  const resourcesDir = resourcesDirOf(best);
  const runtimeBundle = join(resourcesDir, "glm", "zcode.cjs");
  const info = {
    platform: process.platform,
    bin: best,
    resourcesDir,
    runtimeBundle: existsSync(runtimeBundle) ? runtimeBundle : null,
    discoveredAt: Date.now(),
  };
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(OFFICIAL_JSON, JSON.stringify(info, null, 1), "utf8");
  } catch (error) {
    log(`写 official.json 失败: ${String(error)}`);
  }
  return info;
}

// ── hook 模式 ────────────────────────────────────────────────────────────

function emit(output: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(output));
}

function selfExecArgs(mode: string): { command: string; args: string[] } {
  // 当前进程即官方二进制（RunAsNode）——detached 子进程复用它，无需任何解释器
  return { command: process.execPath, args: [__filename, mode] };
}

function runHook(): void {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 1 << 20) process.stdin.destroy();
  });
  process.stdin.on("end", () => {
    let event: Record<string, unknown> = {};
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // 非法输入：静默放行
    }
    const prompt = String(event.prompt ?? "").trim();
    const low = prompt.toLowerCase();
    // 两种到达形态：
    //   原始斜杠输入（桌面提交）："/zcode-go [status|off|on]"
    //   运行时命令展开包装（协议路径先把自定义命令展开再进 hook）：
    //     "Run custom command /zcode-go[ args].\nCommand source: user/plugin.\n…" + 命令正文
    const rawForm = /^\/zcode[_-]go\b/.test(low);
    const expanded = low.includes("run custom command /zcode-go");
    if (!rawForm && !expanded) return; // 放行

    let sub = "";
    if (rawForm) {
      sub = (prompt.split(/\s+/)[1] ?? "").toLowerCase();
    } else {
      const m = prompt.match(/[Rr]un custom command\s+\/zcode[_-]go\s+([^\n.]+)/);
      if (m) sub = m[1].trim().toLowerCase();
    }
    const info = (discoverOfficial() ?? readJson(OFFICIAL_JSON) ?? {}) as Record<string, unknown>;

    if (sub === "status") {
      emit({
        continue: false,
        stopReason:
          `📊 zcode-go 接管状态\n` +
          `官方 bin：${info.bin ?? "未探测到（在官方会话内重试本命令）"}\n` +
          `官方运行时：${info.runtimeBundle ?? "未找到（请确认官方安装完整）"}\n` +
          `接管开关：${existsSync(DISABLE_FILE) ? "已停用（~/.zcode-go/DISABLE）" : "启用"}`,
      });
      return;
    }
    if (sub === "off") {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(DISABLE_FILE, "", "utf8");
      emit({ continue: false, stopReason: "⏹ zcode-go 接管已停用（/zcode-go on 重新启用）" });
      return;
    }
    if (sub === "on") {
      try {
        unlinkSync(DISABLE_FILE);
      } catch {
        /* 不存在即已启用 */
      }
      emit({ continue: false, stopReason: "▶️ zcode-go 接管已启用（/zcode-go 切换桌面）" });
      return;
    }
    if (existsSync(DISABLE_FILE)) {
      emit({ continue: false, stopReason: "⏸ zcode-go 接管已停用；发送 /zcode-go on 启用。" });
      return;
    }
    const { command, args } = selfExecArgs("takeover");
    deleteEmptyJunkSession(event);
    const workspacePath = String(event.cwd ?? "").trim();
    try {
      if (workspacePath) writeFileSync(RETURN_WORKSPACE_FILE, workspacePath, "utf8");
    } catch {
      /* 尽力而为 */
    }
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        cwd: homedir(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      child.unref();
      emit({
        continue: false,
        stopReason:
          "✅ 正在切换到 ZCode Go 桌面…（zcode-go 就绪后原版 zcode 将自动退出；" +
          "磁盘上的会话与官方安装完全共享，重开官方即回到官方）",
      });
    } catch (error) {
      log(`拉起编排失败: ${String(error)}`);
      emit({ continue: false, stopReason: "❌ 切换编排拉起失败，详见 ~/.zcode-go/plugin.log" });
    }
  });
}

// ── takeover 编排模式 ────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function desktopRunning(): number | null {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isFinite(pid) && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function resolveLauncher(): string | null {
  const config = readJson(CONFIG_JSON);
  const fromConfig = String(config?.zcodeGoLauncher ?? "").trim();
  if (fromConfig && existsSync(fromConfig)) return fromConfig;
  // 仓库开发/CI 布局：<repo>/plugin/hooks → <repo>/scripts/launch-zcode-go.sh
  // （市场安装副本无此兄弟目录，自然落到下方 marker/配置）
  for (const candidate of [
    join(__dirname, "..", "..", "scripts", "launch-zcode-go.sh"),
    join(__dirname, "zcode-go-home"),
  ]) {
    try {
      if (candidate.endsWith("launch-zcode-go.sh")) {
        if (existsSync(candidate)) return candidate;
        continue;
      }
    } catch {
      /* 下一候选 */
    }
  }
  // 插件携带的仓库路径标记（sync-plugin.mjs 写入）
  for (const marker of [
    join(__dirname, "zcode-go-home"),
    join(dirname(__dirname), "scripts", "zcode-go-home"),
  ]) {
    try {
      const home = readFileSync(marker, "utf8").trim();
      const candidate = join(home, "scripts", "launch-zcode-go.sh");
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 下一候选 */
    }
  }
  return null;
}

function runTakeover(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const running = desktopRunning();
  if (running) {
    writeFileSync(SHOW_FILE, "", "utf8");
    log(`zcode-go 已运行(pid=${running}) → SHOW`);
    return;
  }
  const launcher = resolveLauncher();
  if (!launcher) {
    log("未找到 zcode-go 启动器：请在 ~/.zcode-go/config.json 设 zcodeGoLauncher，或重跑 scripts/sync-plugin.mjs");
    return;
  }
  try {
    // Windows 无法直接 exec .sh（spawn EFTYPE），须经 bash（hooks.json 的
    // sh 同源——Git bash 在 PATH 上）
    const isWin = process.platform === "win32";
    // 官方进程树 env 带 ELECTRON_RUN_AS_NODE=1（官方 runtime 即官方 Electron 的
    // run-as-node 形态）——启动器内的官方 Electron 二进制不能带着它启动，否则被
    // 当纯 Node 执行，死于 "bad option: --no-sandbox"（launcher 内亦同源 unset 兜底）。
    const desktopEnv = (() => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      return env;
    })();
    const child = isWin
      ? spawn(process.env.SHELL?.trim() || "bash", [launcher], {
          detached: true,
          stdio: "ignore",
          cwd: homedir(),
          shell: false,
          env: desktopEnv,
        })
      : spawn(launcher, [], {
          detached: true,
          stdio: "ignore",
          cwd: homedir(),
          shell: false,
          env: desktopEnv,
        });
    child.unref();
    log(`拉起 zcode-go：${launcher}`);
  } catch (error) {
    log(`启动器执行失败: ${String(error)}`);
    return;
  }
  const deadline = Date.now() + 90_000;
  const timer = setInterval(() => {
    const pid = desktopRunning();
    if (pid) {
      clearInterval(timer);
      writeFileSync(SHOW_FILE, "", "utf8");
      log(`zcode-go 就绪(pid=${pid}) → SHOW`);
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      log("等待 zcode-go 就绪超时（90s）");
    }
  }, 1000);
  // 不因定时器滞留进程
  if (typeof timer.unref === "function") timer.unref();
}

// ── 入口 ────────────────────────────────────────────────────────────────

const mode = process.argv[2] ?? "hook";
if (mode === "takeover") {
  runTakeover();
} else if (mode === "status") {
  const info = (discoverOfficial() ?? readJson(OFFICIAL_JSON) ?? {}) as Record<string, unknown>;
  process.stdout.write(
    `bin=${info.bin ?? "?"}\nruntimeBundle=${info.runtimeBundle ?? "?"}\n` +
      `takeover=${existsSync(DISABLE_FILE) ? "disabled" : "enabled"}\n` +
      `desktop.pid=${desktopRunning() ?? "-"}\n`,
  );
} else {
  runHook();
}
