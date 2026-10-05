---
description: 切换到 ZCode Go 桌面接管（Switch to ZCode Go desktop takeover）
argument-hint: "[status | off | on]"
---

## 中文

`/zcode-go`（无参数）：切换到 ZCode Go 桌面接管——官方窗口自任务栏隐藏（官方进程与在跑会话全部存活），ZCode Go 桌面接管 UI。

要回到官方版：退出 ZCode Go，再正常打开官方 ZCode 即可（官方进程一直在后台存活，重新打开会唤回其窗口）。

子命令：
- `/zcode-go status` — 查看官方安装探测结果与接管开关状态
- `/zcode-go off` / `/zcode-go on` — 停用 / 启用接管

## English

`/zcode-go` (no arguments): switch to the ZCode Go desktop — the official window is hidden from the taskbar while the official process and all running sessions stay alive.

To go back to the official app: quit ZCode Go, then launch official ZCode as usual (the official process stays alive in the background; launching it restores its window).

Subcommands: `/zcode-go status` (detection & switch state), `/zcode-go off` / `/zcode-go on` (disable / enable takeover).

---

本命令由插件 hook 直接处理，不会消耗任何模型 token。/ This command is
handled directly by the plugin hook and consumes no model tokens.

$ARGUMENTS
