/* oxlint-disable eslint(max-lines) -- zcode-go 机制/E2E/插件宿主文件：单文件收口是有意为之（同 SessionPane 惯例），拆散会破坏内聚。 */
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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// 官方把 hook 的任何 stderr 输出都按「Hook error」展示（用户会在每次
// /zcode-go 下方看到 ZCode 报错信息横幅）。本进程用 node:sqlite 清理空会话，
// 该实验性模块在加载时向 stderr 打 ExperimentalWarning——在本进程内吞掉
// process warning（hook 是秒级编排进程，警告无处可去只会变成噪音横幅）。
// 必须先于任何触发模块加载的调用执行（node:sqlite 是函数内按需加载）。
{
  const originalEmit = process.emit.bind(process);
  process.emit = ((name: unknown, warning: unknown, ...rest: unknown[]) => {
    if (name === "warning") return false;
    return originalEmit(name as never, warning as never, ...(rest as never[]));
  }) as typeof process.emit;
}

const STATE_DIR = join(homedir(), ".zcode-go");
const OFFICIAL_JSON = join(STATE_DIR, "official.json");
const CONFIG_JSON = join(STATE_DIR, "config.json");
const PID_FILE = join(STATE_DIR, "desktop.pid");
const SHOW_FILE = join(STATE_DIR, "SHOW");
const DISABLE_FILE = join(STATE_DIR, "DISABLE");
const SESSION_DB = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const TASKS_INDEX_DB = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");

