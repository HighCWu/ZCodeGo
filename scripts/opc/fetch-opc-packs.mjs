#!/usr/bin/env node
/**
 * zcode-go OPC 模板包拉取脚本（spec「模板包」节）。
 *
 * 从用户 fork 下载 codeload tarball，按内容过滤后落盘为「模板包」目录，
 * 供 desktop main 在运行时做幂等填充：
 *   - OpenOPC   → .opc/prompts/talent/ 全部角色 md + .opc/skills/ 下各 SKILL.md（技能）
 *   - claude-skills → 全部 SKILL.md（技能）
 *
 * 用法：
 *   pnpm opc:fetch-packs                 # 默认输出 ~/.zcode-go/opc-packs/（用户级缓存，dev 用）
 *   pnpm opc:fetch-packs:desktop         # 输出 packages/desktop/build/opc-packs/（打包用，已 gitignore）
 *   node scripts/opc/fetch-opc-packs.mjs --out <dir> --force
 *
 * 来源可覆盖：OPC_PACK_OPENOPC_REPO / OPC_PACK_CLAUDE_SKILLS_REPO（owner/repo）。
 * 幂等：pack.json 版本戳（commit sha）相同则跳过；--force 强制重拉。
 * 网络失败非致命（exit 1，内置精编模板不受影响）。
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const PACKS = [
  {
    id: "openopc",
    repo: process.env.OPC_PACK_OPENOPC_REPO ?? "HighCWu/OpenOPC",
    picks: [
      { prefix: ".opc/prompts/talent/", target: "talent" },
      { prefix: ".opc/skills/", target: "skills" },
    ],
  },
  {
    id: "claude-skills",
    repo: process.env.OPC_PACK_CLAUDE_SKILLS_REPO ?? "HighCWu/claude-skills",
    picks: [{ prefix: "", target: "skills" }],
  },
];

const args = process.argv.slice(2);
const force = args.includes("--force");
const outIndex = args.indexOf("--out");
const defaultOut =
  process.env.OPC_PACKS_OUT ?? join(homedir(), ".zcode-go", "opc-packs");
const outRoot = resolve(outIndex >= 0 ? args[outIndex + 1] : defaultOut);

function log(message) {
  console.log(`[opc-packs] ${message}`);
}

function run(command, args_, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, stdout, stderr });
    });
  });
}

async function resolveVersion(repo) {
  // 版本戳：gh（已认证，速率宽）→ 匿名 GitHub API → 时间戳兜底
  const sha = await run(
    "gh",
    ["api", `repos/${repo}/commits/HEAD`, "--jq", ".sha"],
    { timeoutMs: 20_000 },
  );
  if (sha.ok && /^[0-9a-f]{7,40}/.test(sha.stdout.trim()))
    return sha.stdout.trim().slice(0, 12);
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/commits/HEAD`,
    );
    if (response.ok) {
      const payload = await response.json();
      if (typeof payload?.sha === "string") return payload.sha.slice(0, 12);
    }
  } catch {
    /* 离线/限流 → 时间戳兜底 */
  }
  return `snapshot-${new Date().toISOString().slice(0, 10)}`;
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function fetchPack(pack) {
  const packDir = join(outRoot, pack.id);
  const stampPath = join(packDir, "pack.json");
  if (!force && existsSync(stampPath)) {
    try {
      const previous = JSON.parse(readFileSync(stampPath, "utf8"));
      log(`${pack.id}: 已是 ${previous.version}（--force 可强制重拉），跳过`);
      return { id: pack.id, skipped: true };
    } catch {
      /* 戳损坏 → 重拉 */
    }
  }
  const version = await resolveVersion(pack.repo);
  const tmpExtract = mkdtempSync(join(tmpdir(), "opc-pack-"));
  try {
    const tarball = join(tmpExtract, "pack.tar.gz");
    log(
      `${pack.id}: 下载 https://codeload.github.com/${pack.repo}/tar.gz/HEAD …`,
    );
    const response = await fetch(
      `https://codeload.github.com/${pack.repo}/tar.gz/HEAD`,
    );
    if (!response.ok || !response.body) {
      throw new Error(`codeload HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024)
      throw new Error(`tarball 过小（${buffer.length}B）`);
    writeFileSync(tarball, buffer);
    const extract = await run("tar", ["-xzf", tarball, "-C", tmpExtract], {
      timeoutMs: 180_000,
    });
    if (!extract.ok)
      throw new Error(`tar 解压失败: ${extract.stderr.slice(0, 200)}`);
    const topEntries = readdirSync(tmpExtract).filter((name) => {
      const full = join(tmpExtract, name);
      return name !== "pack.tar.gz" && statSync(full).isDirectory();
    });
    if (topEntries.length === 0) throw new Error("tarball 无顶层目录");
    const repoRoot = join(tmpExtract, topEntries[0]);

    if (existsSync(packDir)) rmSync(packDir, { recursive: true, force: true });
    mkdirSync(packDir, { recursive: true });
    let copied = 0;
    for (const source of walkFiles(repoRoot)) {
      const relative = source
        .slice(repoRoot.length + 1)
        .split(sep)
        .join("/");
      if (!/\.md$/i.test(relative)) continue;
      const isSkill = /(^|\/)SKILL\.md$/i.test(relative);
      const pick = pack.picks.find(
        (candidate) =>
          (candidate.prefix === "" || relative.startsWith(candidate.prefix)) &&
          (isSkill || candidate.target === "talent"),
      );
      if (!pick) continue;
      const target = join(
        packDir,
        pick.target,
        relative.slice(pick.prefix.length),
      );
      mkdirSync(target.slice(0, target.lastIndexOf(sep)), { recursive: true });
      writeFileSync(target, readFileSync(source));
      copied += 1;
    }
    if (copied === 0) throw new Error("过滤后 0 个文件（结构可能变化）");
    writeFileSync(
      stampPath,
      `${JSON.stringify({ id: pack.id, repo: pack.repo, ref: "HEAD", version, fetchedAt: new Date().toISOString(), files: copied }, null, 1)}\n`,
      "utf8",
    );
    log(`${pack.id}: ${version} → ${copied} 个文件 → ${packDir}`);
    return { id: pack.id, skipped: false, copied, version };
  } finally {
    rmSync(tmpExtract, { recursive: true, force: true });
  }
}

const results = [];
let failed = false;
for (const pack of PACKS) {
  try {
    results.push(await fetchPack(pack));
  } catch (error) {
    failed = true;
    log(
      `${pack.id}: 拉取失败——${error instanceof Error ? error.message : String(error)}`,
    );
    if (error instanceof Error && error.stack) {
      log(`${pack.id}: ${error.stack.split("\n").slice(1, 4).join(" | ")}`);
    }
  }
}
if (results.every((result) => result.skipped)) {
  log("全部模板包均为最新，无需更新。");
}
process.exitCode = failed ? 1 : 0;
