# zcode-go 移动端桥（阶段 1）

WebRTC P2P：手机（容器页）↔ 桌面（隐藏桥窗口）。Cloudflare Worker 只做信令
（Durable Object 一次性房间）与 KB 级容器页托管。UI 资源与 RPC 后续阶段经
DataChannel 从桌面推送（版本天然对齐、服务器零托管压力）。

## 组件

- `worker/`（Cloudflare Worker，独立 wrangler 项目）
  - `POST /api/rooms`：桌面登记房间（token 格式校验 + 懒创建 DO）
  - `GET /api/signal/:token?role=`：DO WebSocket（信令中继，消息原样转发）
  - `GET /`：容器页（信令 → answer 侧 → DataChannel echo 验证；P2P 失败显示
    「无法建立 P2P 连接。当前网络可能限制了 WebRTC，请尝试切换 Wi-Fi / 蜂窝
    网络或关闭 VPN。」——无 TURN，明确提示换网络）
- 桌面 main `zcodeGoMobileBridge.ts`：
  - token 生成（[a-z2-9]{8}）→ 登记房间 → 信令 WebSocket（desktop 角色）
  - 隐藏桥窗口（nodeIntegration，内容本地生成）持有 RTCPeerConnection
    （offer 侧）与三条 DataChannel：`zcode-go-control` / `-rpc` / `-resource`
  - 信令 ↔ 桥窗口经 ipcRenderer 双向转发；任一端断开即整体回收
- 配对 URL：`<signalingOrigin>/#<token>`；signalingOrigin 取
  `~/.zcode-go/config.json` 的 `mobileBridge.signalingOrigin`（dev 用
  `ZCODE_GO_SIGNALING_ORIGIN` env 覆盖，指向 `wrangler dev` 的 localhost）。

## 阶段 1 验收

wrangler dev + zcode-go 桌面生成 token → 手机浏览器打开配对 URL → 双方
DataChannel open → 容器页输入文字回显 `echo:...`（桥窗口 control 通道回环）。


## 多 tab 通信（定稿：每 tab 独立连接，无 hub）

初版设计的 hub-spoke（首个 tab 持 PeerConnection，其余 tab 经
BroadcastChannel 中继）有一个移动端致命缺陷：hub tab 被关闭/被 iOS 后台
冻结时，所有 tab 一起断连——移动端后台杀 tab 是高概率事件。

定稿方案（每 tab 平等，互不依赖）：

- **每 tab 一条独立 PeerConnection**：桌面桥窗口维护连接池（每连接独立的
  control/rpc/resource DataChannels，ipcRenderer 转发带连接 id），任一 tab
  关闭/冻结只断自己。
- **配对票据经 localStorage 传递**：首个 tab 配对成功后把房间 token 写入
  localStorage；「在新窗口打开」的新 tab 读取 token → 自行连信令 → 独立建
  链（1-3s ICE 延迟）。同源限制即安全边界（用户自己的浏览器）。
- **信令房间改多连接**：mobile 侧从单连接改为上限 N（4），desktop 在线期间
  房间存活（TTL 跟随 desktop 连接而非固定 5 分钟）；desktop 断开销毁房间。
- **共享的只有 SW 缓存**：UI 静态资源多 tab 直接命中 Cache Storage，不产生
  额外桌面流量。
- BroadcastChannel 不再承担传输，仅保留给未来的 tab 间轻协调（如列表刷新
  提示；侧栏同步已有轮询兜底，非必需）。

成本：桌面桥从单 PC 改 PC 池（约百行）；新 tab 多一次信令握手与 ICE 建链
（秒级）；信令请求量每 tab 增加约 60 条（免费额度内忽略不计）。