/**
 * 清理 /zcode-go 空会话：提交动作先于 hook 把草稿会话持久化，continue:false 拦得住
 * 消息拦不住会话行——每次在全新聊天里输 /zcode-go 都留一个标题为 /zcode-go 的
 * 0 消息会话。判定即「message 计数 = 0」，直删 session/session_input/input_history
 * 三行（空会话无任何级联面）。限制（如实）：官方桌面只听自己 CLI 的通道，直删不会
 * 触发它的 session.removed——官方侧栏 ghost 与停留视图保留到官方重启。

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
    // 任务索引库才是侧栏列表的真数据源（~/.zcode/v2/tasks-index.sqlite）——只删
    // 会话库会在索引里留 ghost（实测「New session」残留）。同步删任务行。
    const tasksDb = new builtin.DatabaseSync(TASKS_INDEX_DB, { timeout: 5_000 });
    try {
      tasksDb.exec("begin immediate");
      try {
        tasksDb.prepare("delete from task_group_members where task_id = ?").run(sessionId);
        tasksDb.prepare("delete from tasks where task_id = ?").run(sessionId);
        tasksDb.exec("commit");
      } catch (transactionError) {
        try {
          tasksDb.exec("rollback");
        } catch {
          /* 尽力而为 */
        }
        throw transactionError;
      }
    } finally {
      tasksDb.close();
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

// ── /opc 只读命令：工作区公司状态摘要 ───────────────────────────────────
//
// 由插件 hook 直接读 <cwd>/.opc/company.json 并打印摘要，不消耗模型 token。
// 刻意只读：公司状态的唯一写路径在 ZCode Go 桌面 main（specs/opc-mode.md），
// hook 进程绝不做任何写入，避免双写者。

function runOpcCommand(argsText: string, cwd: string): void {
  const sub = argsText.trim().toLowerCase();
  const companyPath = join(cwd, ".opc", "company.json");
  if (sub === "help") {
    emit({
      continue: false,
      stopReason:
        `📊 /opc — OPC 公司状态摘要（只读）\n` +
        `用法：/opc [help]\n数据源：${companyPath}（工作区首次打开 OPC 面板时生成）`,
    });
    return;
  }
  let info: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(companyPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) info = parsed as Record<string, unknown>;
  } catch {
    /* 未初始化/不可读 */
  }
  const company = (info?.company ?? {}) as Record<string, unknown>;
  const employees = Array.isArray(info?.employees)
    ? (info!.employees as Array<Record<string, unknown>>)
    : [];
  const workItems = Array.isArray(info?.workItems)
    ? (info!.workItems as Array<Record<string, unknown>>)
    : [];
  const skills = Array.isArray(info?.skills) ? (info!.skills as unknown[]) : [];
  if (!info || !Array.isArray(info.employees)) {
    emit({
      continue: false,
      stopReason: `📊 当前目录未发现 OPC 公司：${companyPath}\n（在 ZCode Go 桌面打开 OPC 模式/面板即自动初始化）`,
    });
    return;
  }
  const statusOrder = ["backlog", "ready", "in_progress", "review", "done"] as const;
  const statusCounts = new Map<string, number>();
  for (const item of workItems) {
    const status = String(item.status ?? "backlog");
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const active = employees.filter((employee) => employee.status === "active");
  const escalations = workItems.filter((item) => item.escalatedAt);
  const evolution = Array.isArray(info.evolution)
    ? (info.evolution as Array<Record<string, unknown>>)
    : [];
  const lastEvent = evolution[evolution.length - 1];
  const lines = [
    `📊 OPC 公司：${String(company.name ?? "?")}`,
    `员工 ${active.length}/${employees.length} 人（在职/累计） · 技能 ${skills.length} 项`,
    `看板：${statusOrder.map((status) => `${status} ${statusCounts.get(status) ?? 0}`).join(" · ")}`,
  ];
  if (escalations.length > 0) {
    lines.push(`⬆ 待所有者处理 ${escalations.length} 项：`);
    for (const item of escalations.slice(0, 5)) {
      lines.push(`   - ${String(item.title ?? "?")}${item.escalationNote ? `（${String(item.escalationNote)}）` : ""}`);
    }
  }
  if (lastEvent && typeof lastEvent.summary === "string") {
    lines.push(`最近进化事件：${lastEvent.summary}`);
  }
  emit({ continue: false, stopReason: lines.join("\n") });
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
    // /opc 只读命令：原始斜杠输入与运行时展开包装两种到达形态（同 /zcode-go）
    const opcRaw = /^\/opc\b/.test(low);
    const opcExpanded = low.includes("run custom command /opc");
    if (opcRaw || opcExpanded) {
      const opcArgs =
        (opcExpanded
          ? (prompt.match(/[Rr]un custom command\s+\/opc\s+([^\n.]+)/)?.[1] ?? "")
          : (prompt.split(/\s+/)[1] ?? ""));
      runOpcCommand(opcArgs, String(event.cwd ?? process.cwd()));
      return;
    }
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
  // 模板包先行（镜像同步毫秒级；dev 惰性拉取为后台任务）——桌面起来后首次
  // 打开 OPC 面板即可用。绝不阻塞后续拉起流程（任何异常都已内部吞掉）。
  syncOpcPacks(false);
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
      process.exit(0);
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      log("等待 zcode-go 就绪超时（90s）");
      process.exit(0);
    }
  }, 1000);
  // 注意不要 unref：spawn 完成后事件循环为空，unref 的定时器永不触发，
  // 进程立即退出 → SHOW 信号从未写过（历史日志里所有「拉起」均无「就绪」
  // 的根因）。改由定时器分支显式退出，最长驻留 90s。
}

// ── OPC 模板包：镜像插件内置包 + dev 惰性拉取 ────────────────────────────
//
// 模板包（specs/opc-mode.md「模板包」节）的两条供给路径在本文件汇合：
//   1. url-zip 发行链：CI 把 packs 注入 plugin/opc-packs/ 随插件 zip 分发，
//      安装即有——接管/手动时镜像到 ~/.zcode-go/opc-packs（版本戳不同才替换）；
//   2. 本地开发（plugins.dirs 直挂仓库）：插件目录无 packs（已 gitignore），
//      回退为本仓库 scripts/opc/fetch-opc-packs.mjs 后台惰性拉取（fire-and-forget，
//      网络失败静默，不阻塞接管）。

const OPC_PACKS_DIR = join(STATE_DIR, "opc-packs");
const OPC_FETCH_SCRIPT = join("scripts", "opc", "fetch-opc-packs.mjs");

function pluginRoot(): string {
  return dirname(__dirname); // <plugin>/hooks → <plugin>
}

