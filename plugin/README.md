# zcode-go 插件

官方 ZCode 的桌面接管入口。输入 `/zcode-go` 切换到 ZCode Go 桌面；退出 ZCode Go、重开官方 ZCode 即切回。

## 安装

**方式一（推荐）：官方插件市场粘贴 GitHub 仓库**

1. 官方 ZCode → 侧边栏「插件市场」→「添加」→「添加插件市场」
2. 粘贴 `HighCWu/ZCodeGo`（或完整 GitHub URL）
3. 在 zcode-go 卡片点「安装」
4. **重启官方 ZCode**（插件 hook 需重启后才注册——未重启时 `/zcode-go` 不会生效）

**方式二（本地开发）：plugins.dirs 直挂**

在 `~/.zcode/cli/config.json` 的 `plugins.dirs` 加入本仓库 `plugin/` 目录，重启官方即发现（改动即时生效，无需重装）。本地开发不走发布 zip：OPC 模板包由 `packs` 子命令惰性拉取（见下）。

## 分发与 OPC 模板包

市场安装走 **url-zip 发布链**：`.github/workflows/release-plugin.yml` 从用户 fork 拉取 OPC 模板包
（`scripts/opc/fetch-opc-packs.mjs`），注入 `plugin/opc-packs/`（已 gitignore）后打成
`zcode-go-plugin.zip` 发布到**固定 tag 的 release**（`plugin-v<版本>`），并把根
`marketplace.json` 的条目改写为 `{source:"url", type:"zip", url, sha256}` 后推送——官方安装器
对 url 来源强制要求 `type:"zip"` + `sha256` 且下载后校验（bundle 实证），zip 资产每次发布
都会变，所以市场清单必须由发布流程逐版本更新；**安装那一刻模板包已随包落地**，
官方机制无安装期脚本也不需要。

接管（`/zcode-go`）与手动 `node hooks/zcode-go.cjs packs` 都会把插件内置包镜像到
`~/.zcode-go/opc-packs/`（pack.json 版本戳相同则跳过）；本地开发目录无内置包时，自动
后台惰性拉取仓库的 fetch 脚本（fire-and-forget，网络失败静默降级为内置 24 角色 + 16 技能）。
**更新插件 = 重跑 release-plugin 工作流**（zip 内 packs 版本戳变化会被镜像逻辑识别替换）。

## 使用

在官方**任意会话**输入 `/zcode-go`：

- ZCode Go 桌面拉起（底层原生运行时与官方打包态完全同构）
- 官方 ZCode 自动退出（接管即独占；磁盘上的会话与官方安装完全共享）
- 要回到官方版：退出 ZCode Go，再正常打开官方 ZCode

其他命令：`/zcode-go status`（探测与开关状态）、`/zcode-go off|on`（停用/启用）。

另有 **`/opc`**：打印当前工作区的 OPC 公司摘要（在职员工/看板计数/待处理升级/最近进化事件）——hook 直接读 `<工作区>/.opc/company.json`，只读、零 token；数据由 ZCode Go 桌面（specs/opc-mode.md）维护。

## 底层运行时与额度

ZCode Go 桌面 spawn 底层原生运行时的方式与官方打包态完全相同，且**优先使用本插件探测到的官方运行时**（`~/.zcode-go/official.json`，由 hook 在官方进程树内自动发现）——模型请求由官方运行时内部签名，150% 额度无损。

## 文件（均在 `~/.zcode-go/`）

| 文件                  | 用途                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `official.json`       | 探测到的官方安装（bin / resourcesDir / runtimeBundle），插件自动写入 |
| `config.json`         | 可选覆盖：`zcodeGoLauncher`（ZCode Go 启动器路径）、`officialBin`    |
| `takeover-state.json` | 接管状态，ZCode Go 桌面维护                                          |
| `DISABLE`             | 存在即停用接管                                                       |
| `plugin.log`          | 排障日志                                                             |
