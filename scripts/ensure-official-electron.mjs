#!/usr/bin/env node
/**
 * 装配"复用官方 Electron"的运行布局（幂等）：
 *
 *   ~/.zcode-go/electron/
 *     zcode            ← 官方二进制（优先级：硬链接(0B) → reflink(≈0B) → 复制(约200MB)）
 *     *.pak/locales/…  ← 符号链接到官方安装目录（Chromium 资产，0B）
 *     resources/app/   ← 本仓库桌面的构建产物（out/ + package.json + node_modules 链接）
 *
 * 机制依据（实测）：Electron 按 <execPath>/../resources 解析资源，加载顺序
 * app.asar → app/ → default_app；官方二进制 fuse 位 11100011
 * （RunAsNode=1、AsarIntegrity=0、OnlyLoadAppFromAsar=0），因此允许从
 * resources/app/ 目录加载未签名 app。
 *
 * 用法：node scripts/ensure-official-electron.mjs [--force]
 *   --force 重装二进制与 app 产物（日常重建 out/ 后无需 --force，脚本按 mtime 同步）
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(repoRoot, "packages", "desktop");
const electronRoot = join(homedir(), ".zcode-go", "electron");
const officialBin = process.env.ZCODE_OFFICIAL_BIN?.trim() || "/opt/ZCode/zcode";
const officialDir = dirname(officialBin);
// macOS 官方二进制在 .app/Contents/MacOS/ 内，Chromium 需要完整的 bundle
// 结构（../Frameworks、../Resources 相对布局），裸复制 MacOS 下的二进制会
// dyld 找不到 Electron Framework 立即崩溃 —— 因此 mac 上重建同名结构：
//   ~/.zcode-go/electron/ZCode Go.app/Contents/{MacOS/zcode, Resources/app, …}
const isMacBundle = process.platform === "darwin";
const macContents = isMacBundle ? join(electronRoot, "ZCode Go.app", "Contents") : null;
const execDir = isMacBundle ? join(macContents, "MacOS") : electronRoot;
const resourcesDir = isMacBundle ? join(macContents, "Resources") : join(electronRoot, "resources");
const appDir = join(resourcesDir, "app");
const officialContents = isMacBundle ? dirname(officialDir) : null;
const officialResources = isMacBundle ? join(officialContents, "Resources") : join(officialDir, "resources");
const assetsSource = isMacBundle ? officialContents : officialDir;
const assetsTarget = isMacBundle ? macContents : electronRoot;
const force = process.argv.includes("--force");
const jsonOut = process.argv.includes("--json");
let syncedOut = false;

function log(msg) {
  if (!jsonOut) console.log(`[ensure-official-electron] ${msg}`);
}

const binName = process.platform === "win32" ? "zcode.exe" : "zcode";

function ensureBinary() {
  const target = join(execDir, binName);
  mkdirSync(execDir, { recursive: true });
  if (force && existsSync(target) && lstatSync(target).ino !== lstatSync(officialBin).ino) {
    rmSync(target);
  }
  if (!existsSync(target)) {
    // 1) 硬链接：同分区且权限允许（per-user 安装如 Windows LOCALAPPDATA 可行；0 字节）
    const ln = spawnSync("ln", [officialBin, target], { stdio: "ignore" });
    if (ln.status === 0 && existsSync(target)) {
      log(`二进制：硬链接（0 字节）`);
      return;
    }
    // 2) reflink（btrfs/xfs/zfs 写时复制 ≈0 块）；文件系统不支持时 cp 自动退化为完整复制。
    //    macOS/BSD cp 无 --reflink，直接落到 3)。
    const reflink = spawnSync("cp", ["--reflink=auto", officialBin, target], { stdio: "ignore" });
    if (reflink.status === 0 && existsSync(target)) {
      const shared = statSync(target).blocks < statSync(officialBin).blocks / 2;
      log(`二进制：${shared ? "reflink（≈0 字节）" : "完整复制（ext4 回退，约 200MB）"}`);
      return;
    }
    // 3) node 原生复制（跨平台兜底；copyFileSync 不保留可执行位，需 chmod）
    try {
      copyFileSync(officialBin, target);
      chmodSync(target, 0o755);
      log(`二进制：完整复制（约 200MB）`);
      return;
    } catch (error) {
      throw new Error(`无法放置二进制：ln/cp/copyFileSync 均失败：${error.message}`);
    }
  }
}

function ensureDistAssets() {
  for (const entry of readdirSync(assetsSource)) {
    // mac：Contents 下跳过 MacOS（二进制单独放）与 Resources（下方按需装配）；
    // 其他平台：根下跳过二进制与 resources 目录
    if (isMacBundle) {
      if (entry === "MacOS" || entry === "Resources") continue;
    } else if (entry === binName || entry === basename(officialBin) || entry === "resources") {
      continue;
    }
    const src = join(assetsSource, entry);
    const dst = join(assetsTarget, entry);
    if (existsSync(dst)) continue;
    try {
      symlinkSync(src, dst);
    } catch {
      // Windows 无符号链接权限（或跨设备）时回退复制，保证 locales/*.pak 等
      // Chromium 资产存在，否则 Electron 启动即缺资源
      try {
        cpSync(src, dst, { recursive: true });
        log(`资产：复制（symlink 不可用）${entry}`);
      } catch (error) {
        log(`资产装配失败 ${entry}: ${error.message}`);
      }
    }
  }
}

function ensureIcons() {
  // 打包态主进程从 resourcesPath 读图标（index.ts: icon.png / icon_512x512.png /
  // icon_windows.png）。直接链入官方图标：窗口图标与官方一致。
  mkdirSync(resourcesDir, { recursive: true });
  for (const name of ["icon.png", "icon_512x512.png", "icon_windows.png"]) {
    const src = join(officialResources, name);
    const dst = join(resourcesDir, name);
    if (!existsSync(dst) && existsSync(src)) {
      symlinkSync(src, dst);
      log(`图标链接：${name}`);
    }
  }
}

function ensureLinuxDesktopEntry() {
  // 任务栏/启动器身份：StartupWMClass 与 app name（"ZCode Go"）匹配，
  // 图标用官方 512px，Exec 指向启动器（冷启动全链路）。
  if (process.platform !== "linux") return;
  const desktopDir = join(homedir(), ".local", "share", "applications");
  const entry = join(desktopDir, "zcode-go.desktop");
  const exec = join(repoRoot, "scripts", "launch-zcode-go.sh");
  const icon = join(officialDir, "resources", "icon_512x512.png");
  // 官方机制：Icon 用 hicolor 图标主题名（tasklist 按主题查图标，绝对路径不可靠）。
  // 把官方 512px 图标链入用户主题目录，主题名 zcode-go。
  const iconThemeDir = join(homedir(), ".local", "share", "icons", "hicolor", "512x512", "apps");
  mkdirSync(iconThemeDir, { recursive: true });
  const themeIcon = join(iconThemeDir, "zcode-go.png");
  if (!existsSync(themeIcon)) {
    symlinkSync(icon, themeIcon);
    try {
      spawnSync("gtk-update-icon-cache", ["-f", "-t", join(homedir(), ".local", "share", "icons", "hicolor")], { stdio: "ignore" });
    } catch { /* 无该工具时忽略 */ }
  }
  const content = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=ZCode Go",
    "Comment=ZCode 桌面接管（官方原生运行时，保额度）",
    `Exec=${exec}`,
    "Icon=zcode-go",
    "Terminal=false",
    "Categories=Development;",
    "StartupWMClass=ZCode Go",
    "",
  ].join("\n");
  mkdirSync(desktopDir, { recursive: true });
  writeFileSync(entry, content, "utf8");
  try {
    spawnSync("update-desktop-database", [desktopDir], { stdio: "ignore" });
  } catch { /* 无该工具时忽略 */ }
  log(`桌面入口：${entry}`);
}

