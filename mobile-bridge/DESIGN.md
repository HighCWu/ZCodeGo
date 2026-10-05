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

成本：桌面桥从单 PC 改 PC 池（约百行）；新 tab 需一次轻量重握手（每条 PC 是
独立加密身份——DTLS 证书与 ICE 凭据不可跨页面移交，浏览器安全模型使然），
但打洞的网络成果会自动复用（NAT 映射存活 + STUN 结果相同）：首个 tab 建链
1-3s，同浏览器后续 tab 通常亚秒；信令请求量每 tab 增加约 60 条（免费额度内
忽略不计）。


## 信令面定稿：out-of-band offer + minimal return signaling（2026-10-05 评审后）

定义（评审建议的表述，直接作为阶段 2 设计基础）：

- 桌面端在 ICE gathering 完成后生成完整 non-trickle SDP offer，嵌入短期
  配对 URL。手机本地解出 offer，无需初始信令往返即开始协商。
- Worker 仅保留为最小回传通道（answer mailbox）：转发手机的完整 answer，
  不逐条转发 ICE candidate。协议 = REGISTER(room, p) / ANSWER(room, p,
  answer, offer_id)；ack 由 WebRTC connectionState=connected 充当。
- 两级 pairing：复制链接 = t+p+完整 offer（direct 最快路径）；二维码 =
  t+p+offer_id（体积小，扫码后经 mailbox 取 offer——与多 tab 的 req-offer
  是同一条消息，只维护一套状态机）。
- 桌面预生成 offer：进入配对 UI 即开始 gathering，扫码/点击到达时 offer
  已就绪（消除 non-trickle 的桌面侧等待）。
- 配对 URL 是 capability URL：offer 含双方本地/公网 IP 与 STUN 配置，属
  敏感短期材料；新鲜度与 srflx 映射寿命绑定（「刷新二维码」= 重新生成
  offer）。p= 是 capability secret（防抢答信箱），对端身份认证由 DTLS
  指纹承担。
- libp2p 的取舍（2026-10-05 二轮评审后精确化）：`webRTCDirect()` 不适合
  （要求桌面公网 UDP 可达）；`webRTC()` 网络层面支持 NAT 后双端，但其
  Circuit Relay v2 是完整 libp2p 协议栈（Noise + yamux + 长驻连接），
  CF Worker 免费层跑不了——需要一台公网 VPS 跑 relay，与本项目「零基础设施
  成本」的第一约束直接冲突；且其 transport 的 SDP 握手深度绑定 relay 流，
  信令层不可插拔（换信令 = fork 维护）。本场景拓扑为 1:1 自有设备短连接，
  mux 由 DataChannel 多 label 覆盖、认证由 DTLS 承担，libp2p 生态无买点。
  结论：原生 WebRTC + 自定义信令面。若未来拓扑演变（多设备网格/第三方
  peer），届时在应用层引入 libp2p 是加法而非重写。不用 STUN early-data /
  SDP munging / 公网 UDP 监听；NAT 穿透仍由标准 ICE/STUN 栈负责（无 TURN，
  成功率由 NAT 类型决定，本方案不改变穿透面）。
- 风险清单与验收：两端均 non-trickle（手机侧 answer gathering 约 0.5s
  量级）；总建链时延须 benchmark（信令轮转省下 vs gathering 前置），阶段 2
  先 A/B 并存两种模式，按 NAT 矩阵（家宽↔Wi-Fi / 家宽↔5G / 公司网↔5G /
  CGNAT↔CGNAT）实测消息量、offer→connected 时延、成功率后再删旧路径。
