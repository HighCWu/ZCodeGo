# zcode-go × 官方上游合并指南（低冲突架构 + 操作手册）

## 目标架构原则

1. **新文件优先**：zcode-go 的一切实现放独立新文件；对上游文件的触碰收敛为
   "门控点"——import + 少量调用/渲染行。
2. **门控点要小、纯插入、带 zcode-go 注释锚**：纯插入行只在上游恰好同位置
   加代码时才冲突，且解决方式显然（两段都保留）。
3. **行为替换必须函数级整替**：当 zcode-go 必须改变上游行为（如 hover fork
   取代 forkAssistant），把上游原实现整体替换为一个工厂调用（保持原变量名），
   并在新文件头注释记录上游原语义——未来冲突时整块取舍，不做行级纠缠。

## 已就位的门控点（本轮重构后，对官方 aac4755 的足迹）

| 上游文件 | 原足迹 | 现足迹 | 门控形式 |
|---|---|---|---|
| packages/ui/src/WebRemoteControlDialog.tsx | 429+ | **3+** | import + `<ZcodeGoMobileBridgeSection />` 渲染行 |
| packages/ui/src/App.tsx | 104+/1- | **10+/1-** | 两个 hook 调用行（zcodeGoWindowIntegration.ts）+ logo 资产行 |
| packages/ui/src/i18n/locales/{zh-CN,en-US}.ts | 16+ | **3+** | import + `...zcodeGoMessages{ZhCN,EnUs},` spread |
| packages/ui/src/styles.css | 18+ | **1+** | `@import "./zcode-go.css";` |
| packages/ui/src/v4/SessionPane.tsx | 115+/31- | **23+/44-** | 三个 hook 工厂调用行 + rows 过滤一行；删除集中在两处函数级整替（hover fork / goal 命令），冲突时整块取我们侧 |
| packages/desktop/src/main/index.ts | 533+ | **442+** | fork 事务执行器迁 zcodeGoSilentForkTransaction.ts；门控点 = deps 常量 + 两处调用行 |
| packages/desktop/src/preload/index.ts | 92+ | **2+** | import + `...installZcodeGoPreloadEntries({ ipcRenderer }),` 一行 spread。**注意：preload 不在 `pnpm run typecheck` 覆盖内（tsc 盲区）**——改 preload 后必须 `npx tsup` 重建 + e2e 实测（CI 实证：漏 import 的 preload 在 typecheck 全绿下仍炸空白页） |
| packages/ui/src/ErrorBoundary.tsx | 102+ | ~**63+** | 常量/额度逻辑迁 zcodeGoUiAutoRecovery.ts；两个边界类内保持纯新增插桩 |

新文件承载（上游不存在，零冲突）：zcodeGoMobileBridgeSection.tsx、
zcodeGoWindowIntegration.ts、zcodeGoSessionPaneIntegration.ts、
zcodeGoSilentForkTransaction.ts、preload/zcodeGoEntries.ts、
zcodeGoUiAutoRecovery.ts、zcode-go.css、i18n/locales/zcode-go-{zh-CN,en-US}.ts，
以及历史上已独立的全部 zcodeGo* 模块（desktop main/services/ui/plugin/mobile-bridge/scripts）。

## 后续提取候选（按收益排序；本轮未做的原因与做法）

1. **packages/desktop/src/main/index.ts（第二轮后 442+，纯插入为主）**
   执行器已迁出（zcodeGoSilentForkTransaction.ts）。剩余大头是「桥窗口挂接 +
   移动桥 IPC」块，若继续做：迁 zcodeGoDesktopBridgeIntegration.ts，
   deps={logger, deviceMid, windowHostProcessMap, disposeHostProcess,
   broadcastMobileBridgeStatus, setMobileBridgeDialogVisible,
   startMobileBridgePairing, getDatabaseStartupPortPayload,
   zcodeGoPendingInitialSession}。**教训**：删块不能用 `{}` 计数器（类型字面量
   会截断，本轮实测），用 AST 或整段匹配；改完必须跑
   `npx esbuild --loader:.ts=ts` 解析探针（tsc -b 增量缓存会漏检语法错）；
   CSS 门控行检查「注释存在」不等于「import 存在」（首轮实测：替换目标
   字符串与实际 @import 写法不符时静默跳过）；**脚本化插 import 后 grep
   验证 import 行真的存在**（二轮实测：preload 提取漏插 import，typecheck
   盲区 + 本地旧构建产物掩盖，CI 全新构建下三平台空白页）。