function ensureApp() {
  mkdirSync(resourcesDir, { recursive: true });
  // out/ 产物同步（mtime 检查，避免每次全量拷贝）
  const outSrc = join(desktopDir, "out");
  const outDst = join(appDir, "out");
  for (const rel of ["main/index.js", "renderer/index.html"]) {
    if (!existsSync(join(outSrc, rel))) {
      throw new Error(
        `缺少桌面构建产物：${join(outSrc, rel)}（在 packages/desktop 执行 ZCODE_PREVIEW_IDENTITY=1 npx tsup && npx vite build）`,
      );
    }
  }
  if (force && existsSync(outDst)) rmSync(outDst, { recursive: true });
  // mtimeMs 是 float64，纳秒精度有损；保留时间戳拷贝后允许 5ms 容差判定"未变更"
  const markers = [join("main", "index.js"), join("renderer", "index.html")];
  const changed = markers.some((rel) => {
    if (!existsSync(join(outDst, rel))) return true;
    return Math.abs(statSync(join(outSrc, rel)).mtimeMs - statSync(join(outDst, rel)).mtimeMs) > 5;
  });
  if (changed) {
    if (existsSync(outDst)) rmSync(outDst, { recursive: true });
    // preserveTimestamps：以产物 mtime 作为同步标记，避免每次全量重拷
    cpSync(outSrc, outDst, { recursive: true, preserveTimestamps: true });
    log(`app 产物已同步（out/）`);
    syncedOut = true;
  }
  // package.json：main → out/main/index.js。
  // version 与官方打包同源：electron-builder.config.js 的 extraMetadata 取
  // 根 package.json version（scripts/build-metadata.mjs normalizeVersion 去
  // 前导非数字）；我们未走 electron-builder，等价于装配时写入
  // resources/app/package.json。electron-updater 需要合法 semver。
  const desktopPkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const appVersion =
    String(rootPkg.version ?? "").replace(/^[^\d]*/, "") || desktopPkg.version || "0.0.0";
  writeFileSync(
    join(appDir, "package.json"),
    JSON.stringify(
      { name: "zcode-go", version: appVersion, main: "out/main/index.js", type: desktopPkg.type ?? "module" },
      null,
      1,
    ) + "\n",
    "utf8",
  );
  // 运行时依赖：dev 级用仓库根 node_modules 符号链接（生产打包应改为 bundle 进 app）
  const nm = join(appDir, "node_modules");
  if (!existsSync(nm)) {
    symlinkSync(join(repoRoot, "node_modules"), nm);
    log("node_modules → 仓库根（dev 级；生产分发改为随包内置）");
  }
}

try {
  if (!existsSync(officialBin)) {
    throw new Error(`官方二进制不存在：${officialBin}（可用 ZCODE_OFFICIAL_BIN 指定）`);
  }
  ensureBinary();
  ensureDistAssets();
  ensureIcons();
  ensureLinuxDesktopEntry();
  ensureApp();
  if (jsonOut) {
    console.log(JSON.stringify({ electronRoot, appDir, officialBin, synced: syncedOut }));
  } else {
    console.log(JSON.stringify({ electronRoot, appDir, officialBin }, null, 1));
  }
} catch (error) {
  console.error(`[ensure-official-electron] ${error.message}`);
  process.exit(1);
}
