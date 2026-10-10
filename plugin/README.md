# zcode-go 插件

官方 ZCode 的桌面接管入口。输入 `/zcode-go` 切换到 ZCode Go 桌面；退出 ZCode Go、重开官方 ZCode 即切回。

## 安装

**方式一（推荐）：官方插件市场粘贴 GitHub 仓库**

1. 官方 ZCode → 侧边栏「插件市场」→「添加」→「添加插件市场」
2. 粘贴 `HighCWu/ZCodeGo`（或完整 GitHub URL）
3. 在 zcode-go 卡片点「安装」
4. **重启官方 ZCode**（插件 hook 需重启后才注册——未重启时 `/zcode-go` 不会生效）

**方式二（本地开发）：plugins.dirs 直挂**

在 `~/.zcode/cli/config.json` 的 `plugins.dirs` 加入本仓库 `plugin/` 目录，重启官方即发现（改动即时生效，无需重装）。

## 使用

在官方**任意会话**输入 `/zcode-go`：

- ZCode Go 桌面拉起（底层原生运行时与官方打包态完全同构）
- 官方 ZCode 自动退出（接管即独占；磁盘上的会话与官方安装完全共享）
- 要回到官方版：退出 ZCode Go，再正常打开官方 ZCode

其他命令：`/zcode-go status`（探测与开关状态）、`/zcode-go off|on`（停用/启用）。

## 底层运行时与额度

ZCode Go 桌面 spawn 底层原生运行时的方式与官方打包态完全相同，且**优先使用本插件探测到的官方运行时**（`~/.zcode-go/official.json`，由 hook 在官方进程树内自动发现）——模型请求由官方运行时内部签名，150% 额度无损。

## 文件（均在 `~/.zcode-go/`）

| 文件 | 用途 |
|---|---|
| `official.json` | 探测到的官方安装（bin / resourcesDir / runtimeBundle），插件自动写入 |
| `config.json` | 可选覆盖：`zcodeGoLauncher`（ZCode Go 启动器路径）、`officialBin` |
| `takeover-state.json` | 接管状态，ZCode Go 桌面维护 |
| `DISABLE` | 存在即停用接管 |
| `plugin.log` | 排障日志 |
