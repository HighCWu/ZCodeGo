/**
 * 信令房间（Durable Object，WebSocket Hibernation）。
 *
 * 一次性配对：一个房间恰好 desktop/mobile 各一个连接；任一方断开即通知对方。
 * 信令消息（SDP/ICE）原样转发。
 *
 * Hibernation 关键约束：DO 休眠唤醒后实例字段全部丢失，连接状态必须每次从
 * ctx.getWebSockets() 按 tag（<roomId>:<role>）动态查询，不持有 WebSocket 引用。
 */
import { DurableObject } from "cloudflare:workers";

const ROOM_TTL_MS = 5 * 60_000;
const ROOM_CREATED_AT_KEY = "createdAt";
const ROOM_SECRET_KEY = "pairingSecret";

interface SignalWire {
  t: string;
  // capability secret（防抢答信箱；对端身份认证由 DTLS 承担）
  p?: unknown;
  // offer id（两级 pairing：QR 只带 id，offer 经 mailbox 取回）
  i?: unknown;
  data?: unknown;
}

/** 时序安全比较（Workers 无 timingSafeEqual，用双 hash 摘要比对）。 */
async function secretMatches(stored: string | undefined, presented: string): Promise<boolean> {
  if (!stored) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(stored)),
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

export class SignalRoom extends DurableObject {
  private send(ws: WebSocket, message: SignalWire): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  private socketsFor(role: "desktop" | "mobile"): WebSocket[] {
    return this.ctx.getWebSockets(`${this.ctx.id.name}:${role}`);
  }

