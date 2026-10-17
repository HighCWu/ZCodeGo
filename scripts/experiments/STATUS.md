# 记忆压缩试验——交接状态（v5 定版已达标）

## 目标与定版结果
提示词诱导的模型特定编码。**v5 定版：R_token=0.152（27/178 tokens），
无编码上下文独立新会话解码必答 8/8（两次会话一致）**。
定版密文：`2:187(40/50/10)18;弓日11/15;12/1>20;运营李婷`（弓日=张明拆字代号）。

## 调用通路（已打通）
官版 CLI headless：`ELECTRON_RUN_AS_NODE=1 /opt/ZCode/zcode
/opt/ZCode/resources/glm/zcode.cjs -p "<prompt>"`（wrapper /tmp/zcode-cli-headless）。
PATH 上的 zcode 是 Electron 桌面启动器（-p 会静默退出），这才是真实 CLI。

## 协议要点（v5，scripts/experiments/memory-compress-v5.mjs）
- gzip 类比定性（不承担对抗保密）——「外部观察者完全无法读懂」的对抗表述
  触发模型元认知拒绝（「无共享密钥无法兼顾」），措辞是成败关键
- 字符集白名单（禁韩文/盲文/生僻字——tokenizer 拆 2-4 token/字）
- 数字边界强制分隔；长实体（编号/邮箱）授权丢弃；反馈补缺失（结构保持）
- 脚本内置 GLM-5.3-Flash tokenizer 校验（/tmp/glm-tokenizer.json +
  python tokenizers）

## 报告
/tmp/mc-report-v5.md（定版）、v4/v2/nonsense/md（演进对照）、
可视化 mc-data.json + memory-compress-token-audit.html（会话可视化目录）。

## 后续可做（未做）
- 10%（18 tokens）硬冲：单位词（万/个月）有 ~2 tokens 可省，需更细反馈
- 跨模型对照 G（员工 modelSelection 多模型路径）
- 协议产品化（opc-memory-compress.ts 按定版参数重写 encodePrompt）——等拍板
