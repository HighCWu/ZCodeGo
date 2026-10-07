#!/usr/bin/env node
// 延迟版假供应商：响应前等待 DELAY_MS（默认 5000），便于 E2E 观察运行中状态。
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const portFile = arg("--port-file");
const DELAY = Number(arg("--delay", 5000));

const completion = {
  id: "chatcmpl-zcode-go-e2e",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "fake-model",
};

const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "POST" && url.endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta) =>
          `data: ${JSON.stringify({
            id: completion.id,
            object: "chat.completion.chunk",
            created: completion.created,
            model: "fake-model",
            choices: [{ index: 0, delta, finish_reason: null }],
          })}\n\n`;
        res.write(chunk({ role: "assistant" }));
        res.write(chunk({ content: "ok" }));
        res.write(
          `data: ${JSON.stringify({
            id: completion.id,
            object: "chat.completion.chunk",
            created: completion.created,
            model: "fake-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }, DELAY);
    });
  } else if (req.method === "GET" && url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  if (portFile) writeFileSync(portFile, String(port));
  else console.log(String(port));
});
