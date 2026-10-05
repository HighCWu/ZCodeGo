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
