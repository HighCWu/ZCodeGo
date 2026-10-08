# zcode-go

ZCode 官方 fork 的伴生桌面：接管官方 ZCode 的桌面 UI，底层原生运行时**始终调用官方安装的**（保 150% 额度），自身不构建运行时。也可作为独立 WebUI + 端点远端访问。

## 桌面接管（基础形态）

1. 在官方 ZCode 中安装本插件（`plugin/` 目录，本地市场）
2. 重启官方 ZCode
3. 在官方任意会话输入 `/zcode-go` → 官方窗口隐藏（任务栏消失、进程与会话全部存活），zcode-go 桌面接管
4. 要回到官方版：退出 zcode-go，再正常打开官方 ZCode（官方进程一直在后台存活，重新打开会唤回其窗口）

路径与开关（`~/.zcode-go/`）：
- `official.json` — 插件探测到的官方安装位置（bin / resourcesDir / runtimeBundle），跨平台自动发现
- `config.json` — 可选覆盖：`officialBin`、`zcodeGoLauncher`
- `takeover-state.json` — 接管状态（官方 PID 等）
- `DISABLE` — 存在即停用接管

## 快速启动（独立进程，不依赖桌面版）

```bash
cd /home/whc/pnpm_repos/zcode-go
ZCODE_WEB_STATIC_ROOT=$PWD/packages/web/dist PORT=7790 \
  node packages/server/dist/entry-http.js
```

启动后：
- **本机**：`http://127.0.0.1:7790/`（官方前端，多标签，快加载）
- **远端**：`https://zcode-go.aimon.win/remote/<端点>-<密码>/`
- 端点 ID 与密码见启动日志或 `GET /api/zcode-go/info`

## 运行时同构（额度保障）

zcode-go 桌面 spawn 底层运行时的方式与官方打包态**完全相同**（`ELECTRON_RUN_AS_NODE=1 <electron> zcode.cjs app-server --stdio`），唯一差异是 `zcodeAgentProcessManager` 优先读取 `~/.zcode-go/official.json` 的 `runtimeBundle`——实际执行的是官方安装的原生运行时，模型请求由官方运行时内部签名，额度无损。

## 复用官方 Electron（零第二发行版）

**不打包第二份 Electron**。加载机制（实测验证）：Electron 按 `<execPath>/../resources` 解析资源，加载顺序 `app.asar → app/ → default_app`；官方二进制 fuse 位 `11100011`（`RunAsNode=1`、**`AsarIntegrity=0`、`OnlyLoadAppFromAsar=0`**），允许从 `resources/app/` 加载自有应用。

`scripts/ensure-official-electron.mjs` 幂等装配 `~/.zcode-go/electron/`：

| 内容 | 方式 | 体积 |
|---|---|---|
| `zcode` 二进制 | 硬链接 → reflink → 复制 三级阶梯 | 0 / ≈0 / ~200MB |
| Chromium 资产（pak/locales/icudtl/so…） | 符号链接官方安装 | 0 |
| `resources/app/`（桌面构建 out/ + package.json） | 本仓库 tsup 产物 | 数 MB |

构建须带 `ZCODE_PREVIEW_IDENTITY=1`（preview 身份跳过远端强更门——`isPackaged=true` 后 production 身份会做强更检查）。Windows per-user 安装（LOCALAPPDATA 用户属主）可直接硬链接实现零字节；ext4 + root 安装退化为复制。launcher 已切换到此形态（打包态 renderer 从 `out/renderer/` 文件加载，不再依赖 vite）。

**任务栏图标**：与官方一致的机制——官方在 Linux 上也不设 `_NET_WM_ICON`，任务栏图标靠 `.desktop` 文件按 WM_CLASS 匹配。ensure 脚本会写 `~/.local/share/applications/zcode-go.desktop`（`StartupWMClass=ZCode Go`、`Icon=` 官方 512px 图标）并把官方 `icon.png` 等链入 `resources/`（窗口/Dock 图标源）。若任务栏未即时刷新，切换一次官方↔ZCode Go 或重载面板即可。

## 独立版分发（不签名策略）

独立完整桌面版（standalone 构建，见 CI `standalone-build.yml`）按**零成本分发**：
不做付费代码签名（mac Apple Developer / Windows 代码签名证书），代价与首次运行
绕过方法如下（正式 Prerelease 说明中应包含）：

- **macOS**（ad-hoc 签名）：首次打开被 Gatekeeper 拦截 → 右键 App →「打开」；
  或终端 `xattr -cr '/Applications/ZCode Go.app'` 后正常打开。
- **Windows**（未签名）：安装/运行时 SmartScreen 蓝色警告 →「更多信息」→
  「仍要运行」。
- **Linux**（AppImage/deb）：无签名要求；校验完整性用发布附带的 sha256。

## 移动端（手机扫码配对，P2P）

桌面端生成配对二维码 → 手机浏览器打开 Worker 容器页 → WebRTC DataChannel
P2P 直连（信令经 Cloudflare Worker + Durable Objects，UI 资源经 DataChannel
从桌面拉取，Worker 不托管任何 UI 资源）。默认信令服务为作者实例
`https://zcode-go.aimon.win`；自部署（含限频参数与 WAF 防洪配置留档）见
**[mobile-bridge/worker/DEPLOY.md](mobile-bridge/worker/DEPLOY.md)**。

## 多窗口与多端同步

