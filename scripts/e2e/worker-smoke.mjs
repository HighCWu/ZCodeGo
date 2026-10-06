#!/usr/bin/env node
/**
 * zcode-go Worker 冒烟（本地/CI 同一套；零依赖，node ≥ 20）。
 *
 * 本地起 wrangler dev（--local，无需部署凭证）后断言容器页与路由行为：
 *   - / 容器页：zh/en 双语（Accept-Language）、box-sizing 修复（手机卡片溢出）、
 *     卡片结构（brand/card/status/progress）、资源加载期保留卡片的门控脚本存在
 *   - /sw.js：Service Worker 以 JS content-type 下发
 *   - /app/ 未就绪兜底：503 + 双语文案
 *   - /api/rooms：坏 token 400 / 好形状 token 200（房间懒创建回执）
 *
 * 用法：node scripts/e2e/worker-smoke.mjs
 * （自动安装 worker 依赖并启动 wrangler dev 于 8787；结束自动清理）
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(pathDirname(fileURLToPath(import.meta.url)), "..", "..");
const workerDir = join(repoRoot, "mobile-bridge", "worker");
const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* 未就绪继续等 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers, redirect: "manual" });
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: await res.text() };
}

// ── 依赖与本地 dev server ────────────────────────────────────────────────
if (!existsSync(join(workerDir, "node_modules", "wrangler"))) {
  console.log("[worker-smoke] 安装 worker 依赖（npm install）…");
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: workerDir, encoding: "utf8", timeout: 300_000 });
  if (install.status !== 0) {
    console.error(install.stdout, install.stderr);
    console.error("worker 依赖安装失败");
    process.exit(2);
  }
}

console.log("[worker-smoke] 启动 wrangler dev（--local，端口 8787）…");
const dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT)], {
  cwd: workerDir,
  stdio: ["ignore", "pipe", "pipe"],
});
let devLog = "";
dev.stdout.on("data", (c) => { devLog += c.toString(); });
dev.stderr.on("data", (c) => { devLog += c.toString(); });
const cleanup = () => {
  try { dev.kill("SIGTERM"); } catch { /* 尽力而为 */ }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

try {
  check("worker: wrangler dev 就绪", await waitForServer(), devLog.slice(-200).replaceAll("\n", " | "));

  // ── 容器页（中文）─────────────────────────────────────────────────────
  const zh = await get("/", { "Accept-Language": "zh-CN,zh;q=0.9" });
  check("page: / 200 HTML", zh.status === 200 && zh.contentType.includes("text/html"));
  check("page: 中文标题/副标题（i18n）", zh.body.includes("ZCode Go · 移动端连接") && zh.body.includes("移动端连接"));
  check(
    "page: box-sizing 修复在（手机卡片不溢出的根因修复）",
    zh.body.includes("*, *::before, *::after { box-sizing: border-box; }") || zh.body.includes("box-sizing: border-box"),
  );
  check(
    "page: 卡片结构与资源进度（brand/mark、status、progress）",
    zh.body.includes('class="card" id="card"') && zh.body.includes('id="status"') && zh.body.includes('id="progress"'),
  );
  check(
    "page: 连接后保留卡片至应用就绪（waitForAppSurface 交接逻辑）",
    zh.body.includes("waitForAppSurface") && zh.body.includes("root-startup-loading"),
  );
  check("page: 禁缓存（引导壳 no-store）", zh.body.length > 0 && true); // 头部断言见下
  const head = await fetch(`${BASE}/`).then((r) => r.headers.get("cache-control") ?? "");
  check("page: cache-control no-store", head.includes("no-store"), head);

  // ── 容器页（英文）─────────────────────────────────────────────────────
  const en = await get("/", { "Accept-Language": "en-US,en;q=0.9" });
  check("page: 英文标题/副标题（i18n）", en.body.includes("ZCode Go · Mobile Connect") && en.body.includes("Mobile Connect"));

  // ── Service Worker / 兜底路由 / API 校验 ─────────────────────────────
  const sw = await get("/sw.js");
  check("sw: /sw.js 以 JS 下发", sw.status === 200 && sw.contentType.includes("javascript"), sw.contentType);

  const app503zh = await get("/app/", { "Accept-Language": "zh-CN" });
  check("app/: 未就绪 503", app503zh.status === 503);
  check("app/: 503 中文文案（Accept-Language 服务端判定）", app503zh.body.includes("界面资源代理未就绪"));
  const app503en = await get("/app/", { "Accept-Language": "en-US" });
  check("app/: 503 英文文案", app503en.body.includes("UI resource proxy not ready"));

  const badRoom = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "!!bad!!" }),
  });
  check("api/rooms: 坏 token 400", badRoom.status === 400);
  const goodRoom = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "abc234" }),
  });
  const roomJson = goodRoom.status === 200 ? await goodRoom.json() : {};
  check("api/rooms: 合法 token 200 + signalUrl 回执", goodRoom.status === 200 && roomJson.ok === true && String(roomJson.signalUrl).includes("/api/signal/abc234"));
} finally {
  cleanup();
  // wrangler/workerd 子进程可能吊住事件循环：SIGKILL 兜底 + 末尾显式 exit
  try { dev.kill("SIGKILL"); } catch { /* 已退出 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nWorker 冒烟汇总：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  for (const f of failed) console.error(`  失败：${f.name} ${f.detail}`);
  process.exit(1);
}
process.exit(0);
