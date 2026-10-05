# zcode-go 插件

官方 ZCode 的桌面接管入口。安装后：

1. **重启官方 ZCode**（使插件 hook 生效）
2. 在官方**任意会话**输入：

   ```
   /zcode-go
   ```

3. 官方窗口自任务栏消失（官方进程与在跑会话全部存活），ZCode Go 桌面接管
4. 要回到官方版：退出 ZCode Go，再正常打开官方 ZCode（官方进程一直在后台存活，重新打开会唤回其窗口）

其他命令：`/zcode-go status`（探测与开关状态）、`/zcode-go off|on`（停用/启用）。

## 底层运行时与额度

ZCode Go 桌面 spawn 底层原生运行时的方式与官方打包态完全相同，且**优先使用本插件探测到的官方运行时**（`~/.zcode-go/official.json`，由 hook 在官方进程树内自动发现）——模型请求由官方运行时内部签名，150% 额度无损。

## 文件（均在 `~/.zcode-go/`）

| 文件 | 用途 |
|---|---|
| `official.json` | 探测到的官方安装（bin / resourcesDir / runtimeBundle），插件自动写入 |
| `config.json` | 可选覆盖：`zcodeGoLauncher`（ZCode Go 启动器路径）、`officialBin` |
| `takeover-state.json` | 接管状态（官方 PID 等），ZCode Go 桌面维护 |
| `DISABLE` | 存在即停用接管 |
| `plugin.log` / `takeover.log` | 排障日志 |

## 安装（本地开发市场）

```bash
# 在 zcode-go 仓库内
node scripts/sync-plugin.mjs
```

然后在官方 ZCode：**插件市场 → 添加 → 粘贴** `<workspace>/plugins` 目录 →
**个人 → dev-<…> → zcode-go → 安装** → 重启官方 ZCode。
