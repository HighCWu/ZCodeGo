#!/usr/bin/env node
/**
 * 装配"复用官方 Electron"的运行布局（幂等）：
 *
 *   Linux/Windows（扁平布局，官方二进制 + 符号链接资产，≈0 空间）：
 *     ~/.zcode-go/electron/
 *       zcode[.exe]      ← 官方二进制（硬链接(0B) → reflink(≈0B) → 复制）
 *       *.pak/locales/…  ← 符号链接到官方安装目录（Chromium 资产，0B）
 *       resources/app/   ← 本仓库桌面的构建产物（out/ + package.json + node_modules 链接）
 *
 *   macOS（bundle 布局，APFS clonefile 整包克隆 + ad-hoc 重签）：
 *     ~/.zcode-go/electron/ZCode Go.app/   ← 官方 .app 的写时复制克隆
 *       Contents/Resources/app/            ← 本仓库桌面的构建产物
 *
 * 机制依据（实测）：Electron 按 <execPath>/../resources 解析资源，加载顺序
 * app.asar → app/ → default_app；官方二进制 fuse 位 11100011
 * （RunAsNode=1、AsarIntegrity=0、OnlyLoadAppFromAsar=0），因此允许从
 * resources/app/ 目录加载未签名 app。
 *
 * mac 上不能用"符号链接混搭"：arm64 强制代码签名，bundle 是有封印的整体
 * （CodeResources 记录全包哈希），跨包符号链接的混血 bundle 会在 GUI 多进程
 * 初始化触发 Chromium CHECK 陷阱（CI 实测 SIGTRAP）。正确姿势：
 * clonefile 整包克隆（瞬时、近零空间）→ 放入 Resources/app → ad-hoc 重签，
 * 使封印与新内容自洽。重签只影响 GUI 宿主克隆；底层原生运行时 spawn 的仍是
 * official.json 指向的官方安装本体（保签路径不受影响）。
 *
 * 用法：node scripts/ensure-official-electron.mjs [--force]
 *   --force 重装二进制/克隆与 app 产物（日常重建 out/ 后无需 --force，按 mtime 同步）
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(repoRoot, "packages", "desktop");
const electronRoot = join(homedir(), ".zcode-go", "electron");
const officialBin = process.env.ZCODE_OFFICIAL_BIN?.trim() || "/opt/ZCode/zcode";
const officialDir = dirname(officialBin);

const isMacBundle = process.platform === "darwin";
// mac：officialBin = <官方 .app>/Contents/MacOS/<exe>，克隆宿主为 ZCode Go.app
const officialContents = isMacBundle ? dirname(officialDir) : null;
const officialAppDir = isMacBundle ? dirname(officialContents) : null;
const cloneAppDir = isMacBundle ? join(electronRoot, "ZCode Go.app") : null;
const macContents = isMacBundle ? join(cloneAppDir, "Contents") : null;
const cloneMarker = join(electronRoot, ".clone-source");

const execDir = isMacBundle ? join(macContents, "MacOS") : electronRoot;
const resourcesDir = isMacBundle ? join(macContents, "Resources") : join(electronRoot, "resources");
const appDir = join(resourcesDir, "app");
const officialResources = isMacBundle ? join(officialContents, "Resources") : join(officialDir, "resources");
const assetsSource = officialDir;
const assetsTarget = electronRoot;

const force = process.argv.includes("--force");
const jsonOut = process.argv.includes("--json");
let syncedOut = false;
let assembled = false; // 本次是否动过 bundle 结构（克隆/图标）——需要重签

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
      assembled = true;
      return;
    }
    // 2) reflink（btrfs/xfs/zfs 写时复制 ≈0 块）；文件系统不支持时 cp 自动退化为完整复制。
    //    macOS/BSD cp 无 --reflink，直接落到 3)。
    const reflink = spawnSync("cp", ["--reflink=auto", officialBin, target], { stdio: "ignore" });
    if (reflink.status === 0 && existsSync(target)) {
      const shared = statSync(target).blocks < statSync(officialBin).blocks / 2;
      log(`二进制：${shared ? "reflink（≈0 字节）" : "完整复制（ext4 回退，约 200MB）"}`);
      assembled = true;
      return;
    }
    // 3) node 原生复制（跨平台兜底；copyFileSync 不保留可执行位，需 chmod）
    try {
      copyFileSync(officialBin, target);
      chmodSync(target, 0o755);
      log(`二进制：完整复制（约 200MB）`);
      assembled = true;
      return;
    } catch (error) {
      throw new Error(`无法放置二进制：ln/cp/copyFileSync 均失败：${error.message}`);
    }
  }
}

function ensureDistAssets() {
  for (const entry of readdirSync(assetsSource)) {
    // 跳过二进制与 resources 目录（后者由 ensureIcons/ensureApp 装配）
    if (entry === binName || entry === basename(officialBin) || entry === "resources") continue;
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

/**
 * mac：整包克隆官方 .app（APFS clonefile 写时复制，瞬时/近零空间；跨设备
 * 回退普通复制）。克隆出的 bundle 结构完整、无跨包符号链接；二进制保留
 * 官方原名（CFBundleExecutable 必须一致）。源变化（换官方安装）或 --force
 * 时重克隆。返回是否发生了克隆。
 */
