// 抽屉退出过渡期点击穿透专项验证（手机侧远程 UI）：
// 开抽屉 → 关抽屉 → 动画进行中(60ms)在底部按钮区 elementFromPoint，
// 命中必须仍在抽屉面板内（指针屏蔽保持），动画结束(>240ms)后才放行。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const playwrightEntry = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "playwright-core", "index.mjs",
);
const { chromium, devices } = await import(playwrightEntry);
const QR = process.argv[2];
if (!QR) { console.error("usage: node drawer-throughput-e2e.mjs <qr-url>"); process.exit(3); }
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

const probe = () => page.evaluate(async () => {
  const d = document.querySelector("iframe").contentDocument;
  const toggle = d.querySelector('[data-testid="workspace-sidebar-toggle"]');
  const panel = d.querySelector("[data-workspace-sidebar-panel]");
  if (!toggle || !panel) return { error: "no-toggle-or-panel" };
  toggle.click();                                    // 开
  await new Promise((r) => setTimeout(r, 450));
  const rect = panel.getBoundingClientRect();
  const pt = { x: rect.left + rect.width / 2, y: rect.bottom - 60 };
  const hitAt = () => {
    const el = d.elementFromPoint(pt.x, pt.y);
    return { inDrawer: !!(el && panel.contains(el)), desc: el ? el.tagName + ":" + String(el.className).slice(0, 30) : "null" };
  };
  const openHit = hitAt();
  toggle.click();                                    // 关：200ms 退出动画开始
  await new Promise((r) => setTimeout(r, 60));       // 动画进行中
  const midHit = hitAt();
  await new Promise((r) => setTimeout(r, 400));      // 动画结束后（240ms 门控已过）
  const lateHit = hitAt();
  const pass = openHit.inDrawer && midHit.inDrawer && !lateHit.inDrawer;
  return { openHit, midHit, lateHit, pass };
});
const r = await probe();
console.log("THROUGHPUT:", JSON.stringify(r, null, 1));
await browser.close();
process.exit(r && r.pass ? 0 : 1);
