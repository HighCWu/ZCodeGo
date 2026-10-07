// 强制刷新配对会话（stop→start→轮询新 pairingUrl）。target 精确选 title==="ZCode"。
const http = require("node:http");
function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: 9333, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}
(async () => {
  const targets = await getJson("/json/list");
  const page = targets.find((t) => t.type === "page" && t.title === "ZCode");
  if (!page) throw new Error("ZCode 主窗口未找到: " + JSON.stringify(targets.map(t => t.title)));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result?.result?.value;
  };
  await ev("window.zcode.zcodeGoMobileBridgeStop()");
  await new Promise((r) => setTimeout(r, 2000));
  await ev("window.zcode.zcodeGoMobileBridgeStart()");
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 1200));
    const st = await ev("window.zcode.zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))");
    const parsed = JSON.parse(st);
    if (parsed.pairingUrl) { console.log("QR-URL:", parsed.qrUrl || parsed.pairingUrl); process.exit(0); }
    process.stdout.write("state=" + parsed.state + " ");
  }
  console.error("TIMEOUT");
  process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
