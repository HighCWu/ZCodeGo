// ICE 调试：并发双客户端复刻「在新窗口打开」——钩 RTCPeerConnection 抓状态/候选
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const playwrightEntry = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "playwright-core", "index.mjs",
);
const { chromium } = await import(playwrightEntry);
const QR = process.argv[2];
if (!QR) { console.error("usage: node ice-debug.mjs <qr-url>"); process.exit(3); }
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: false, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 800 } });

await context.addInitScript(() => {
  window.__wsLog = [];
  const OrigWS = window.WebSocket;
  window.WebSocket = function (url, ...rest) {
    const ws = new OrigWS(url, ...rest);
    const tag = String(url).slice(-30);
    ws.addEventListener("message", (ev) => {
      try { window.__wsLog.push("<-" + tag + " " + String(ev.data).slice(0, 80)); } catch (e) {}
    });
    const origSend = ws.send.bind(ws);
    ws.send = (d, ...r) => {
      try { window.__wsLog.push("->" + tag + " " + String(d).slice(0, 80)); } catch (e) {}
      return origSend(d, ...r);
    };
    return ws;
  };
  window.RTCPeerConnection = window.RTCPeerConnection; // keep
  window.__iceLog = [];
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = function (cfg, ...rest) {
    const pc = new Orig(cfg, ...rest);
    const entry = { states: [], iceStates: [], localCands: [], remoteCands: [] };
    window.__iceLog.push(entry);
    pc.addEventListener("connectionstatechange", () => entry.states.push(pc.connectionState));
    pc.addEventListener("iceconnectionstatechange", () => entry.iceStates.push(pc.iceConnectionState));
    pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate && ev.candidate.candidate) entry.localCands.push(ev.candidate.candidate);
    });
    const origSet = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async (desc, ...r) => {
      const out = await origSet(desc, ...r);
      try {
        if (desc && desc.sdp) {
          entry.remoteCands = desc.sdp.split("\n").filter((l) => l.startsWith("a=candidate:")).map((l) => l.trim());
        }
      } catch (e) {}
      return out;
    };
    return pc;
  };
});

const waitConnected = async (pg, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await pg.waitForTimeout(2000);
    if (await pg.evaluate(() => !!document.querySelector("iframe")).catch(() => false)) return true;
    const st = await pg.evaluate(() => document.getElementById("status-text")?.textContent ?? "").catch(() => "");
    if (st.includes("无法建立")) return false;
  }
  return false;
};
const dump = (pg) => pg.evaluate(() => {
  const log = (window.__iceLog || []).map((e) => ({
    states: e.states,
    iceStates: e.iceStates,
    localTypes: e.localCands.map((c) => (c.match(/typ (\w+)/) || [])[1] + (c.includes(".local") ? "+mdns" : "")),
    remoteTypes: e.remoteCands.map((c) => (c.match(/typ (\w+)/) || [])[1] + (c.includes(".local") ? "+mdns" : "")),
  }));
  const g = (id) => document.getElementById(id)?.textContent ?? null;
  return { status: g("status-text"), meta: g("meta"), log };
}).catch((e) => ({ err: String(e) }));

const page1 = await context.newPage();
await page1.goto(QR, { waitUntil: "domcontentloaded" });
const c1 = await waitConnected(page1, 100000);
console.log("client1 connected:", c1);

// 复刻 UI「在新窗口打开」的弹窗路径（about:blank → 导航）
const popupPromise = context.waitForEvent("page", { timeout: 30000 }).catch(() => null);
await page1.evaluate((url) => {
  const tab = window.open("about:blank", "_blank");
  if (tab) {
    try { tab.opener = null; } catch (e) {}
    tab.location.href = url + "#zg-task=" + encodeURIComponent(JSON.stringify({ taskId: "x", workspacePath: "/tmp" }));
  } else {
    console.log("popup blocked");
  }
}, QR).catch((e) => console.log("open err:", String(e)));
const page2 = await popupPromise;
if (!page2) { console.log("NO POPUP"); await browser.close(); process.exit(1); }
for (let i = 0; i < 20; i += 1) {
  if (!(await page2.url().includes("about:blank"))) break;
  await page2.waitForTimeout(500);
}
const c2 = await waitConnected(page2, 120000);
console.log("client2 connected:", c2);
console.log("CLIENT2-DUMP:", JSON.stringify(await dump(page2), null, 1));
const ws1 = await page1.evaluate(() => (window.__wsLog || []).slice(-15)).catch(() => []);
console.log("PAGE1-WS:", JSON.stringify(ws1, null, 1));
const ws2 = await page2.evaluate(() => (window.__wsLog || []).slice(-25)).catch(() => []);
console.log("PAGE2-WS:", JSON.stringify(ws2, null, 1));
await browser.close();
process.exit(0);
