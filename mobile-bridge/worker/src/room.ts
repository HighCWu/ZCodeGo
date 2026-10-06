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

// ── 滥用防护参数 ──
// 单帧上限：SDP offer 压缩后数 KB、解压后数十 KB，1MB 是极宽裕的上限，
// 超限即断连（防巨型帧耗 DO CPU/内存）。
const MAX_MESSAGE_BYTES = 1_000_000;
// 每连接消息速率：滑窗计数，超限断连（防单连接洪泛 ping/bad_json 刷
// invocation 计费）。窗口状态存内存——Hibernation 唤醒后清零可接受：
// 重置后攻击者需重新付出建连成本（入口层已有连接限频）。
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 120;
// mobile 并发上限：官方语义多客户端并发（手机 + 浏览器多开）实际是个位数；
// 知道 token 者开任意多条 WS 会触发 desktop 无限开桥窗口。
const MAX_MOBILE_CLIENTS = 4;

interface SignalWire {
  t: string;
  // capability secret（防抢答信箱；对端身份认证由 DTLS 承担）
  p?: unknown;
  // offer id（两级 pairing：QR 只带 id，offer 经 mailbox 取回）
  i?: unknown;
  // 请求标记：多客户端并发时 req-offer 的应答 offer 按此路由回请求方
  r?: unknown;
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
  /** req-offer 的 r 标记 → 请求方 socket（offer 应答按此路由；答后即删）。 */
  private readonly pendingOfferReplies = new Map<string, WebSocket>();

  /** 每连接速率滑窗（socket 序号 → 窗口状态）。内存态，休眠唤醒即清零。 */
  private readonly rateWindows = new Map<WebSocket, { count: number; resetAt: number }>();

  private send(ws: WebSocket, message: SignalWire): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  /** 滥用防护：单连接消息速率滑窗。超限 close（4005）。 */
  private rateLimit(ws: WebSocket): boolean {
    const now = Date.now();
    let win = this.rateWindows.get(ws);
    if (!win || now > win.resetAt) {
      // 窗口过期回收顺手清理已关闭连接的残留项（防 Map 无界增长）。
      if (this.rateWindows.size > 128) {
        for (const [key] of this.rateWindows) {
          if (key.readyState !== WebSocket.OPEN) this.rateWindows.delete(key);
        }
      }
      win = { count: 0, resetAt: now + RATE_WINDOW_MS };
      this.rateWindows.set(ws, win);
    }
    win.count += 1;
    if (win.count > RATE_MAX_MESSAGES) {
      ws.close(4005, "rate limited");
      return false;
    }
    return true;
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
    // 登记探活（Worker 入口 POST）：创建 DO 实例并落房间计时；未过期时滑动
    // 续期——桌面端会话存续期间每 2 分钟心跳，二维码长期可扫，桌面停止心跳
    // 后 TTL 自然到期回收。
    if (request.method === "POST") {
      // 登记探活（Worker 入口 POST，仅桌面端发起）：无条件落/续房间计时——
      // 桌面端会话存续期间每 2 分钟心跳，二维码长期可扫；桌面停止心跳后
      // TTL 自然到期回收。已过期房间收到桌面心跳即复活（桌面网络中断恢复
      // 后自愈，无需重新生成二维码；secret 持久在 storage，旧 QR 仍可配对）。
      await this.ctx.storage.put(ROOM_CREATED_AT_KEY, Date.now());
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.has("role")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 400 });
      }
      const role = url.searchParams.get("role") === "mobile" ? "mobile" : "desktop";
      if (await this.isRoomExpired()) {
        // 垃圾房间回收：过期且从未有 desktop 注册 secret（随机 token 闯入的
        // 房间）→ 清空 storage（createdAt 等），防刷随机 token 留下持久存储
        // 费用；真实房间（有 secret）保留，维持「断网恢复后心跳复活」语义。
        const secret = await this.ctx.storage.get<string>(ROOM_SECRET_KEY);
        if (!secret) await this.ctx.storage.deleteAll();
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

      const existingMobile = this.socketsFor("mobile").filter((s) => s.readyState === WebSocket.OPEN);
      if (existingMobile.length >= MAX_MOBILE_CLIENTS) {
        // 知道 token 者开任意多条 WS 会触发 desktop 无限开桥窗口——并发封顶。
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [tag]);
        this.send(pair[1], { t: "error", data: { code: "too_many_clients" } });
        pair[1].close(4003, "too many clients");
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      // 多客户端并发（官方语义：手机 + 桌面浏览器同时连接）——不再拒绝
      // 第二个页面；desktop 侧按 req-offer 的 r 标记为每个客户端分配独立
      // 桥窗口/offer，answer 按 offer id 路由到对应窗口。
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
    if (raw.length > MAX_MESSAGE_BYTES) {
      // 巨型帧直接断连（SDP 实际数 KB~数十 KB，1MB 上限极宽裕）。
      ws.close(4004, "message too large");
      return;
    }
    if (!this.rateLimit(ws)) return;
    let message: SignalWire;
    try {
      message = JSON.parse(raw) as SignalWire;
    } catch {
      this.send(ws, { t: "error", data: { code: "bad_json" } });
      return;
    }
    const tag = this.ctx.getTags(ws)[0] ?? "";
    const isDesktop = tag.endsWith(":desktop");
    // ping（30s 保活）不打日志：防攻击者刷日志费用，也让信令日志聚焦。
    if (message.t !== "ping") {
      console.log("[room] msg", JSON.stringify({ kind: message.t, from: isDesktop ? "desktop" : "mobile", size: raw.length }));
    }
    switch (message.t) {
      // ── 保活：桌面端每 30s ping，防 NAT 空闲超时把信令 WS 变成半开连接
      //（桌面据此检测 pong 超时并重建连接）。──
      case "ping": {
        this.send(ws, { t: "pong" });
        return;
      }
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
        // mobile 凭 secret 取 offer（QR 路径 / 多客户端并发）。转发给 desktop，
        // 由其为请求方分配独立桥窗口并推送 offer；r 标记用于应答路由。
        void this.authorize(ws, message.p).then((ok) => {
          if (!ok) {
            this.send(ws, { t: "error", data: { code: "bad_secret" } });
            return;
          }
          const desktop = this.socketsFor("desktop")[0];
          if (desktop?.readyState === WebSocket.OPEN) {
            const r = typeof message.r === "string" ? message.r.slice(0, 64) : "";
            if (r) {
              if (this.pendingOfferReplies.size > 64) this.pendingOfferReplies.clear();
              this.pendingOfferReplies.set(r, ws);
            }
            this.send(desktop, { t: "req-offer", i: message.i, r });
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
        // desktop → 请求方（req-offer 的回应；r 路由到发起请求的 mobile）。
        if (!isDesktop) return;
        const r = typeof message.r === "string" ? message.r : "";
        const requester = r ? this.pendingOfferReplies.get(r) : undefined;
        if (r) this.pendingOfferReplies.delete(r);
        const mobile =
          requester && requester.readyState === WebSocket.OPEN
            ? requester
            : this.socketsFor("mobile")[0];
        if (mobile?.readyState === WebSocket.OPEN) {
          this.send(mobile, { t: "offer", i: message.i, r, data: message.data });
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
    this.rateWindows.delete(ws);
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
