/**
 * zcode-go E2E：web 远程「在新窗口打开会话」（自动配对码 + 深链）。
 *
 * 验证：
 *  1. 手机/浏览器远程会话右键任务 → 在新窗口打开 → 弹出新标签页，
 *     URL 为「可用配对码 + #zg-task= 深链」（会话活着时复用同一配对码）；
 *  2. 新标签页作为第二客户端独立完成配对并启动应用；
 *  3. 深链初始会话被 App 领取：目标任务行 bg-selected；
 *  4. 原标签页连接不受影响（未触发 stop+start 重建）。
 *
 * 用法：node scripts/e2e/web-new-window-e2e.mjs <qr-url>
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const playwrightEntry = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "playwright-core", "index.mjs",
);
const { chromium } = await import(playwrightEntry);
const QR = process.argv[2];
if (!QR) { console.error("usage: node web-new-window-e2e.mjs <qr-url>"); process.exit(3); }

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: false, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 800 } });
const page1 = await context.newPage();
await page1.goto(QR, { waitUntil: "domcontentloaded" });

const waitBoot = async (page) => {
  for (let i = 0; i < 60; i += 1) {
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
};
await waitBoot(page1);

// 右键第一个任务行 → 上下文菜单 → 在新窗口打开
const row = page1.frameLocator("iframe").locator('li[data-testid^="task-item-"]').first();
const rowTestId = await row.getAttribute("data-testid");
const taskId = rowTestId.replace("task-item-", "");
console.log("target task:", taskId);
await row.click({ button: "right" });
const menuItem = page1.frameLocator("iframe").getByText("在新窗口打开", { exact: true }).first();
await menuItem.waitFor({ state: "visible", timeout: 8000 });

// 捕获 window.open 弹出的新标签页
const popupPromise = context.waitForEvent("page", { timeout: 15000 });
await menuItem.click();
const page2 = await popupPromise;
await page2.waitForLoadState("domcontentloaded");
// 异步配对码返回后才导航：等 about:blank → worker URL
for (let i = 0; i < 30; i += 1) {
  if (!page2.url().includes("about:blank")) break;
  await page2.waitForTimeout(500);
}
const url2 = page2.url();
console.log("popup url head:", url2.slice(0, 90));
const hasDeepLink = url2.includes("#zg-task=");
console.log("deep-link-in-url:", hasDeepLink);

// 新标签页作为第二客户端完整启动
await waitBoot(page2);
const result = await page2.evaluate((tid) => {
  const d = document.querySelector("iframe").contentDocument;
  const w = document.querySelector("iframe").contentWindow;
  const rowEl = d.querySelector(`li[data-testid="task-item-${tid}"]`);
  const selected = d.querySelector('li[class*="bg-selected"]');
  return {
    selectedRow: selected ? selected.getAttribute("data-testid") : null,
    initialTask: !!w.__ZCODE_GO_INITIAL_TASK__,
    initialTaskId: w.__ZCODE_GO_INITIAL_TASK__ ? String(w.__ZCODE_GO_INITIAL_TASK__.taskId) : null,
    hashCleared: !String(w.location.hash || "").includes("zg-task"),
    rowActive: rowEl ? rowEl.className.includes("bg-selected") : null,
    composer: !!d.querySelector('[contenteditable="true"]'),
  };
}, taskId).catch((e) => ({ err: String(e) }));
console.log("PAGE2:", JSON.stringify(result, null, 1));

// 原标签页仍活着（未因刷新配对码被拆）
const alive = await page1.evaluate(() => {
  const d = document.querySelector("iframe") && document.querySelector("iframe").contentDocument;
  return !!d && !!d.querySelector('[contenteditable="true"]');
}).catch(() => false);
console.log("PAGE1-ALIVE:", alive);
// 失败诊断：容器页状态行/阶段/meta（无控制台也能看到卡点）
const diag = await page2.evaluate(() => {
  const g = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
  return { status: g("status-text"), hint: g("hint"), meta: g("meta"), progress: g("progress") };
}).catch((e) => ({ err: String(e) }));
console.log("PAGE2-DIAG:", JSON.stringify(diag));

const pass = hasDeepLink && result.initialTask && result.initialTaskId === taskId &&
  result.hashCleared && result.rowActive === true && alive;
console.log(pass ? "WEB-NEW-WINDOW-OK ✓" : "WEB-NEW-WINDOW-FAIL ✗");
await browser.close();
process.exit(pass ? 0 : 1);
