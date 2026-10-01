---
description: 切换到 ZCode Go 桌面（隐藏官方窗口，官方原生运行时保额度；气泡可切回）
argument-hint: "[status | off | on]"
---

`/zcode-go`（无参数）：切换到 ZCode Go 桌面接管——官方窗口自任务栏隐藏（进程与会话全部存活），ZCode Go 桌面接管 UI；其内点"返回官方版"或关闭窗口即可切回，切回后右下角有圆形悬浮气泡可随时再进入。

子命令：
- `/zcode-go status` — 查看官方安装探测结果与接管开关状态
- `/zcode-go off` / `/zcode-go on` — 停用 / 启用接管

本命令由插件 hook 直接处理，不会消耗任何模型 token。

$ARGUMENTS
