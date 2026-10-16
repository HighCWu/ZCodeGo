/**
 * zcode-go 试验 HTTP 接口（spec「已知边界」的替代通路设计）：
 * 外部脚本（记忆压缩试验、指纹探测采集）经 localhost HTTP 提交 prompt，
 * main 转发给 renderer 的临时会话执行器（IZCodeTaskService 编排器同款），
 * 回复按 prompt 契约写入 .opc/exp/<tag>.json，本服务轮询读回作为响应。
 *
 * 安全门控：env ZCODE_GO_EXP_HTTP=1 才启动；仅绑定 127.0.0.1；fileTag
 * 白名单字符（拒绝路径穿越）。
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserWindow } from "electron";

const EXP_DIR = join(
  process.env.ZCODE_GO_E2E_HOME ?? join(homedir(), ".zcode"),
  "opc",
  "exp",
);
const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ZcodeGoExpLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

let server: Server | null = null;

/** 转发执行请求给 renderer（所有窗口广播；桥接 hook 按 workspacePath 自选）。 */
function forwardToRenderer(payload: {
  requestId: string;
  workspacePath: string;
  content: string;
  fileTag: string;
}): boolean {
  let delivered = false;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("zcode-go:exp-run-prompt", payload);
      delivered = true;
    } catch {
      /* 忽略单窗投递失败 */
    }
  }
  return delivered;
}

function waitForSample(
  filePath: string,
  timeoutMs: number,
): Promise<{ ok: boolean; text: string | null; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      try {
        if (existsSync(filePath)) {
          const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
          const text = (parsed as { text?: unknown }).text;
          if (typeof text === "string" && text.length > 0) {
            resolve({ ok: true, text, timedOut: false });
            return;
          }
        }
      } catch {
        /* 半写 JSON：继续轮询 */
      }
      if (Date.now() >= deadline) {
        resolve({ ok: false, text: null, timedOut: true });
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}

export function initZcodeGoExpServer(logger: ZcodeGoExpLogger): void {
  if (process.env.ZCODE_GO_EXP_HTTP !== "1" || server) return;
  server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/exp/prompt")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body) as {
          workspacePath?: string;
          content?: string;
          timeoutMs?: number;
        };
        const workspacePath = parsed.workspacePath
          ? resolve(parsed.workspacePath)
          : join(process.cwd(), "workspace");
        const content = parsed.content ?? "";
        const fileTag = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (!content || !/^[a-z0-9-]+$/.test(fileTag)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad request" }));
          return;
        }
        mkdirSync(join(workspacePath, ".opc", "exp"), { recursive: true });
        if (
          !forwardToRenderer({
            requestId: fileTag,
            workspacePath,
            content,
            fileTag,
          })
        ) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "no window" }));
          return;
        }
        const timeoutMs = Math.min(
          parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          300_000,
        );
        const sample = await waitForSample(
          join(workspacePath, ".opc", "exp", `${fileTag}.json`),
          timeoutMs,
        );
        res.writeHead(sample.ok ? 200 : 504, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify(
            sample.ok
              ? { ok: true, text: sample.text }
              : { ok: false, error: "timeout" },
          ),
        );
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server?.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // 端口写文件供试验脚本发现（仅本机回环）
    try {
      mkdirSync(EXP_DIR, { recursive: true });
      writeFileSync(join(EXP_DIR, "http-port"), String(port));
    } catch {
      /* 尽力而为 */
    }
    logger.info("[zcode-go] 试验 HTTP 接口就绪", { port });
  });
  server.on("error", (error) => {
    logger.warn("[zcode-go] 试验 HTTP 接口启动失败", error);
    server = null;
  });
}