  private async isRoomExpired(): Promise<boolean> {
    const createdAt = (await this.ctx.storage.get<number>(ROOM_CREATED_AT_KEY)) ?? null;
    if (createdAt === null) {
      await this.ctx.storage.put(ROOM_CREATED_AT_KEY, Date.now());
      return false;
    }
    return Date.now() - createdAt > ROOM_TTL_MS;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // 登记探活（Worker 入口 POST）：创建 DO 实例并落房间计时（storage 持久，休眠不丢）。
    if (request.method === "POST") {
      await this.isRoomExpired();
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.has("role")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 400 });
      }
      const role = url.searchParams.get("role") === "mobile" ? "mobile" : "desktop";
      if (await this.isRoomExpired()) {
        const expired = new WebSocketPair();
        this.ctx.acceptWebSocket(expired[1], [`${this.ctx.id.name}:${role}`]);
        this.send(expired[1], { t: "error", data: { code: "room_expired" } });
        expired[1].close(4001, "room expired");
        return new Response(null, { status: 101, webSocket: expired[0] });
      }

      const tag = `${this.ctx.id.name}:${role}`;
      if (role === "desktop") {
        // 新 desktop 顶替旧的（桌面端重新生成配对码复用房间名时兜底）。
        for (const old of this.socketsFor("desktop")) old.close(4002, "replaced");
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [tag]);
        const mobile = this.socketsFor("mobile")[0];
        this.send(pair[1], {
          t: "joined",
          data: { role: "desktop", mobileOnline: mobile?.readyState === WebSocket.OPEN },
        });
        if (mobile?.readyState === WebSocket.OPEN) {
          this.send(mobile, { t: "peer-joined", data: { role: "desktop" } });
        }
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      const existingMobile = this.socketsFor("mobile")[0];
      if (existingMobile && existingMobile.readyState === WebSocket.OPEN) {
        // 单手机页限制（沿用官方 relay 语义）：旧页占用即拒绝新页。
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [tag]);
        this.send(pair[1], { t: "error", data: { code: "session_conflict" } });
        pair[1].close(4003, "conflict");
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [tag]);
      const desktop = this.socketsFor("desktop")[0];
      this.send(pair[1], {
        t: "joined",
        data: { role: "mobile", desktopOnline: desktop?.readyState === WebSocket.OPEN },
      });
      if (desktop?.readyState === WebSocket.OPEN) {
        this.send(desktop, { t: "peer-joined", data: { role: "mobile" } });
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") return;
    let message: SignalWire;
    try {
      message = JSON.parse(raw) as SignalWire;
    } catch {
      this.send(ws, { t: "error", data: { code: "bad_json" } });
      return;
    }
    const tag = this.ctx.getTags(ws)[0] ?? "";
    const isDesktop = tag.endsWith(":desktop");
    console.log("[room] msg", JSON.stringify({ kind: message.t, from: isDesktop ? "desktop" : "mobile", size: raw.length }));
    switch (message.t) {
      // ── 新信令面（阶段 2）：answer mailbox ──
      case "register": {
        // desktop 声明 capability secret，后续 answer/req-offer 凭此放行。
        if (!isDesktop) return;
        const secret = typeof message.p === "string" ? message.p : "";
        if (!secret) {
          this.send(ws, { t: "error", data: { code: "bad_register" } });
          return;
        }
        void this.ctx.storage.put(ROOM_SECRET_KEY, secret).then(() => {
          this.send(ws, { t: "registered" });
        });
        return;
      }
      case "req-offer": {
        // mobile 凭 secret 取 offer（QR 路径 / 多 tab）。转发给 desktop，由其
        // 推送 offer；迟到或伪造的请求因 secret 校验挡在门外。
        void this.authorize(ws, message.p).then((ok) => {
          if (!ok) {
            this.send(ws, { t: "error", data: { code: "bad_secret" } });
            return;
          }
          const desktop = this.socketsFor("desktop")[0];
          if (desktop?.readyState === WebSocket.OPEN) {
            this.send(desktop, { t: "req-offer", i: message.i });
          } else {
            this.send(ws, { t: "error", data: { code: "desktop_offline" } });
          }
        });
        return;
      }
      case "answer": {
        // phone → mailbox → desktop：完整 non-trickle answer（阶段 2 核心）。
        void this.authorize(ws, message.p).then((ok) => {
          if (!ok) {
            this.send(ws, { t: "error", data: { code: "bad_secret" } });
            return;
          }
          const desktop = this.socketsFor("desktop")[0];
          if (desktop?.readyState === WebSocket.OPEN) {
            this.send(desktop, { t: "answer", i: message.i, data: message.data });
            this.send(ws, { t: "answer-accepted" });
          } else {
            this.send(ws, { t: "error", data: { code: "desktop_offline" } });
          }
        });
        return;
      }
      case "offer": {
        // desktop → 请求方（req-offer 的回应）。
        if (!isDesktop) return;
        const mobile = this.socketsFor("mobile")[0];
        if (mobile?.readyState === WebSocket.OPEN) {
          this.send(mobile, { t: "offer", i: message.i, data: message.data });
        }
        return;
      }
      // ── legacy trickle 转发（A/B 对照，阶段 2 实测后移除）──
      case "signal": {
        const target = (isDesktop ? this.socketsFor("mobile") : this.socketsFor("desktop"))[0];
        if (target?.readyState === WebSocket.OPEN) {
          this.send(target, { t: "signal", data: message.data });
        }
        return;
      }
      default:
        return;
    }
  }

  private async authorize(ws: WebSocket, presented: unknown): Promise<boolean> {
    if (typeof presented !== "string" || !presented) return false;
    const stored = await this.ctx.storage.get<string>(ROOM_SECRET_KEY);
    return secretMatches(stored, presented);
  }

  override webSocketClose(ws: WebSocket): void {
    // 一次性配对：任一方离开即通知另一方（连接由 runtime 自动摘除）。
    const role = (this.ctx.getTags(ws)[0] ?? "").endsWith(":desktop") ? "desktop" : "mobile";
    const peer = (role === "desktop" ? this.socketsFor("mobile") : this.socketsFor("desktop"))[0];
    if (peer?.readyState === WebSocket.OPEN) {
      this.send(peer, { t: "peer-left" });
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }
}
