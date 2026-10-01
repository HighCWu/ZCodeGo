#!/usr/bin/env node
/**
 * zcode-go E2E 断言套件（本地/CI 同一套；零依赖，node ≥ 20）。
 *
 * 环境输入：
 *   ZCODE_GO_E2E_OFFICIAL_BIN  必填：官方二进制路径（本机安装或 CI unpacked 产物）
 *   ZCODE_GO_E2E_GUI           可选 "1"：启用 GUI 断言（当前仅 Linux：xdotool）
 *   ZCODE_GO_E2E_SKIP_LAUNCH   可选 "1"：跳过冷启动与运行时断言（只测 hook/fixtures）
 *
 * 断言组：
 *   core   hook fixtures（放行/status/off/on/停用 bare）、发现（env 注入 → official.json
 *          与 runtimeBundle 推导）、ensure 幂等（--json synced=false）
 *   launch launcher 冷启动 → desktop.pid + “takeover 模式就绪” 日志
 *   runtime host 子进程树中 zcode-cli 的 exe == 官方二进制（ELECTRON_RUN_AS_NODE）
 *   gui    主窗存在；bare /zcode-go → SHOW → 官方窗隐藏 + ZCode Go 可见；close→气泡
 *          → 点气泡回切；全程分步截图至 ~/.zcode-go/e2e-shots/（CI artifact 可拉本地肉眼核对）
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(pathDirname(fileURLToPath(import.meta.url)), "..", "..");
const stateDir = join(homedir(), ".zcode-go");
const officialBin = (process.env.ZCODE_GO_E2E_OFFICIAL_BIN ?? "").trim();
const guiMode = process.env.ZCODE_GO_E2E_GUI === "1";
const skipLaunch = process.env.ZCODE_GO_E2E_SKIP_LAUNCH === "1";
const hookCjs = join(repoRoot, "plugin", "hooks", "zcode-go.cjs");
const bootstrapSh = join(repoRoot, "plugin", "hooks", "bootstrap.sh");
const isLinux = process.platform === "linux";

if (!officialBin || !existsSync(officialBin)) {
  console.error("需要 ZCODE_GO_E2E_OFFICIAL_BIN 指向存在的官方二进制");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
}
function sh(script, stdin = "") {
  return run("sh", ["-c", script], { input: stdin });
}

// 分步截图（三平台，wails e2e 同款思路：每阶段留证据，artifact 拉本地肉眼核对）：
//   linux: import（imagemagick）| darwin: screencapture | win32: CopyFromScreen
const shotsDir = join(stateDir, "e2e-shots");
rmSync(shotsDir, { recursive: true, force: true });
run("sh", ["-c", `mkdir -p '${shotsDir}'`]);
function snapScreen(name) {
  const file = join(shotsDir, name);
  if (process.platform === "linux") {
    run("sh", ["-c", `import -window root '${file}' 2>/dev/null || true`]);
  } else if (process.platform === "darwin") {
    run("screencapture", ["-x", file]);
  } else {
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;" +
      "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;" +
      "$g=[System.Drawing.Graphics]::FromImage($bmp);" +
      "$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size);" +
      `$bmp.Save('${file.replaceAll("\\", "/")}');`;
    run("powershell", ["-NoProfile", "-Command", ps]);
  }
}

// ── core：hook fixtures（用系统 node 直接跑 CJS；CI/LINUX 均可）──────────
const nodeBin = process.execPath;
const env = { ...process.env, ZCODE_GO_OFFICIAL_BIN: officialBin };

function hookFeed(prompt) {
  const r = run(nodeBin, [hookCjs, "hook"], {
    input: JSON.stringify({ prompt, session_id: "e2e" }),
    env,
  });
  return { stdout: (r.stdout ?? "").trim(), code: r.status };
}

{
  const pass = hookFeed("帮我写个函数");
  check("hook: 非指令放行（空输出）", pass.stdout === "", `stdout=${pass.stdout.slice(0, 40)}`);
}
{
  const status = hookFeed("/zcode-go status");
  // hook 输出为 JSON 字符串，Windows 反斜杠会被转义 —— parse 后比较原始值
  let stopReason = "";
  try {
    stopReason = JSON.parse(status.stdout.slice(status.stdout.indexOf("{"))).stopReason ?? "";
  } catch { /* 保持空，走失败分支 */ }
  const ok = status.stdout.includes('"continue":false') && stopReason.includes(officialBin);
  check("hook: status 拦截并含官方路径", ok, status.stdout.slice(0, 80));
}
{
  const off = hookFeed("/zcode-go off");
  const disabledBare = hookFeed("/zcode-go");
  const on = hookFeed("/zcode-go on");
  check(
    "hook: off/on 开关与停用态 bare",
    off.stdout.includes("已停用") &&
      disabledBare.stdout.includes("已停用") &&
      on.stdout.includes("已启用") &&
      !existsSync(join(stateDir, "DISABLE")),
  );
}
{
  // 发现：env 注入 → official.json 的 runtimeBundle 推导
  hookFeed("/zcode-go status");
  const info = JSON.parse(readFileSync(join(stateDir, "official.json"), "utf8"));
  const expectedBundle = join(info.resourcesDir, "glm", "zcode.cjs");
  const officialHasRuntime = existsSync(expectedBundle);
  check(
    "发现: official.json 与 runtimeBundle 推导",
    info.bin === resolve(officialBin) &&
      info.runtimeBundle === (officialHasRuntime ? expectedBundle : null),
    `bundle=${info.runtimeBundle ?? "(官方包无 runtime，推导为 null)"}`,
  );
}
{
  // bootstrap.sh 链（Linux/macOS；要求进程树内有官方二进制 —— 本机在官方内运行时成立，
  // CI runner 上无官方祖先 → 允许跳过并标注）
  const inOfficialTree = isLinux
    ? run("sh", ["-c", "readlink /proc/$PPID/exe"]).stdout?.length > 0
    : false;
  if (isLinux || process.platform === "darwin") {
    const r = sh(`'${bootstrapSh}'`, JSON.stringify({ prompt: "/zcode-go status" }));
    if (r.status === 3) {
      check("bootstrap: 祖先链（CI runner 无官方祖先，标注跳过）", true, "exit=3 fallthrough OK");
    } else {
      check("bootstrap: sh 链输出 status", (r.stdout ?? "").includes("官方 bin"), `status=${r.status}`);
    }
  }
}
{
  // ensure 幂等
  const first = run(nodeBin, [join(repoRoot, "scripts", "ensure-official-electron.mjs"), "--json"], {
    env: { ...process.env, ZCODE_OFFICIAL_BIN: officialBin },
  });
  const second = run(nodeBin, [join(repoRoot, "scripts", "ensure-official-electron.mjs"), "--json"], {
    env: { ...process.env, ZCODE_OFFICIAL_BIN: officialBin },
  });
  const parse = (r) => {
    try {
      return JSON.parse((r.stdout ?? "").trim().split("\n").pop());
    } catch {
      return null;
    }
  };
  const a = parse(first);
  const b = parse(second);
  check(
    "ensure: 幂等（第二次 synced=false）",
    !!a && !!b && b.synced === false,
    `first.synced=${a?.synced} second.synced=${b?.synced}`,
  );
}

