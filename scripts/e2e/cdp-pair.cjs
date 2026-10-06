/**
 * CDP 配对助手：连到 E2E 实例（--remote-debugging-port=9333）触发移动桥
 * 配对，stdout 打印 PAIRING-URL / QR-URL 行（mobile-drawer.mjs 的输入）。
 */
// CDP：在真实应用 renderer 里触发移动桥配对，轮询拿 pairingUrl。
const http = require("node:http");

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: 9333, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}

async function main() {
  const targets = await getJson("/json/list");
  const page = targets.find((t) => t.type === "page" && t.title === "ZCode");
  if (!page) throw new Error("主页面 target 未找到");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const call = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expression, awaitPromise = true) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    }
    return r.result ? r.result.result : null;
  };

  const start = await evalJs("window.zcode ? window.zcode.zcodeGoMobileBridgeStart().then(s => JSON.stringify(s)) : 'no-zcode'");
  console.log("START:", JSON.stringify(start.value));
  // 轮询 pairingUrl（offer 预生成 ~8s）
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const status = await evalJs("window.zcode.zcodeGoMobileBridgeGetStatus().then(s => JSON.stringify(s))");
    const parsed = JSON.parse(status.value);
    if (parsed.pairingUrl) {
      console.log("PAIRING-URL:", parsed.pairingUrl);
      console.log("QR-URL:", parsed.qrUrl);
      ws.close();
      return;
    }
    process.stdout.write("state=" + parsed.state + " ");
  }
  console.log("\nTIMEOUT: pairingUrl 未出现");
  ws.close();
  process.exit(1);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
