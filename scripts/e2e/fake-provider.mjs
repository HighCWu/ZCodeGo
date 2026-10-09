#!/usr/bin/env node
/**
 * 本地假 OpenAI 兼容供应商（CI e2e 专用，零依赖）。
 *
 * 让官方运行时无需任何凭据即可创建会话、提交 prompt（hook 在 /zcode-go
 * 场景下 continue:false 拦截，模型实际不会被调用；本服务是"会话能建立"
 * 的兜底）。用法：
 *   node fake-provider.mjs --port-file <path>   # 监听 127.0.0.1 随机端口，
 *                                               # 实际端口写入该文件
 *
 * 可脚本化路由（goal 复核 / 静默 fork 等"真实模型行为"闭环）：
 *   --script <file>  JSON 数组 [{ "match": "<regex，对最后一条 user 消息全文>",
 *                                  "content": "<SSE 回复文本>" }, ...]
 *                    首个命中生效；缺省回落 "ok"。
 *   --log <file>     JSONL 请求日志（ts/url/文本前 8KB），供断言与调试。
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const portFile = arg("--port-file");
const scriptFile = arg("--script");
const logFile = arg("--log");

let cachedRoutes = [];
let routesMtimeMs = -1;
function loadRoutes() {
  // 热读：脚本可在运行中改写路由（E2E 分阶段驱动），按 mtime 失效
  if (!scriptFile || !existsSync(scriptFile)) return cachedRoutes;
  try {
    const mtime = statSync(scriptFile).mtimeMs;
    if (mtime !== routesMtimeMs) {
      cachedRoutes = JSON.parse(readFileSync(scriptFile, "utf8"));
      routesMtimeMs = mtime;
    }
  } catch {
    /* 解析失败保持旧路由 */
  }
  return cachedRoutes;
}

function logRequest(entry) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    /* 日志尽力而为 */
  }
}

/** 从 openai chat 请求体取最后一条 user 消息全文（路由判据）。 */
function lastUserText(body) {
  try {
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === "user") {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .map((p) => (p && typeof p.text === "string" ? p.text : ""))
            .join("\n");
        }
      }
    }
    // 无 user 消息（如纯 system 预检）→ 用全文兜底
    return body;
  } catch {
    return body;
  }
}

function routeResponse(userText) {
  for (const route of loadRoutes()) {
    try {
      if (route.match && new RegExp(route.match, "s").test(userText)) {
        return {
          content: typeof route.content === "string" ? route.content : "ok",
          // 可选整段 hold（ms）：撑开流式回合窗口（E2E 需在 turn 进行中做 UI 断言）
          delayMs: Number.isFinite(route.delayMs) && route.delayMs > 0 ? route.delayMs : 0,
        };
      }
    } catch {
      /* 非法正则跳过 */
    }
  }
  return { content: "ok", delayMs: 0 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "POST" && url.endsWith("/chat/completions")) {
    // 运行时走 SSE 流式 transport（非流式会被判 empty_model_response）
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const userText = lastUserText(body);
      const { content, delayMs } = routeResponse(userText);
      logRequest({ ts: Date.now(), url, text: userText.slice(0, 8192) });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const chunk = (delta) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-zcode-go-e2e",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "fake-model",
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`;
      // 客户端中断（turn 被 pause/stop abort）时静默收尾，不能让写挂死 provider。
      res.on("error", () => {});
      void (async () => {
        res.write(chunk({ role: "assistant" }));
        if (delayMs > 0) await sleep(delayMs);
        // 长回复按片下发（与真实流式同构；触发上下文膨胀用于 compaction）
        for (let i = 0; i < content.length; i += 200) {
          res.write(chunk({ content: content.slice(i, i + 200) }));
        }
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-zcode-go-e2e",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "fake-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: Math.max(1, Math.ceil(content.length / 4)), total_tokens: 2 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      })();
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
