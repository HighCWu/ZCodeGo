/**
 * zcode-go 移动端 E2E（本地/真机套件，CI 不跑）：验证「桌面浏览器响应式 +
 * 左滑抽屉侧栏 + 移动首屏空会话」与 Worker 容器页（配对卡片/资源进度/交接）。
 *
 * 前置（与本会话历史用法一致）：
 *   1. Xvfb :103 + E2E 实例：
 *      ZCODE_GO_TAKEOVER=1 ZCODE_DESKTOP_APPLICATION_NAME="ZCode Go E2E" \
 *        DISPLAY=:103 nohup ~/.zcode-go/electron/zcode \
 *        --user-data-dir=/tmp/zgbridge/second-profile --remote-debugging-port=9333 \
 *        > /tmp/zgbridge/e2e-instance.log 2>&1 &
 *   2. node scripts/e2e/cdp-pair.cjs 产配对 URL（stdout 的 QR-URL 行）
 *   3. node scripts/e2e/mobile-drawer.mjs "<qr-url>"
 *
 * 断言：初始抽屉屏外 + composer 16px + 头部侧栏按钮；按钮展开抽屉
 * （x=0、宽 min(85vw,20rem)、灰背板、任务行）；选任务后抽屉收起回会话。
 * 依赖 playwright-core（仓库 node_modules）+ /usr/bin/google-chrome。
 */
// 移动端「桌面浏览器响应式 + 左滑抽屉侧栏」验证
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// 仓库内 playwright-core（避免绝对路径，随仓库走）
const playwrightEntry = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "playwright-core", "index.mjs",
);
const { chromium, devices } = await import(playwrightEntry);
const QR = process.argv[2];
if (!QR) { console.error("usage: node mobile-drawer-e2e.mjs <qr-url>"); process.exit(3); }
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: false, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "zh-CN" });
const page = await ctx.newPage();
await page.goto(QR, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 50; i += 1) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => {
    const fs = document.querySelectorAll("iframe");
    if (!fs.length) return { f: 0 };
    const d = fs[fs.length - 1].contentDocument;
    if (!d || !d.body || !d.body.innerText.trim()) return { f: 0 };
    return { f: 1, loading: !!d.querySelector("[data-testid=root-startup-loading]") };
  }).catch(() => ({ f: 0 }));
  if (st.f && !st.loading) break;
}
await page.waitForTimeout(1500);

const readState = () => page.evaluate(() => {
  const d = document.querySelector("iframe").contentDocument;
  const panel = d.querySelector("[data-workspace-sidebar-panel]");
  const r = panel.getBoundingClientRect();
  const backing = panel.querySelector(":scope > div[aria-hidden]");
  const toggle = d.querySelector('[data-testid="workspace-sidebar-toggle"]');
  const editable = d.querySelector('[contenteditable="true"]');
  const rows = d.querySelectorAll('li[data-testid*="task-item"]');
  return {
    drawer: { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height), pos: getComputedStyle(panel).position },
    hasBacking: !!backing,
    backingBg: backing ? getComputedStyle(backing).backgroundColor : null,
    toggle: { present: !!toggle, label: toggle?.getAttribute("aria-label") },
    scrimPresent: d.querySelectorAll('button[aria-label="隐藏侧边栏"]').length > 0,
    desktopHeader: !!d.querySelector('[data-testid="workspace-header"]'),
    mobileShellHeader: !!d.querySelector('[data-mobile-page="chat"]'),
    overlayBtns: d.querySelectorAll('[data-testid="desktop-top-nav-back"]').length,
    composer: { present: !!editable, fs: editable ? getComputedStyle(editable).fontSize : null },
    taskRows: rows.length,
    vw: d.defaultView.innerWidth,
  };
}).catch((e) => ({ err: String(e) }));

// ── 首屏：抽屉默认收起，会话/composer 直接可见 ──
const initial = await readState();
console.log("INITIAL:", JSON.stringify(initial, null, 1));
await page.screenshot({ path: "/tmp/zgbridge/drawer-initial.png" });

// ── 点头部侧栏按钮 → 抽屉滑出 ──
await page.evaluate(() => {
  const d = document.querySelector("iframe").contentDocument;
  d.querySelector('[data-testid="workspace-sidebar-toggle"]').click();
});
let opened = null;
for (let i = 0; i < 40; i += 1) {
  await page.waitForTimeout(500);
  opened = await readState();
  if (opened.drawer.x === 0 && opened.taskRows > 0) break;
}
console.log("OPENED:", JSON.stringify({ ...opened, taskRows: undefined, taskRowCount: opened.taskRows }, null, 1));
await page.screenshot({ path: "/tmp/zgbridge/drawer-open.png" });

// ── 点任务行 → 抽屉收起，进入会话 ──
await page.evaluate(() => {
  const d = document.querySelector("iframe").contentDocument;
  d.querySelectorAll('li[data-testid*="task-item"]')[0].click();
});
let closed = null;
for (let i = 0; i < 12; i += 1) {
  await page.waitForTimeout(500);
  closed = await readState();
  if (closed.drawer.x <= -(closed.drawer.w - 2)) break;
}
// 会话异步连接，composer 晚于抽屉收起出现；单独等待。
for (let i = 0; i < 20 && closed && !closed.composer.present; i += 1) {
  await page.waitForTimeout(800);
  closed = await readState();
}
console.log("CLOSED:", JSON.stringify({ x: closed.drawer.x, w: closed.drawer.w, composerFs: closed.composer.fs }, null, 0));
await page.screenshot({ path: "/tmp/zgbridge/drawer-closed-task.png" });
await browser.close();

const checks = {
  initialClosed: initial.drawer.x <= -(initial.drawer.w - 2),
  initialComposer: initial.composer.present && initial.composer.fs === "16px",
  initialToggle: initial.toggle.present,
  desktopHeader: initial.desktopHeader && !initial.mobileShellHeader && initial.overlayBtns === 0,
  backing: initial.hasBacking && opened.hasBacking,
  openedX0: opened.drawer.x === 0,
  openedWidth: opened.drawer.w >= initial.vw * 0.8,
  openedRows: opened.taskRows > 0,
  closedX: closed.drawer.x <= -(closed.drawer.w - 2),
  closedComposer: closed.composer.fs === "16px",
};
console.log("CHECKS:", JSON.stringify(checks));
const ok = Object.values(checks).every(Boolean);
console.log(ok ? "DRAWER-OK ✓（默认收起空会话 + 头部按钮展开 + 灰背板 + 选任务收起）" : "DRAWER-FAIL ✗");
process.exit(ok ? 0 : 2);