function readPackVersion(packDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed?.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

function repoRootGuess(): string | null {
  // dev 安装（plugins.dirs 直挂 <repo>/plugin）→ 仓库根可由 __dirname 回溯
  const candidate = resolve(pluginRoot(), "..");
  if (existsSync(join(candidate, OPC_FETCH_SCRIPT))) return candidate;
  // 市场安装副本：sync-plugin.mjs 写入的仓库路径标记（与 resolveLauncher 同源）
  for (const marker of [
    join(pluginRoot(), "zcode-go-home"),
    join(dirname(pluginRoot()), "scripts", "zcode-go-home"),
  ]) {
    try {
      const home = readFileSync(marker, "utf8").trim();
      if (home && existsSync(join(home, OPC_FETCH_SCRIPT))) return home;
    } catch {
      /* 下一候选 */
    }
  }
  return null;
}

function listPackDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && readPackVersion(join(root, entry.name)) !== null)
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

/** 插件内置包 → 用户缓存镜像。
 * 替换判据用 pack.json.fetchedAt（ISO 时间）而非版本戳：版本戳是 commit sha
 * 不可比较——静态分析发现的降级场景（本机残留的旧 CI 包覆盖用户更新鲜的
 * 缓存）必须按时间单调，旧包永不覆盖新缓存。 */
function mirrorPluginPacks(say: (message: string) => void): number {
  const sources = listPackDirs(join(pluginRoot(), "opc-packs"));
  let mirrored = 0;
  for (const source of sources) {
    const id = basename(source);
    const destination = join(OPC_PACKS_DIR, id);
    const sourceTime = readPackTime(source);
    const destinationTime = readPackTime(destination);
    // 目标已存在且不旧于来源 → 跳过（防降级）；缺时间戳的坏包按「需替换」处理
    if (
      destinationTime !== null &&
      sourceTime !== null &&
      destinationTime.getTime() >= sourceTime.getTime()
    ) {
      continue;
    }
    try {
      mkdirSync(OPC_PACKS_DIR, { recursive: true });
      rmSync(destination, { recursive: true, force: true });
      cpSync(source, destination, { recursive: true });
      mirrored += 1;
      say(`镜像模板包 ${id} → ${destination}`);
    } catch (error) {
      say(`镜像模板包 ${id} 失败: ${String(error)}`);
    }
  }
  return mirrored;
}

function readPackTime(packDir: string): Date | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8")) as {
      fetchedAt?: unknown;
    };
    if (typeof parsed?.fetchedAt !== "string") return null;
    const time = new Date(parsed.fetchedAt);
    return Number.isNaN(time.getTime()) ? null : time;
  } catch {
    return null;
  }
}

/** dev 惰性拉取：用户缓存无任何包且本机有仓库 → 后台跑 fetch 脚本（不等待）。 */
function lazyFetchPacks(say: (message: string) => void): boolean {
  if (listPackDirs(OPC_PACKS_DIR).length > 0) return false;
  const repo = repoRootGuess();
  if (!repo) return false;
  try {
    const script = join(repo, OPC_FETCH_SCRIPT);
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      cwd: repo,
      // 官方进程树带 ELECTRON_RUN_AS_NODE=1，恰好把官方 Electron 当 Node 执行本脚本
      env: { ...process.env },
    });
    child.unref();
    say(`后台惰性拉取模板包: ${script}`);
    return true;
  } catch (error) {
    say(`惰性拉取启动失败: ${String(error)}`);
    return false;
  }
}

function syncOpcPacks(verbose: boolean): void {
  const say = (message: string): void => {
    log(message);
    if (!verbose) return;
    // 手动管道（如 | head）关闭后写入会 EPIPE：命令本身已成功，静默退出而非崩溃
    try {
      process.stdout.write(`${message}\n`);
    } catch {
      /* 管道关闭 */
    }
  };
  const mirrored = mirrorPluginPacks(say);
  const fetched = lazyFetchPacks(say);
  const ready = listPackDirs(OPC_PACKS_DIR);
  say(
    `OPC 模板包：镜像 ${mirrored} 个${fetched ? "，已触发后台惰性拉取" : ""}；可用 ${ready.length} 个（${OPC_PACKS_DIR}）`,
  );
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
      `desktop.pid=${desktopRunning() ?? "-"}\n` +
      `opc-packs=${listPackDirs(OPC_PACKS_DIR).length}（${OPC_PACKS_DIR}）\n`,
  );
} else if (mode === "packs") {
  // 手动入口：node zcode-go.cjs packs——镜像插件内置包 / 触发 dev 惰性拉取
  syncOpcPacks(true);
} else {
  runHook();
}
