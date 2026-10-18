# 记忆压缩试验——交接状态（v5 定版 + 桌面通路收口）

## 定版结果
v5（GLM-5.3-Flash，subagent 口径）：R_token=0.163（29/178），
独立新会话解码必答 7/8 + 歧义修正版 29 tokens；
gpt-6-astra 口径对照：R_token=0.152、必答 8/8（两次会话一致）。
定版密文（gpt）：`2:187(40/50/10)18;弓日11/15;12/1>20;运营李婷`。
协议全文见 spec「已知边界·记忆压缩试验」与 scripts/experiments/*.mjs。

## 路线定稿（2026-10-17 用户拍板）
**抽象字符编解码路线舍弃**：随机 token 种子 + 自解码路线被 10/10 全拒否定
（双模型/三通路/两档指令强度，结构性对齐拦截非措辞问题），详见 spec 已知
边界。**记忆压缩定版 = v5 混合形态**（数字直存 + 成体系代号 + token 预算
反馈，R_token≈0.15-0.17，提示式解码必答 7-8/8）；进一步压缩或「模型自创
语言」方向需要新的机制假设，当前模型能力下不再投入。

## 桌面 host 通路——基础设施已交付，GLM 可用性未决
已交付并验证：EXP_MODE 共存开关（根治杀官版竞态）、试验 HTTP 接口
（拉模式 invoke 轮询；推式 send 在 Electron 41 不达已实证）、显式模型绑定、
安全启动脚本 start-zcgo-desktop-safe.sh。

**遗留问题（根因未明，勿当产品 bug 处理）**：EXP_MODE 共存模式（官版与
ZCode Go 同时运行）下，GLM 账号 Model creation failed（Provider Registry
中不存在 account:bigmodel-individual-coding-plan；UI 手动发送同报错）。
账号装配交付正常（快照 entitled:true）。复现：EXP_MODE 共存启动 → 会话选
GLM-5.3-Flash 发消息。**用户实证过独占接管模式下 GLM 正常**——共存是试验
引入的未支持场景，独占才是产品支持姿势。复跑桌面通路 v5 的正确姿势：
用户手动 /zcode-go 独占接管（官版临时退出）→ 跑试验 → 退 ZCode Go 回官版。

## 事故记录（2026-10-17 晚）
1. 旧产物组装启动（launcher 构建新鲜度不感知分支切换）→ 旧 closeOfficial
   误杀官版。防护：safe-start 脚本强制重建+产物 grep 验证。
2. kill 1821541 无 exe 校验——官版 workspace host 被误杀（按需可重建）。
   **纪律重申：任何 kill 必须 /proc/<pid>/exe + cmdline 双过滤。**
3. 试验 createTask 在 zcode-go-rsi 项目留下 7 个 Untitled session——已清理。
   教训：无人值守试验的临时会话应在 closeTask 后自清，或用唯一标题便于清理。

## 调用通路速查
- 官版 CLI headless：`ELECTRON_RUN_AS_NODE=1 /opt/ZCode/zcode
  /opt/ZCode/resources/glm/zcode.cjs -p "..."`（模型继承全局选择——
  当前是 openai/gpt-6-astra，注意归属标注）
- subagent：跑在会话模型上（GLM-5.3-Flash），但带 workspace 注入
  （AGENTS.md/工具/技能清单），非纯净 CLI 前缀——两种口径已在 spec 标注
- 桌面试验 HTTP：EXP_MODE 独占接管后 `POST /exp/prompt`（纯净 CLI 前缀）
- tokenizer：/tmp/glm-tokenizer.json + python tokenizers
