#!/usr/bin/env node
/**
 * 本地假 OpenAI 兼容供应商（CI e2e 专用，零依赖）。
 *
 * 让官方运行时无需任何凭据即可创建会话、提交 prompt（hook 在 /zcode-go
 * 场景下 continue:false 拦截，模型实际不会被调用；本服务是"会话能建立"
 * 的兜底）。用法：
 *   node fake-provider.mjs --port-file <path>   # 监听 127.0.0.1 随机端口，
 *                                               # 实际端口写入该文件
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const portFile = arg("--port-file");

const completion = {
  id: "chatcmpl-zcode-go-e2e",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "fake-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "POST" && url.endsWith("/chat/completions")) {
    // 运行时走 SSE 流式 transport（非流式会被判 empty_model_response）
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
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
