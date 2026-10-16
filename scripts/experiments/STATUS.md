# 记忆压缩试验——交接状态（上下文压缩后续接用）

## 目标
用提示词诱导的模型特定编码压缩员工记忆（奇怪字符、R<1、同模型可解码），
模型指纹锁定解码方。协议纯函数已就绪：packages/shared/src/opc/opc-memory-compress.ts。

## 已就绪
- 试验脚本 scripts/experiments/memory-compress.mjs（三策略 + R/F 评测 + 报告）
- 桌面试验 HTTP 接口（已合入 0c64a66e）：ZCODE_GO_EXP_HTTP=1 启动桌面 →
  POST /exp/prompt {workspacePath, content} → 临时会话执行 → 轮询 .opc/exp/<tag>.json
- split-half 自洽、进化事件统一合并（c9ef951d）

## 卡点与正确路径（用户定版）
- zcode -p headless 在本机秒退（待查；非本试验阻塞）
- **正确启动 = 经插件**：官版 zcode 装 zcode-go 插件（plugins.dirs → 仓库 plugin/）→
  会话输入 /zcode-go → 插件编排接管（桌面实例运行 zcode-go 代码，
  认识 zcodeGoTakeoverCloseOfficial 键）→ closeOfficial=false 共存 →
  ~/.zcode/opc/exp/http-port 出现 → 跑试验脚本 --http
- 直接 spawn ~/.zcode-go/electron/zcode 绕过插件编排 = 异常/秒退（教训）
- 官版进程会剥掉 setting.json 的未知键（zcodeGoTakeoverCloseOfficial 是
  插件 patch 注入键）——外部改盘写该键无效

## 待跑
node scripts/experiments/memory-compress.mjs --http http://127.0.0.1:<port> --samples 3 --out /tmp/mc-report.md
把报告的 encodedPreview/F 数据带回迭代协议。