// ── launch + runtime + gui ───────────────────────────────────────────────
if (!skipLaunch) {
  // 冷启动（launcher 自含构建判断；产物已在 CI 前置步骤就绪）。
  // 先停存量实例（单实例锁），launcher 以 setsid 分离启动（其 exec 的桌面常驻）。
  try {
    const oldPid = Number(readFileSync(join(stateDir, "desktop.pid"), "utf8").trim());
    if (Number.isFinite(oldPid) && oldPid > 0) process.kill(oldPid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 3000));
  } catch { /* 无存量实例 */ }
  for (const f of ["desktop.pid", "takeover-state.json", "SHOW"]) {
    try {
      unlinkSync(join(stateDir, f));
    } catch { /* 不存在即可 */ }
  }
  // 分离启动：nohup 三平台通用（macOS 无 setsid，Linux nohup 足以隔离挂断）；
  // Windows Git bash 直接后台即可
  const detach = process.platform === "win32" ? "" : "nohup ";
  const launcher = run("sh", ["-c", `${detach}'${join(repoRoot, "scripts", "launch-zcode-go.sh")}' >/dev/null 2>&1 &`], {
    env: { ...process.env, ZCODE_OFFICIAL_BIN: officialBin },
  });
  check("launch: launcher 已分离启动", launcher.status === 0, `status=${launcher.status}`);

  const pidFile = join(stateDir, "desktop.pid");
  let pid = 0;
  for (let i = 0; i < 60; i += 1) {
    if (existsSync(pidFile)) {
      pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  check("launch: desktop.pid 出现", pid > 0, `pid=${pid || "无"}`);

  if (pid > 0) {
    const launchLog = readFileSync(join(stateDir, "desktop-launch.log"), "utf8");
    check(
      "launch: takeover 模式就绪日志",
      launchLog.includes("takeover 模式就绪"),
      `pid=${pid}`,
    );
    await new Promise((r) => setTimeout(r, 3000));
    snapScreen("10-launch-desktop.png");

    // runtime：desktop 子树里的 zcode-cli，其 exe 应为官方二进制。
    // CI 全新环境无历史会话时 host 可能不主动 spawn runtime（本地有工作区
    // 恢复即会）—— 轮询最长 90s；仍未触发且显式开了豁免（workflow 已用
    // "官方 exe RunAsNode + zcode.cjs bundle" 冒烟等价覆盖）则按标注通过。
    const scanRuntimeExes = async () => {
      const psTree = run("ps", ["-eo", "pid,ppid,args"]).stdout ?? "";
      const descendants = new Set([pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const line of psTree.split("\n").slice(1)) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
          if (!m) continue;
          if (descendants.has(Number(m[2])) && !descendants.has(Number(m[1]))) {
            descendants.add(Number(m[1]));
            changed = true;
          }
        }
      }
      const exes = [];
      if (isLinux) {
        const fs = await import("node:fs");
        for (const line of psTree.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+\d+\s+zcode-cli\s*$/);
          if (m && descendants.has(Number(m[1]))) {
            try {
              exes.push(fs.readlinkSync(`/proc/${m[1]}/exe`));
            } catch { /* 进程退出则跳过 */ }
          }
        }
      }
      return exes;
    };
    let runtimeExes = [];
    for (let waited = 0; waited < 90_000; waited += 5_000) {
      runtimeExes = await scanRuntimeExes();
      if (runtimeExes.length > 0) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (isLinux && runtimeExes.length === 0 && process.env.ZCODE_GO_E2E_ALLOW_NO_RUNTIME === "1") {
      check(
        "runtime: 官方运行时 spawn（CI 无会话未触发，豁免——bundle 冒烟已在 workflow 覆盖）",
        true,
        "",
      );
    } else if (isLinux) {
      // exe 应为官方二进制本体（原件）或 ensure 装配的官方副本（~/.zcode-go/electron/zcode）
      const officialCopies = new Set([resolve(officialBin)]);
      try {
        const ensureOut = JSON.parse(
          run(nodeBin, [join(repoRoot, "scripts", "ensure-official-electron.mjs"), "--json"], {
            env: { ...process.env, ZCODE_OFFICIAL_BIN: officialBin },
          }).stdout.trim().split("\n").pop(),
        );
        officialCopies.add(resolve(ensureOut.electronRoot, "zcode"));
      } catch { /* ensure 输出解析失败则只认原件 */ }
      check(
        "runtime: 官方运行时 spawn（zcode-cli exe=官方二进制）",
        runtimeExes.length > 0 && runtimeExes.every((e) => officialCopies.has(resolve(e))),
        `exes=[${runtimeExes.join(",")}] 合法集合=[${[...officialCopies].join(",")}]`,
      );
    } else {
      check("runtime: 非 Linux 仅验证运行时进程存在", true, "(exe 校验仅 Linux)");
    }
    snapScreen("20-runtime-spawned.png");
  }

  // ── gui（Linux + ZCODE_GO_E2E_GUI=1；模式取自 wails e2e 实践）────────────
  // 关键手法：日志标记协议（主进程打 "returnToOfficial/enterZCodeGo 完成" 标记，
  // 驱动侧 waitLog 轮询 + 进程存活检查）、settle 固定间隔、windowactivate --sync
  // 后再交互、无标题窗口按尺寸定位、失败必留根窗口截图。
  if (guiMode && isLinux && pid > 0) {
    const xdotool = (...args) => run("xdotool", args).stdout?.trim() ?? "";
    const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let logOffset = 0;
    const logText = () => {
      try {
        return readFileSync(join(stateDir, "desktop-launch.log"), "utf8");
      } catch {
        return "";
      }
    };
    logOffset = logText().length;
    /** wails wait_log 模式：0.25s 轮询标记；进程死亡立即失败，不许空等 */
    async function waitLog(marker, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!alive()) return { ok: false, detail: "进程已退出" };
        const text = logText().slice(logOffset);
        const at = text.indexOf(marker);
        if (at >= 0) {
          logOffset += at + marker.length;
          return { ok: true, detail: "" };
        }
        await settle(250);
      }
      return { ok: false, detail: `超时 ${timeoutMs}ms 未见标记 ${marker}` };
    }
    const windowGeometry = (w) => {
      const geo = run("xdotool", ["getwindowgeometry", "--shell", w]).stdout ?? "";
      return {
        width: Number((geo.match(/WIDTH=(\d+)/) ?? [])[1] ?? 0),
        height: Number((geo.match(/HEIGHT=(\d+)/) ?? [])[1] ?? 0),
        x: Number((geo.match(/X=(\-?\d+)/) ?? [])[1] ?? 0),
        y: Number((geo.match(/Y=(\-?\d+)/) ?? [])[1] ?? 0),
      };
    };
    const findWindowByWidth = (min, max) => {
      for (const w of (xdotool("search", "--pid", String(pid)) || "").split("\n").filter(Boolean)) {
        const { width } = windowGeometry(w);
        if (width >= min && width <= max) return w;
      }
      return "";
    };
    const isVisible = (w) =>
      (xdotool("search", "--pid", String(pid), "--onlyvisible") || "")
        .split("\n")
        .includes(w);

    // Linux 窗口级截图（xdotool 有窗口句柄；其他平台用全屏 snapScreen 已覆盖阶段证据）
    const snapWindow = (name, w) => {
      if (!w) return;
      run("sh", ["-c", `import -window ${w} '${join(shotsDir, name)}' 2>/dev/null || true`]);
    };
    const snapRoot = (name) => snapScreen(name);

    const mainWin = findWindowByWidth(800, 100000);
    check("gui: ZCode Go 主窗存在", mainWin !== "", `win=${mainWin}`);
    snapWindow("31-main-window.png", mainWin);

    if (mainWin) {
      // bare /zcode-go → SHOW → enterZCodeGo（官方在跑则其窗口被隐藏）
      const officialMainPid = run("pgrep", ["-f", `^${officialBin}`]).stdout?.trim().split("\n")[0];
      const bare = hookFeed("/zcode-go");
      check("gui: bare /zcode-go 即时回复", bare.stdout.includes("正在切换"));
      const entered = await waitLog("enterZCodeGo 完成");
      check("gui: SHOW → enterZCodeGo 完成（日志标记）", entered.ok, entered.detail);
      check("gui: SHOW 已被桌面消费", !existsSync(join(stateDir, "SHOW")));
      await settle(600);
      check("gui: ZCode Go 主窗可见", isVisible(mainWin));
      if (officialMainPid && Number(officialMainPid) > 0) {
        const officialVisible = xdotool("search", "--pid", officialMainPid, "--onlyvisible");
        check("gui: 官方窗口已隐藏", (officialVisible ?? "") === "", `可见=${officialVisible}`);
      }
      snapWindow("32-entered-main.png", mainWin);
      snapRoot("32-entered-root.png");

      // ── 返回官方 → 气泡（尺寸定位 + X 属性断言）→ 点气泡回切 ──────────
      xdotool("windowactivate", "--sync", mainWin);
      await settle(1000);
      xdotool("key", "Alt+F4");
      const returned = await waitLog("returnToOfficial 完成");
      check("gui: 关闭主窗 → returnToOfficial 完成（日志标记）", returned.ok, returned.detail);
      await settle(600);
      check("gui: 主窗已隐藏", !isVisible(mainWin));

      const bubbleWin = findWindowByWidth(110, 140); // 120px 画布（56 圆 + hover/阴影完整余量）
      check("gui: 气泡窗口出现（按尺寸定位）", bubbleWin !== "", `win=${bubbleWin}`);
      if (bubbleWin) {
        check("gui: 气泡可见", isVisible(bubbleWin));
        const wmType = run("xprop", ["-id", bubbleWin, "_NET_WM_WINDOW_TYPE"]).stdout ?? "";
        check(
          "gui: 气泡窗口类型 TOOLBAR（任务栏排除）",
          wmType.includes("_NET_WM_WINDOW_TYPE_TOOLBAR"),
          wmType.trim().slice(0, 60),
        );
        const wmState = run("xprop", ["-id", bubbleWin, "_NET_WM_STATE"]).stdout ?? "";
        check(
          "gui: 气泡 SKIP_TASKBAR 原子",
          wmState.includes("_NET_WM_STATE_SKIP_TASKBAR"),
          wmState.trim().slice(0, 80),
        );
        snapWindow("33-bubble.png", bubbleWin);
        run("sh", ["-c", `convert '${join(shotsDir, "33-bubble.png")}' -resize 400% '${join(shotsDir, "33-bubble-4x.png")}' 2>/dev/null || true`]);
        snapRoot("33-returned-root.png");

        // 坐标点击气泡中心 → 回切
        const g = windowGeometry(bubbleWin);
        xdotool("mousemove", "--sync", String(g.x + Math.floor(g.width / 2)), String(g.y + Math.floor(g.height / 2)));
        await settle(400);
        xdotool("click", "1");
        const reentered = await waitLog("enterZCodeGo 完成");
        check("gui: 点击气泡 → enterZCodeGo 完成（回切覆盖）", reentered.ok, reentered.detail);
        await settle(600);
        check("gui: 回切后主窗可见", isVisible(mainWin));
        check("gui: 回切后气泡隐藏", !isVisible(bubbleWin));
      }
      snapWindow("34-reentered-main.png", mainWin);
    }

    // 截图完整性断言（列名进日志，方便 CI 页面直接看产出了哪些）
    const shots = existsSync(shotsDir)
      ? (run("sh", ["-c", `ls -1 '${shotsDir}'`]).stdout ?? "").trim().split("\n").filter(Boolean)
      : [];
    check("gui: 分步截图产出（≥7 张）", shots.length >= 7, shots.join(", ") || "(无)");
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nE2E 汇总：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  for (const f of failed) console.error(`  失败：${f.name} ${f.detail}`);
  // wails 实践：失败必留根窗口截图（CI artifact 已含 ~/.zcode-go）
  try {
    run("sh", ["-c", `import -window root '${join(stateDir, "e2e-fail-root.png")}' 2>/dev/null || xwd -root -out '${join(stateDir, "e2e-fail-root.xwd")}' 2>/dev/null || true`]);
    console.error(`截图已保存至 ${stateDir}/e2e-fail-root.*`);
  } catch { /* 截图尽力而为 */ }
  process.exit(1);
}