2. **packages/services/src/zcode-agent/zcodeAgentService.ts（371+/12-）**  # 评估结论不变
   25 个散布接缝（send/read 域翻译、rowsRange 拦截、fork ack 登记等）。强抽会
   制造 20+ 个小冲突点，得不偿失；建议维持现状，等上游大改该文件时借机收敛。
3. **WorkspaceShellLayout.tsx 的抽屉 className 分支（22- 的主体）**：可把移动
   抽屉的类名分支改为包裹组件，但布局语义敏感，需专项验证移动端。
4. **primaryWindowCoordinator（13-）**：多窗口语义深在函数内部，接受残留。

## 合并操作程序

1. `git fetch zcode-official && git log --oneline main..zcode-official/main`
   先看上游提交量级与触碰文件：`git diff --name-only <base>..zcode-official/main | wc -l`。
2. 冲突集中时按本表门控点快速判断：**门控行永远取"两段都留"**；函数级整替区
   （SessionPane 两处）永远取我们侧、并把上游新语义合入对应新文件。
3. 大版本合并后必跑：`pnpm run typecheck`（先删 tsconfig.tsbuildinfo！）→
   `npx oxlint` → `pnpm run test:unit`（本地基线：与纯净上游 worktree 对比，
   本机固有失败约 37 项，CI 为权威）→ `npx tsx scripts/e2e/fresh-model-e2e.mjs`
   + `lazy-history-e2e.mjs` + `silent-fork-auto-e2e.mjs`。
4. 上游新增 API 需要在桥窗口 shim 里补齐时（教训：contextBridge.
   executeInMainWorld 缺失导致 preload 求值中断），grep
   `packages/desktop/src/preload/` 对 `contextBridge.`/新 Electron API 的
   使用，逐一在 zcodeGoMobileBridge.ts 伪造对象补 no-op 实现。

## ⚠️ 关键盲区：packages/desktop/src/main 与 src/preload 不在 typecheck 覆盖内

`pnpm run typecheck` 对 desktop 只含 tsconfig.host.json + tsconfig.e2e.json
（host/e2e 侧），**src/main 与 src/preload 由 tsup/esbuild 直接构建，tsc 不查**。
后果（三轮实证）：漏 import、未定义标识符在这两个目录里 typecheck 全绿，
只有运行时炸。改这两个目录后必须：
1. `cd packages/desktop && npx tsup`（构建成功 ≠ 可运行）；
2. grep 构建产物验证新符号真的在 bundle 里；
3. 跑相关 e2e（silent-fork-auto 覆盖 main 的 fork 链；fresh-model 覆盖
   preload/renderer 链）。
另外：脚本化插 import 后必须 `grep` 验证 import 行真的落盘——锚串与实际
写法（单行 vs 多行块）不符时 replace 静默 no-op（三轮同模式踩坑）。

## 新增 zcode-go 功能的规范

- 一律新文件；对上游文件最多加「import + 调用行」两段插入，注释锚统一
  `// zcode-go：`开头（合并时 grep 该前缀即可盘点全部门控点）。
- 文案进 i18n/locales/zcode-go-{locale}.ts；样式进 zcode-go.css；
  通道键进 shared 侧独立对象后 spread（当前 channels.ts 为历史形态，纯新增
  行保留即可，不必回改）。
