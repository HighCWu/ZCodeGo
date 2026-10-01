#!/usr/bin/env node
/**
 * 锚定官方提交：找到本 fork 所基于的 zai-org/ZCode 提交。
 *
 * 策略（按序，均输出同一套 GitHub ENV/输出）：
 *   1. merge-base：官方仓库与本仓库共享 git 历史（ZCodeGo 是 zai-org/ZCode 的
 *      真 fork），`git merge-base HEAD official/main` 即本 fork 脚下最近的官方
 *      提交。官方升级后不合并 → 锚点不动；合并官方 → 锚点随之前移。天然自愈。
 *   2. 版本号回退：无共同祖先时，读 packages/desktop 版本，在官方历史中找
 *      package.json 版本一致（或版本号最高的 v 前缀 tag）的提交。
 *
 * 输出（stdout 末行 JSON）：{ anchor, anchorShort, strategy, forkHead, officialHead, officialUrl }
 * CI 用法：node scripts/ci/find-official-anchor.mjs >> "$GITHUB_OUTPUT" 等。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OFFICIAL_URL = process.env.ZCODE_OFFICIAL_REMOTE ?? "https://github.com/zai-org/ZCode.git";

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

function outputs(result) {
  console.log(JSON.stringify(result, null, 1));
  if (process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(result).map(([k, v]) => `${k}=${v}`);
    appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n", "utf8");
  }
}

// 1) 拉官方（blob:none 部分克隆足够算 merge-base；已在本地则复用）
tryGit("remote", "remove", "zcode-official");
git("remote", "add", "zcode-official", OFFICIAL_URL);
git("fetch", "--no-tags", "--filter=blob:none", "zcode-official", "main");
const officialHead = git("rev-parse", "zcode-official/main");
const forkHead = git("rev-parse", "HEAD");

const mergeBase = tryGit("merge-base", "HEAD", "zcode-official/main");
if (mergeBase && mergeBase !== "") {
  outputs({
    anchor: mergeBase,
    anchorShort: mergeBase.slice(0, 8),
    strategy: "merge-base",
    forkHead,
    officialHead,
    officialUrl: OFFICIAL_URL,
  });
  process.exit(0);
}

// 2) 版本号回退：在官方 main 历史里找 package.json 版本与本 fork 一致的提交
const desktopPkg = JSON.parse(
  readFileSync(join(repoRoot, "packages", "desktop", "package.json"), "utf8"),
);
const forkVersion = desktopPkg.version;
// 版本回退逐提交读 blob（部分克隆会按需拉取），限制条数控制耗时
const log = git("log", "--format=%H", "--max-count=50", "zcode-official/main");
let fallback = "";
for (const commit of log.split("\n")) {
  const content = tryGit("show", `${commit}:packages/desktop/package.json`);
  if (!content) continue;
  try {
    if (JSON.parse(content).version === forkVersion) {
      fallback = commit;
      break;
    }
  } catch {
    /* 下一个 */
  }
}
if (fallback) {
  outputs({
    anchor: fallback,
    anchorShort: fallback.slice(0, 8),
    strategy: "version-fallback",
    forkHead,
    officialHead,
    officialUrl: OFFICIAL_URL,
  });
  process.exit(0);
}

console.error("无法锚定官方提交：既无共同祖先，也找不到版本一致的官方提交");
process.exit(1);