function ensureMacClone() {
  const exeProbe = join(execDir, basename(officialBin));
  const cloneResourcesDir = join(cloneAppDir, "Contents", "Resources");
  const stamp = (() => {
    const st = statSync(officialBin);
    return `${officialBin}\n${st.size}\n${Math.round(st.mtimeMs)}`;
  })();
  const prev = existsSync(cloneMarker) ? readFileSync(cloneMarker, "utf8").trim() : "";
  const needClone =
    force || !existsSync(exeProbe) || prev !== stamp;
  if (!needClone) return false;

  rmSync(cloneAppDir, { recursive: true, force: true });
  mkdirSync(electronRoot, { recursive: true });
  // cp -c = APFS clonefile（写时复制）；不支持（非 APFS/老系统）退回普通复制
  let r = spawnSync("cp", ["-cR", officialAppDir, cloneAppDir], { stdio: "ignore" });
  if (r.status !== 0 || !existsSync(exeProbe)) {
    r = spawnSync("cp", ["-R", officialAppDir, cloneAppDir], { stdio: "ignore" });
  }
  if (r.status !== 0 || !existsSync(exeProbe)) {
    throw new Error(`无法克隆官方 bundle：${officialAppDir} → ${cloneAppDir}`);
  }
  // 源 app 可能带 quarantine（真实用户从 DMG 安装），克隆后清除，避免
  // Gatekeeper 对未公证的改封 bundle 弹窗
  spawnSync("xattr", ["-rd", "com.apple.quarantine", cloneAppDir], { stdio: "ignore" });
  // 关键：Electron 加载顺序 app.asar → app/。克隆带入的官方 app.asar 会
  // 抢先加载（CI 实测：窗口/host 全正常但跑的是官方代码，takeover 不生效）。
  // 删掉它让 fallback 落到我们的 Resources/app/。
  for (const stale of ["app.asar", "app.asar.unpacked"]) {
    rmSync(join(cloneResourcesDir, stale), { recursive: true, force: true });
  }
  writeFileSync(cloneMarker, `${stamp}\n`, "utf8");
  log(`官方 bundle 克隆完成（clonefile→${cloneAppDir}）`);
  assembled = true;
  return true;
}

/**
 * mac：ad-hoc 重签（`codesign --force -s -`，无需开发者身份、可离线）。
 * 加入 Resources/app 后外层封印必须与新内容自洽；只签外层（保留 Frameworks
 * 内 helper/framework 的原签名），--deep 仅作兜底。未签态 bundle 在 arm64
 * 上无法启动，失败必须硬失败。
 */
function ensureMacResign() {
  if (process.platform !== "darwin") return;
  if (!assembled && !syncedOut) return;
  let r = spawnSync("codesign", ["--force", "-s", "-", cloneAppDir], { encoding: "utf8" });
  if (r.status !== 0) {
    r = spawnSync("codesign", ["--force", "--deep", "-s", "-", cloneAppDir], { encoding: "utf8" });
  }
  if (r.status !== 0) {
    throw new Error(`ad-hoc 重签失败：${(r.stderr || r.stdout || "").slice(0, 400)}`);
  }
  log(`ad-hoc 重签完成（${assembled ? "bundle 结构变化" : "app 产物更新"}）`);
}

function ensureIcons() {
  // 打包态主进程从 resourcesPath 读图标（index.ts: icon.png / icon_512x512.png /
  // icon_windows.png）。直接取官方图标：窗口图标与官方一致。
  // mac 上必须实拷：跨包符号链接会破坏克隆 bundle 的封印自洽。
  mkdirSync(resourcesDir, { recursive: true });
  for (const name of ["icon.png", "icon_512x512.png", "icon_windows.png"]) {
    const src = join(officialResources, name);
    const dst = join(resourcesDir, name);
    if (!existsSync(dst) && existsSync(src)) {
      if (isMacBundle) {
        copyFileSync(src, dst);
        log(`图标复制：${name}`);
      } else {
        symlinkSync(src, dst);
        log(`图标链接：${name}`);
      }
      assembled = true;
    }
  }
  // zcode-go 品牌图标（B5：官方 logo 圆角方形 + Go 徽章）：独立新文件门控——
  // 运行时检测到 icon-zcode-go.png 即替换窗口/Dock/任务栏图标，删除即回退
  // 官方（ZCODE_GO_OFFICIAL_ICON=1 也可强切回）。仓库资产为准，装一次即可。
  const brandSrc = join(repoRoot, "packages", "desktop", "build", "zcode-go-icon.png");
  const brandDst = join(resourcesDir, "icon-zcode-go.png");
  if (existsSync(brandSrc) && !existsSync(brandDst)) {
    copyFileSync(brandSrc, brandDst);
    log(`品牌图标安装：icon-zcode-go.png`);
  }
}

