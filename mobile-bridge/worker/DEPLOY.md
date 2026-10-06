# zcode-go 移动桥 Worker 自部署指南

自部署移动端配对服务（信令 DO + 容器页 + Service Worker），不依赖作者实例。
桌面端配对二维码默认指向 `https://zcode-go.aimon.win`（作者自有部署），
自部署后通过下文「桌面端指向」切换到你的 Worker。

## 前置条件

- 一个托管在 Cloudflare 的域名（zone），任意计划（Free 可用）
- Node.js ≥ 20 与 npm
- 已 `npx wrangler login` 登录的 Cloudflare 账号

## 部署步骤

```bash
cd mobile-bridge/worker
npm install
# 1) 把 wrangler.toml 里的自定义域换成你的域名：
#    routes = [ { pattern = "bridge.example.com", custom_domain = true } ]
npx wrangler deploy
```

部署自动完成：Durable Object 迁移（SignalRoom v1 / RateLimiter v2）、
三个限频 binding、自定义域路由绑定。后续更新重跑 `npx wrangler deploy` 即可。

## 桌面端指向你的 Worker

任选其一（优先级从高到低）：

1. 环境变量：`ZCODE_GO_SIGNALING_ORIGIN=https://bridge.example.com`
2. `~/.zcode-go/config.json`：

   ```json
   { "mobileBridge": { "signalingOrigin": "https://bridge.example.com" } }
   ```

3. 都不配则回退默认 `https://zcode-go.aimon.win`。

## 限频架构（三层，参数留档）

```
Internet
  ↓
① Cloudflare WAF 速率限制规则（边缘粗防洪，省 Worker 调用配额）
  ↓
② Workers ratelimit binding（早期拒绝；GA 语义 permissive/最终一致/per-数据中心，
   突发会过冲——定位是拦持续滥用，不做精确计数）
  ↓
③ RateLimiter Durable Object（强一致权威限流，精确计数，拦突发）
  ↓
业务（SignalRoom 信令房间）
```

### ② wrangler.toml 限频 binding 参数

| binding | 命中路径 | limit | period | 说明 |
|---|---|---:|---:|---|
| `ROOM_CREATE_LIMIT` | POST /api/rooms | 5 | 60 | 房间登记（桌面心跳 1 次/2min，余量充足） |
| `SIGNAL_CONNECT_LIMIT` | /api/signal/:token | 30 | 60 | 信令 WS 连接（多客户端+重连余量） |
| `PAGE_LIMIT` | / 与 /sw.js | 120 | 60 | 容器页/SW（防 invocation 配额刷量） |

注意：GA 语法 `[[ratelimits]]` 需 wrangler ≥ 4.36；`period` 仅允许 `10` 或 `60`；
`namespace_id` 需账号内唯一（跨 Worker 共享同名 namespace 会共享计数器）。

### ③ RateLimiter DO 参数（src/ratelimit.ts）

- 固定窗口计数，按 `bucket:ip` 经 `idFromName` 分片（每 IP 一个 DO 实例，无全局热点）
- 与 binding 同阈值同桶名；每 256 次操作机会性清理过期超 1 小时的桶（防 storage 无界）

### SignalRoom DO 滥用防护参数（src/room.ts）

| 参数 | 值 | 触发行为 |
|---|---:|---|
| 单帧消息上限 | 1 MB | close 4004 message_too_large |
| 每连接速率 | 120 msg / 10s | close 4005 rate limited |
| mobile 并发 | 4 连接 | close 4003 too_many_clients |
| 垃圾房间回收 | 过期且从未注册 secret | storage.deleteAll（真房间保「断网复活」） |

## ① Cloudflare WAF 速率限制规则（推荐配置）

直达入口（把 `:account`/`:zone` 换成你的）：

```
https://dash.cloudflare.com/?to=/:account/:zone/security/security-rules
```

面板路径：域名 zone → 安全（Security）→ WAF → 速率限制规则（Rate limiting rules）→ 创建规则。

**Free 套餐**（仅 1 条规则、统计窗口固定 10 秒、阻止时长固定 10 秒、按 IP 计数）：

| 字段 | 值 |
|---|---|
| 规则名称 | `zcode-go api 兜底` |
| 表达式（Edit expression） | `(starts_with(http.request.uri.path, "/api/"))` |
| 具有相同特征 | IP |
| 请求速率 | 10 请求 / 10 秒 |
| 操作 | 阻止（Block） |
| 持续时间 | 10 秒 |

语义提示：`10/10s` 是短窗口洪泛保护，允许匀速 ~60/min 穿透——业务精确限额
（rooms 5/min 等）由上面 ③ 权威执行，本规则只负责在 Worker 之前挡爆发流量、
省 invocation 配额。计数为 per-数据中心，非全局。

**付费套餐**可放宽窗口时建议改为 `60 请求 / 1 分钟`，其余同上。

可选（免费、不占规则数）：安全 → 机器人（Bots）→ 开启 **Bot Fight Mode**，
无浏览器特征的脚本客户端会被边缘直接 403。

## 验证清单

```bash
# Worker 功能冒烟（本地 wrangler dev --local，15 项断言：容器页 i18n/样式/
# 交接逻辑、sw.js、/app/ 503、/api/rooms 校验）
node scripts/e2e/worker-smoke.mjs

# 生产限频验证（注意：DO 层精确计数需在单窗口内并发触发；
# 串行慢打会跨窗口重置，binding 层对突发本就 permissive——这是官方语义，
# 不代表失效。判别 binding 是否计数需间隔 ≥2.5s 串行请求观察原始返回）
```

WAF 规则生效验证：10 秒内并发打 `/api/*` 超过 10 次，应看到 Cloudflare
拦截页且 `npx wrangler tail` 中 Worker 调用归零。
