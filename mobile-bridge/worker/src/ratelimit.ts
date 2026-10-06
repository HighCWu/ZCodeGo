/**
 * 强一致限频（Durable Object，按 key 分片）。
 *
 * 背景：Workers 原生 ratelimit binding（unsafe.bindings）在本账号生产环境
 * 实测 fail-open（25 连打 5/min 桶零拦截，疑似未激活即恒放行）——攻击面
 * 判定不能寄托在它身上。这里用自有 DO 实现固定窗口计数：强一致、跨计划
 * 可用、按 idFromName(key) 天然分片（每 IP 一个 DO 实例，无全局热点）。
 * 原生 binding 保留为外层第二道（若日后激活则更早拦截）。
 */
import { DurableObject } from "cloudflare:workers";

export class RateLimiter extends DurableObject {
  /** 机会性清理的操作计数（内存态，休眠唤醒清零无妨）。 */
  private ops = 0;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/check") return new Response("not found", { status: 404 });
    const bucket = (url.searchParams.get("bucket") ?? "").replace(/[^a-z-]/g, "").slice(0, 32);
    const limit = Math.max(1, Math.min(10_000, Number(url.searchParams.get("limit")) || 5));
    const windowMs = Math.max(
      1_000,
      Math.min(3_600_000, (Number(url.searchParams.get("window")) || 60) * 1000),
    );
    const now = Date.now();
    type Record = { c: number; resetAt: number };
    const rec = (await this.ctx.storage.get<Record>(bucket)) ?? { c: 0, resetAt: 0 };
    if (now > rec.resetAt) {
      rec.c = 0;
      rec.resetAt = now + windowMs;
    }
    rec.c += 1;
    await this.ctx.storage.put(bucket, rec);
    // 防 storage 无界增长：每 256 次操作扫一遍，清掉过期超 1 小时的桶。
    this.ops += 1;
    if (this.ops >= 256) {
      this.ops = 0;
      const snapshot = now;
      void this.ctx.storage
        .list()
        .then(async (all) => {
          const expired: string[] = [];
          for (const [key, value] of all) {
            const r = value as Record;
            if (!r?.resetAt || snapshot > r.resetAt + 3_600_000) expired.push(key);
          }
          if (expired.length > 0) await this.ctx.storage.delete(expired);
        })
        .catch(() => {});
    }
    return Response.json({ allowed: rec.c <= limit, count: rec.c });
  }
}
