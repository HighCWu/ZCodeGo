---
description: 查看 OPC 公司状态摘要（只读，不消耗模型 token）
argument-hint: "[help | add <标题>]"
---

## 中文

`/opc`：打印当前工作区的 OPC 公司摘要——公司名、在职员工、看板各列计数、待所有者处理的升级项、最近进化事件。由插件 hook 直接读 `<工作区>/.opc/company.json`，**不消耗模型 token**。

只读命令：不修改任何状态（公司状态的唯一写路径在 ZCode Go 桌面 main 进程）。

子命令：`/opc help` — 数据源与用法说明；`/opc add <标题>` — 投递一条入站（写入 .opc/inbox/，ZCode Go 桌面面板一键转工作项；同样零 token）。

## English

`/opc`: print an OPC company summary for the current workspace — company name, active employees, kanban counts, escalations pending owner review, and the latest evolution event. Handled directly by the plugin hook reading `<workspace>/.opc/company.json`; consumes no model tokens. Read-only.

Subcommands: `/opc help`; `/opc add <title>` — drop an inbound item (written to .opc/inbox/, convertible to a work item in the ZCode Go desktop panel; also zero-token).

---

本命令由插件 hook 直接处理，不会消耗任何模型 token。/ This command is
handled directly by the plugin hook and consumes no model tokens.

$ARGUMENTS
