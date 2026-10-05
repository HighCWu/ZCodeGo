#!/usr/bin/env node
/**
 * 同步 zcode-go 插件到工作区插件目录并登记本地开发市场。
 *
 * 源：仓库 plugin/（精瘦：manifest + hook + 编排 + command）
 * 目标：<workspace>/plugins/zcode-go/（官方"添加本地市场"所指向的目录旁）
 * 同时写入仓库路径标记（scripts/zcode-go-home），供 takeover.py 定位启动器。
 *
 * 用法：node scripts/sync-plugin.mjs [--workspace <dir>]
 *   --workspace 默认 ~/.zcode/workspace/default
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginSource = join(repoRoot, "plugin");

const workspaceArg = process.argv.indexOf("--workspace");
const workspace =
  workspaceArg >= 0 ? resolve(process.argv[workspaceArg + 1] ?? "") : join(homedir(), ".zcode", "workspace", "default");
const pluginsRoot = join(workspace, "plugins");
const pluginTarget = join(pluginsRoot, "zcode-go");
const marketplacePath = join(pluginsRoot, "marketplace.json");

if (!existsSync(join(pluginSource, ".zcode-plugin", "plugin.json"))) {
  console.error(`[sync-plugin] 源缺失：${pluginSource}/.zcode-plugin/plugin.json`);
  process.exit(1);
}

mkdirSync(pluginsRoot, { recursive: true });
if (existsSync(pluginTarget)) rmSync(pluginTarget, { recursive: true });
cpSync(pluginSource, pluginTarget, { recursive: true });

// 仓库路径标记：takeover.py 的启动器解析链（config → 本标记）
writeFileSync(
  join(pluginTarget, "hooks", "zcode-go-home"),
  repoRoot + "\n",
  "utf8",
);

// 读取插件版本，更新/创建本地市场目录（保留既有其它条目）
const manifest = JSON.parse(readFileSync(join(pluginTarget, ".zcode-plugin", "plugin.json"), "utf8"));
let marketplace = { name: "", plugins: [] };
if (existsSync(marketplacePath)) {
  try {
    marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
  } catch {
    marketplace = { name: "", plugins: [] };
  }
}
marketplace.name = marketplace.name || "dev-zcode-go";
const entry = {
  name: manifest.name,
  source: "./zcode-go",
  version: manifest.version,
  description: manifest.description,
  displayName: "ZCode Go",
  displayName_i18n: { "zh-CN": "ZCode Go" },
  description_i18n: {
    "zh-CN": "桌面接管：/zcode-go 隐藏官方窗口，ZCode Go 桌面接管；官方原生运行时保额度；退出后重开官方 ZCode 即可切回。",
  },
  category: "productivity",
};
const index = marketplace.plugins.findIndex((p) => p.name === manifest.name);
if (index >= 0) marketplace.plugins[index] = entry;
else marketplace.plugins.push(entry);
writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  pluginTarget,
  marketplacePath,
  marketplaceName: marketplace.name,
  pluginId: `${manifest.name}@${marketplace.name}`,
  version: manifest.version,
}, null, 2));
console.log(`\n在官方 ZCode 中：插件市场 → 添加 → 粘贴 ${pluginsRoot}\n然后 个人 → ${marketplace.name} → ${manifest.name} → 安装 → 重启官方 ZCode`);