/** hicolor 主题图标（zcode-go）：品牌资产优先，旧链指向官方时刷新。 */
function ensureLinuxIconThemeLink() {
  if (process.platform !== "linux") return;
  const brandIcon = join(resourcesDir, "icon-zcode-go.png");
  const icon = existsSync(brandIcon) ? brandIcon : join(officialDir, "resources", "icon_512x512.png");
  const iconThemeDir = join(homedir(), ".local", "share", "icons", "hicolor", "512x512", "apps");
  mkdirSync(iconThemeDir, { recursive: true });
  const themeIcon = join(iconThemeDir, "zcode-go.png");
  let stale = !existsSync(themeIcon);
  if (!stale) {
    try {
      stale = lstatSync(themeIcon).isSymbolicLink() && readlinkSync(themeIcon) !== icon;
    } catch {
      stale = true;
    }
  }
  if (stale) {
    rmSync(themeIcon, { force: true });
    symlinkSync(icon, themeIcon);
    try {
      spawnSync("gtk-update-icon-cache", ["-f", "-t", join(homedir(), ".local", "share", "icons", "hicolor")], { stdio: "ignore" });
    } catch { /* 无该工具时忽略 */ }
    log(`主题图标：zcode-go.png → ${icon}`);
  }
}

function ensureLinuxDesktopEntry() {
  // 任务栏/启动器身份：StartupWMClass 与 app name（"ZCode Go"）匹配，
  // 图标用 512px（品牌资产优先，缺省回退官方），Exec 指向启动器（冷启动全链路）。
  if (process.platform !== "linux") return;
  const desktopDir = join(homedir(), ".local", "share", "applications");
  const entry = join(desktopDir, "zcode-go.desktop");
  const exec = join(repoRoot, "scripts", "launch-zcode-go.sh");
  // 官方机制：Icon 用 hicolor 图标主题名（tasklist 按主题查图标，绝对路径不可靠）。
  ensureLinuxIconThemeLink();
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

/**
 * 增量合并会累积历史 hash chunk；这里删除超过 30 天未更新的 renderer/assets
 * 文件（全部为 hash 命名的不可变产物）。运行中的窗口按常理不会引用一个月前
 * 的构建；真被清掉的极端场景重载窗口即可恢复。
 */
function cleanupStaleRendererAssets(assetsDir) {
  if (!existsSync(assetsDir)) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(assetsDir)) {
    const full = join(assetsDir, name);
    try {
      const info = statSync(full);
      if (info.isFile() && info.mtimeMs < cutoff) {
        rmSync(full);
        removed += 1;
      }
    } catch {
      /* 并发变动时忽略单个文件 */
    }
  }
  if (removed > 0) log(`清理 ${removed} 个超过 30 天的旧 renderer chunk`);
}

function ensureApp() {
  mkdirSync(resourcesDir, { recursive: true });
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
    // 只增不删地合并（cpSync 递归覆盖同名、保留目标端独有文件）。vite/rollup 的
    // 懒加载 chunk 按 content-hash 命名，是不可变文件：整体删除重拷会让所有
    // 运行中窗口（含多窗口）对旧 hash 的动态 import 404——实测「使用统计」
    // 时间范围切换报 "Failed to fetch dynamically imported module"。入口文件
    // （index.html/main/index.js 等非 hash 名）被覆盖，新窗口即用新产物；旧
    // hash chunk 留给运行中的旧页面继续懒加载。
    cpSync(outSrc, outDst, { recursive: true, preserveTimestamps: true });
    cleanupStaleRendererAssets(join(outDst, "renderer", "assets"));
    log(`app 产物已同步（out/，增量合并）`);
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
  if (isMacBundle) {
    ensureMacClone();
    ensureIcons();
    ensureApp();
    ensureMacResign();
  } else {
    ensureBinary();
    ensureDistAssets();
    ensureIcons();
    // 主题图标独立刷新（不创建桌面入口——用户反馈过开始菜单多出入口，保持不静默安装）。
    ensureLinuxIconThemeLink();
  // 桌面入口不再静默安装（用户反馈开始菜单莫名多出 ZCode Go）。如需启动器入口，手动运行本脚本后自行创建，或恢复此调用。
    ensureApp();
  }
  const out = { electronRoot, appDir, officialBin };
  if (isMacBundle) out.bundle = cloneAppDir;
  if (jsonOut) {
    out.synced = syncedOut;
    console.log(JSON.stringify(out));
  } else {
    console.log(JSON.stringify(out, null, 1));
  }
} catch (error) {
  console.error(`[ensure-official-electron] ${error.message}`);
  process.exit(1);
}
