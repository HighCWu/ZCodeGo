# 记忆压缩试验——交接状态（四版试验已完成，结论沉淀于 spec）

## 目标
提示词诱导的模型特定编码：把记忆压成无意义乱码（R<10%），同模型可解码，
模型指纹锁定解码方。产物：scripts/experiments/memory-compress{,-v2,-v3,-v4}.mjs
协议纯函数：packages/shared/src/opc/opc-memory-compress.ts。

## 调用通路（已打通）
官版 CLI headless：`ELECTRON_RUN_AS_NODE=1 /opt/ZCode/zcode
/opt/ZCode/resources/glm/zcode.cjs -p "<prompt>"`（wrapper /tmp/zcode-cli-headless）。
PATH 上的 zcode 是 Electron 桌面启动器（-p 会静默退出），这才是真实 CLI。

## 核心结论（GLM 默认模型，276 字符/10 事实样本）
1. **纯随机映射不可行**（F=0；模型元认知拒绝：「需要保留私有映射或密钥」）。
2. **无意义化与浓缩不冲突**（gzip 同理）；模型自发产出 gzip-b64 掩护结构、
   盲文私有编码、ROT13 成体系代号——「模型特定编码」机制存在且可复用。
3. **边界**：单段 4 条事实 ≈ R 0.31 可满分；级联联合层 **R=0.10 时
   F_full=6-8/10、骨架≈满**（v2 L2）；再压（8%/5%/12% 单段）模型拒绝或全崩。
4. **反馈迭代（TextGrad）L1 有效**（F 0→满分），但反馈 prompt 必须带
   「已可还原部分保持原编码不动」——否则整体重写会倒退（v2 L2 第 2 轮全崩）。
5. 判定口径：还原允许语法重组；关键词匹配会把「3期/三期」误杀，真实 F
   略高于报告值。

## 报告
/tmp/mc-report.md（可读对照）、mc-report-nonsense.md（v1）、
mc-report-v2.md（级联）、mc-report-v4.md（骨架收敛版）。

## 后续可做（未做）
- token 口径 R（CLI headless 拿不到 usage；桌面 exp HTTP 接口可补）。
- 跨模型对照 G（员工 modelSelection 多模型路径）。
- 协议产品化（opc-memory-compress.ts 的 encodePrompt 迭代到 v4 参数）——
  等用户拍板再动。
