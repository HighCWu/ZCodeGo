var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugin/src/zcode-go.ts
var zcode_go_exports = {};
__export(zcode_go_exports, {
  discoverOfficial: () => discoverOfficial
});
module.exports = __toCommonJS(zcode_go_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
{
  const originalEmit = process.emit.bind(process);
  process.emit = ((name, warning, ...rest) => {
    if (name === "warning") return false;
    return originalEmit(name, warning, ...rest);
  });
}
var STATE_DIR = (0, import_node_path.join)((0, import_node_os.homedir)(), ".zcode-go");
var OFFICIAL_JSON = (0, import_node_path.join)(STATE_DIR, "official.json");
var CONFIG_JSON = (0, import_node_path.join)(STATE_DIR, "config.json");
var PID_FILE = (0, import_node_path.join)(STATE_DIR, "desktop.pid");
var SHOW_FILE = (0, import_node_path.join)(STATE_DIR, "SHOW");
var DISABLE_FILE = (0, import_node_path.join)(STATE_DIR, "DISABLE");
var SESSION_DB = (0, import_node_path.join)((0, import_node_os.homedir)(), ".zcode", "cli", "db", "db.sqlite");
var TASKS_INDEX_DB = (0, import_node_path.join)((0, import_node_os.homedir)(), ".zcode", "v2", "tasks-index.sqlite");
function deleteEmptyJunkSession(event) {
  try {
    const sessionId = String(event.session_id ?? event.sessionId ?? "");
    if (!sessionId.startsWith("sess_")) return;
    const builtin = process.getBuiltinModule?.("node:sqlite");
    if (!builtin) return;
    const db = new builtin.DatabaseSync(SESSION_DB, { timeout: 5e3 });
    try {
      const row = db.prepare("select count(*) as n from message where session_id = ?").get(sessionId);
      if (!row || row.n !== 0) return;
      db.exec("begin immediate");
      try {
        db.prepare("delete from input_history where session_id = ?").run(sessionId);
        db.prepare("delete from session_input where session_id = ?").run(sessionId);
        db.prepare("delete from session where id = ?").run(sessionId);
        db.exec("commit");
        log(`\u5DF2\u6E05\u7406 /zcode-go \u7A7A\u4F1A\u8BDD: ${sessionId}`);
      } catch (transactionError) {
        try {
          db.exec("rollback");
        } catch {
        }
        throw transactionError;
      }
    } finally {
      db.close();
    }
    const tasksDb = new builtin.DatabaseSync(TASKS_INDEX_DB, { timeout: 5e3 });
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
        }
        throw transactionError;
      }
    } finally {
      tasksDb.close();
    }
  } catch (error) {
    log(`\u6E05\u7406\u7A7A\u4F1A\u8BDD\u5931\u8D25\uFF08\u653E\u884C\uFF09: ${error instanceof Error ? error.message : String(error)}`);
  }
}
var PLUGIN_LOG = (0, import_node_path.join)(STATE_DIR, "plugin.log");
function log(message) {
  try {
    (0, import_node_fs.mkdirSync)(STATE_DIR, { recursive: true });
    (0, import_node_fs.writeFileSync)(PLUGIN_LOG, `${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`, { flag: "a" });
  } catch {
  }
}
function readJson(path) {
  try {
    const parsed = JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
function procInfoLinux(pid) {
  try {
    const stat = (0, import_node_fs.readFileSync)(`/proc/${pid}/stat`, "utf8");
    const parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(parts[1]);
    let exe = "";
    try {
      exe = (0, import_node_fs.readlinkSync)(`/proc/${pid}/exe`);
    } catch {
      try {
        exe = (0, import_node_fs.readFileSync)(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
      } catch {
      }
    }
    return Number.isFinite(ppid) ? { pid, ppid, exe } : null;
  } catch {
    return null;
  }
}
function procInfoPs(pid) {
  const ppid = (0, import_node_child_process.spawnSync)("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  if (ppid.status !== 0 || !ppid.stdout.trim()) return null;
  const exeProbe = (0, import_node_child_process.spawnSync)("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
  return { pid, ppid: Number(ppid.stdout.trim()), exe: exeProbe.stdout.trim() };
}
function procInfoWindows(pid) {
  const ppidOut = (0, import_node_child_process.spawnSync)(
    "powershell",
    ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`],
    { encoding: "utf8", timeout: 8e3 }
  );
  const ppid = Number((ppidOut.stdout ?? "").trim());
  if (!Number.isFinite(ppid) || ppid <= 0) return null;
  const exeOut = (0, import_node_child_process.spawnSync)(
    "powershell",
    ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`],
    { encoding: "utf8", timeout: 8e3 }
  );
  return { pid, ppid, exe: (exeOut.stdout ?? "").trim() };
}
function ancestors() {
  const info = process.platform === "linux" ? procInfoLinux : process.platform === "darwin" ? procInfoPs : procInfoWindows;
  const result = [];
  let pid = process.pid;
  const seen = /* @__PURE__ */ new Set();
  for (let depth = 0; depth < 64 && pid > 0 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const item = info(pid);
    if (!item) break;
    result.push(item);
    pid = item.ppid;
  }
  return result;
}
function isOfficialExe(exe) {
  if (!exe) return false;
  const name = exe.split(/[\\/]/).pop() ?? "";
  return /zcode/i.test(name) && !/zcode[-_]go/i.test(name);
}
function resourcesDirOf(binPath) {
  const resolved = (0, import_node_path.resolve)(binPath);
  if (process.platform === "darwin" && resolved.includes(".app/Contents/MacOS")) {
    return (0, import_node_path.join)(resolved.slice(0, resolved.indexOf(".app") + 4), "Contents", "Resources");
  }
  return (0, import_node_path.join)((0, import_node_path.dirname)(resolved), "resources");
}
function discoverOfficial() {
  const override = (process.env.ZCODE_GO_OFFICIAL_BIN ?? "").trim();
  if (override && (0, import_node_fs.existsSync)(override)) {
    const resourcesDir2 = resourcesDirOf(override);
    const runtimeBundle2 = (0, import_node_path.join)(resourcesDir2, "glm", "zcode.cjs");
    const info2 = {
      platform: process.platform,
      bin: (0, import_node_path.resolve)(override),
      resourcesDir: resourcesDir2,
      runtimeBundle: (0, import_node_fs.existsSync)(runtimeBundle2) ? runtimeBundle2 : null,
      discoveredAt: Date.now(),
      source: "env-override"
    };
    try {
      (0, import_node_fs.mkdirSync)(STATE_DIR, { recursive: true });
      (0, import_node_fs.writeFileSync)(OFFICIAL_JSON, JSON.stringify(info2, null, 1), "utf8");
    } catch {
    }
    return info2;
  }
  let best = "";
  for (const { exe } of ancestors()) {
    if (isOfficialExe(exe)) best = exe;
  }
  if (!best) return null;
  const resourcesDir = resourcesDirOf(best);
  const runtimeBundle = (0, import_node_path.join)(resourcesDir, "glm", "zcode.cjs");
  const info = {
    platform: process.platform,
    bin: best,
    resourcesDir,
    runtimeBundle: (0, import_node_fs.existsSync)(runtimeBundle) ? runtimeBundle : null,
    discoveredAt: Date.now()
  };
  try {
    (0, import_node_fs.mkdirSync)(STATE_DIR, { recursive: true });
    (0, import_node_fs.writeFileSync)(OFFICIAL_JSON, JSON.stringify(info, null, 1), "utf8");
  } catch (error) {
    log(`\u5199 official.json \u5931\u8D25: ${String(error)}`);
  }
  return info;
}
function emit(output) {
  process.stdout.write(JSON.stringify(output));
}
function selfExecArgs(mode2) {
  return { command: process.execPath, args: [__filename, mode2] };
}
function runHook() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 1 << 20) process.stdin.destroy();
  });
  process.stdin.on("end", () => {
    let event = {};
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const prompt = String(event.prompt ?? "").trim();
    const low = prompt.toLowerCase();
    const rawForm = /^\/zcode[_-]go\b/.test(low);
    const expanded = low.includes("run custom command /zcode-go");
    if (!rawForm && !expanded) return;
    let sub = "";
    if (rawForm) {
      sub = (prompt.split(/\s+/)[1] ?? "").toLowerCase();
    } else {
      const m = prompt.match(/[Rr]un custom command\s+\/zcode[_-]go\s+([^\n.]+)/);
      if (m) sub = m[1].trim().toLowerCase();
    }
    const info = discoverOfficial() ?? readJson(OFFICIAL_JSON) ?? {};
    if (sub === "status") {
      emit({
        continue: false,
        stopReason: `\u{1F4CA} zcode-go \u63A5\u7BA1\u72B6\u6001
\u5B98\u65B9 bin\uFF1A${info.bin ?? "\u672A\u63A2\u6D4B\u5230\uFF08\u5728\u5B98\u65B9\u4F1A\u8BDD\u5185\u91CD\u8BD5\u672C\u547D\u4EE4\uFF09"}
\u5B98\u65B9\u8FD0\u884C\u65F6\uFF1A${info.runtimeBundle ?? "\u672A\u627E\u5230\uFF08\u8BF7\u786E\u8BA4\u5B98\u65B9\u5B89\u88C5\u5B8C\u6574\uFF09"}
\u63A5\u7BA1\u5F00\u5173\uFF1A${(0, import_node_fs.existsSync)(DISABLE_FILE) ? "\u5DF2\u505C\u7528\uFF08~/.zcode-go/DISABLE\uFF09" : "\u542F\u7528"}`
      });
      return;
    }
    if (sub === "off") {
      (0, import_node_fs.mkdirSync)(STATE_DIR, { recursive: true });
      (0, import_node_fs.writeFileSync)(DISABLE_FILE, "", "utf8");
      emit({ continue: false, stopReason: "\u23F9 zcode-go \u63A5\u7BA1\u5DF2\u505C\u7528\uFF08/zcode-go on \u91CD\u65B0\u542F\u7528\uFF09" });
      return;
    }
    if (sub === "on") {
      try {
        (0, import_node_fs.unlinkSync)(DISABLE_FILE);
      } catch {
      }
      emit({ continue: false, stopReason: "\u25B6\uFE0F zcode-go \u63A5\u7BA1\u5DF2\u542F\u7528\uFF08/zcode-go \u5207\u6362\u684C\u9762\uFF09" });
      return;
    }
    if ((0, import_node_fs.existsSync)(DISABLE_FILE)) {
      emit({ continue: false, stopReason: "\u23F8 zcode-go \u63A5\u7BA1\u5DF2\u505C\u7528\uFF1B\u53D1\u9001 /zcode-go on \u542F\u7528\u3002" });
      return;
    }
    const { command, args } = selfExecArgs("takeover");
    deleteEmptyJunkSession(event);
    try {
      const child = (0, import_node_child_process.spawn)(command, args, {
        detached: true,
        stdio: "ignore",
        cwd: (0, import_node_os.homedir)(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      });
      child.unref();
      emit({
        continue: false,
        stopReason: "\u2705 \u6B63\u5728\u5207\u6362\u5230 ZCode Go \u684C\u9762\u2026\uFF08zcode-go \u5C31\u7EEA\u540E\u539F\u7248 zcode \u5C06\u81EA\u52A8\u9000\u51FA\uFF1B\u78C1\u76D8\u4E0A\u7684\u4F1A\u8BDD\u4E0E\u5B98\u65B9\u5B89\u88C5\u5B8C\u5168\u5171\u4EAB\uFF0C\u91CD\u5F00\u5B98\u65B9\u5373\u56DE\u5230\u5B98\u65B9\uFF09"
      });
    } catch (error) {
      log(`\u62C9\u8D77\u7F16\u6392\u5931\u8D25: ${String(error)}`);
      emit({ continue: false, stopReason: "\u274C \u5207\u6362\u7F16\u6392\u62C9\u8D77\u5931\u8D25\uFF0C\u8BE6\u89C1 ~/.zcode-go/plugin.log" });
    }
  });
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function desktopRunning() {
  try {
    const pid = Number((0, import_node_fs.readFileSync)(PID_FILE, "utf8").trim());
    return Number.isFinite(pid) && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}
function resolveLauncher() {
  const config = readJson(CONFIG_JSON);
  const fromConfig = String(config?.zcodeGoLauncher ?? "").trim();
  if (fromConfig && (0, import_node_fs.existsSync)(fromConfig)) return fromConfig;
  for (const candidate of [
    (0, import_node_path.join)(__dirname, "..", "..", "scripts", "launch-zcode-go.sh"),
    (0, import_node_path.join)(__dirname, "zcode-go-home")
  ]) {
    try {
      if (candidate.endsWith("launch-zcode-go.sh")) {
        if ((0, import_node_fs.existsSync)(candidate)) return candidate;
        continue;
      }
    } catch {
    }
  }
  for (const marker of [
    (0, import_node_path.join)(__dirname, "zcode-go-home"),
    (0, import_node_path.join)((0, import_node_path.dirname)(__dirname), "scripts", "zcode-go-home")
  ]) {
    try {
      const home = (0, import_node_fs.readFileSync)(marker, "utf8").trim();
      const candidate = (0, import_node_path.join)(home, "scripts", "launch-zcode-go.sh");
      if ((0, import_node_fs.existsSync)(candidate)) return candidate;
    } catch {
    }
  }
  return null;
}
function runTakeover() {
  (0, import_node_fs.mkdirSync)(STATE_DIR, { recursive: true });
  const running = desktopRunning();
  if (running) {
    (0, import_node_fs.writeFileSync)(SHOW_FILE, "", "utf8");
    log(`zcode-go \u5DF2\u8FD0\u884C(pid=${running}) \u2192 SHOW`);
    return;
  }
  const launcher = resolveLauncher();
  if (!launcher) {
    log("\u672A\u627E\u5230 zcode-go \u542F\u52A8\u5668\uFF1A\u8BF7\u5728 ~/.zcode-go/config.json \u8BBE zcodeGoLauncher\uFF0C\u6216\u91CD\u8DD1 scripts/sync-plugin.mjs");
    return;
  }
  try {
    const isWin = process.platform === "win32";
    const desktopEnv = (() => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      return env;
    })();
    const child = isWin ? (0, import_node_child_process.spawn)(process.env.SHELL?.trim() || "bash", [launcher], {
      detached: true,
      stdio: "ignore",
      cwd: (0, import_node_os.homedir)(),
      shell: false,
      env: desktopEnv
    }) : (0, import_node_child_process.spawn)(launcher, [], {
      detached: true,
      stdio: "ignore",
      cwd: (0, import_node_os.homedir)(),
      shell: false,
      env: desktopEnv
    });
    child.unref();
    log(`\u62C9\u8D77 zcode-go\uFF1A${launcher}`);
  } catch (error) {
    log(`\u542F\u52A8\u5668\u6267\u884C\u5931\u8D25: ${String(error)}`);
    return;
  }
  const deadline = Date.now() + 9e4;
  const timer = setInterval(() => {
    const pid = desktopRunning();
    if (pid) {
      clearInterval(timer);
      (0, import_node_fs.writeFileSync)(SHOW_FILE, "", "utf8");
      log(`zcode-go \u5C31\u7EEA(pid=${pid}) \u2192 SHOW`);
      process.exit(0);
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      log("\u7B49\u5F85 zcode-go \u5C31\u7EEA\u8D85\u65F6\uFF0890s\uFF09");
      process.exit(0);
    }
  }, 1e3);
}
var mode = process.argv[2] ?? "hook";
if (mode === "takeover") {
  runTakeover();
} else if (mode === "status") {
  const info = discoverOfficial() ?? readJson(OFFICIAL_JSON) ?? {};
  process.stdout.write(
    `bin=${info.bin ?? "?"}
runtimeBundle=${info.runtimeBundle ?? "?"}
takeover=${(0, import_node_fs.existsSync)(DISABLE_FILE) ? "disabled" : "enabled"}
desktop.pid=${desktopRunning() ?? "-"}
`
  );
} else {
  runHook();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  discoverOfficial
});