- **「在新窗口打开会话」**（侧栏任务右键）：新窗口与首窗**共享同一个本地
  host**（与移动端桥同构的一个 host 多 UI 客户端）——侧边栏工作状态
  （运行中任务动态图标）与会话对话更新跨窗口实时同步；关闭首窗不影响
  其它窗口（host 引用计数，最后一窗关闭才回收）。
- **web/移动端「在新窗口打开」**：新浏览器标签页自动复用可用配对码
  （会话失效则自动刷新），经 `#zg-task=` 深链直达目标任务。
- **多端同会话**：桌面、Electron 新窗口、手机/浏览器远程端打开同一会话
  时共享同一条事件流，对话更新同时推送。

## 信令成本模型（安装即用，共享服务器零空闲流量）

无人使用 = 零流量：未打开移动端远程控制不创建会话；关闭对话框且无连接
5 分钟收摊；有客户端连接期间信令自动挂起（P2P 直连不经过服务器）；
客户端全部断开 30 分钟看门狗兜底。每次实际使用约 10–30 条请求，免费
额度可支撑数千次日配对。详见 DEPLOY.md「成本模型」章节。

## 构建

```bash
pnpm install && pnpm run build
```

`packages/server` 构建含 dist/（entry-http）；`packages/web` 构建含 dist/（前端静态文件）。

## Goal 完成复核（goal-keeper 标准版子集）

会话设置了 goal 后，运行时判定完成（goal 面板显示已验证）时，zcode-go 桌面会自动在**原会话内**追加一轮复核：向模型发送 GOAL 原文与 JSON 判定格式要求（判定轮带只读工具，模型可真实核查文件与 todo，与手动提问同构）。

- **未完成** → 解析出 `{"passed": false}` 后自动重触发 goal（运行时重置 active 并让模型继续推进，未完成的部分接着做）
- **已完成** → 追加一次二次确认（"为避免复杂项目误判请再认真判断一次"），两次通过才保持完成
- 复核消息在 UI 中隐藏（保留在会话存储中作为模型后续上下文）
- 全程走官方 v4 协议面，不修改运行时 goal 状态机，额度签名链路不受影响

配置（`~/.zcode-go/config.json`）：

```json
{
  "goalVerify": {
    "enabled": true,
    "maxRounds": 3
  }
}
```

`maxRounds` 限制同一 goal 的复核-重触发轮数（防循环，1–10）；`enabled=false` 停用。

## E2E 测试套件（零真人介入，CI 三平台）

四条假 Provider 真链 E2E（`scripts/e2e/`），全部 HOME 沙箱隔离（真实凭证物理
不可达，模型调用只可能打到本地假 Provider），CI 在 ubuntu/macos/windows 三
平台矩阵串跑（失败不中断，一次跑全量）：

| 脚本 | 验证链路 |
| --- | --- |
| `goal-verify-e2e.mjs` | goal 完成→复核判定→未完成重触发闭环（含判定消息落库） |
| `silent-fork-auto-e2e.mjs` | 压缩边界→静默点触发→自动 fork→redirect 落盘→尾部裁剪→原会话完好 |
| `lazy-history-e2e.mjs` | 巨会话冷打开→合成尾窗即时渲染→auto-open fork（种子双路径：本地真实库整段拷贝 / CI boot1 真实消息扩增） |
| `fresh-model-e2e.mjs` | fresh 环境双端模型自动勾选 + 桌面↔web 双向消息同步（本地 wrangler dev 信令 Worker + playwright chromium web 端，全部自包含） |

本地运行（Linux 需 Xvfb `:103`）：

```bash
node scripts/e2e/goal-verify-e2e.mjs        # 其余同理
```

改过源码先重建再跑（否则 E2E 打的是 `~/.zcode-go/electron` 里的旧 bundle，
结论不可信）：

```bash
pnpm --filter @zcode/desktop build:no-runtime-assets
node scripts/ensure-official-electron.mjs   # 按 mtime 同步产物
```

本地调试沙箱保留：失败自动保留现场（app.log / provider.log.jsonl /
wrangler.log）；`ZCODE_GO_E2E_KEEP_SANDBOX=1` 通过判据也保留。A 段失败时
自动截图（a-fail.png）+ renderer console 捕获输出。

## 已知问题：lazy-history 发送链（C/D）

A/B（合成尾窗渲染 + auto-open fork 落盘与裁剪）为硬判据全绿（CI 三平台 +
本地真实库拷贝/CI 扩增双种子路径均验证）。C（发送走 fork）/D（归并回写）
为诊断输出，产品链由单测（`zcodeGoSilentForkMerge`）与 goal E2E 发送路径
覆盖；剩余缺口是 CDP 输入交互时序（文本偶发未稳定落入 composer，脚本已带
5 次重试 + 熔断保护）。

> 排查教训（2026-10）：本地一度复现"会话区 `fault.subscription.recoveryFailed`
> 错误卡"，深挖后确认是 `~/.zcode-go/electron` 里**陈旧构建产物**——本地
> 改源码做实验前若不重建（`pnpm --filter @zcode/desktop build:no-runtime-assets`
> + `node scripts/ensure-official-electron.mjs`），E2E 跑的还是旧 bundle，
> 结论会被污染（CI 每次新鲜构建故始终全绿）。另注意 mtime 同步只增不删，
> `out/renderer/assets/` 会积累无引用的旧 chunk，属无害残留。

### windows fresh-model（CI 已知失败）

windows runner 上移动桥窗口不创建、"配对开始"后主进程 IPC 冻结
（<2min 干净失败 + 产物上传，不影响其余三条 E2E 与其它平台）。属
Electron/windows runner 深层问题，ubuntu/macos 全绿。
