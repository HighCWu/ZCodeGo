# zcode-go

ZCode 官方 fork 的伴生桌面：接管官方 ZCode 的桌面 UI，底层原生运行时**始终调用官方安装的**（保 150% 额度），自身不构建运行时。也可作为独立 WebUI + 端点远端访问。

## 桌面接管（基础形态）

1. 在官方 ZCode 中安装本插件（`plugin/` 目录，本地市场）
2. 重启官方 ZCode
3. 在官方任意会话输入 `/zcode-go` → 官方窗口隐藏（任务栏消失、进程与会话全部存活），zcode-go 桌面接管
4. zcode-go 内点"返回官方版"（或关闭窗口）→ 官方窗口回来，右下角出现圆形悬浮气泡
5. 点气泡 → 随时回到 zcode-go

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
