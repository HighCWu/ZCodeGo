# zcode-go × 官方上游合并指南（低冲突架构 + 操作手册）

## 目标架构原则

1. **新文件优先**：zcode-go 的一切实现放独立新文件；对上游文件的触碰收敛为
   "门控点"——import + 少量调用/渲染行。
2. **门控点要小、纯插入、带 zcode-go 注释锚**：我们对于上游文件的侵入
   是纯新增插入——插入行只在上游恰好同位置加代码时才冲突，且解决方式
   显然（两段都保留）。
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
| packages/ui/src/ErrorBoundary.tsx | 102+ | ~**63+** | 常量/额度逻辑迁 zcodeGoUiAutoRecovery.ts；两个边界类内的侵入保持纯新增插桩 |
| packages/ui/src/lib/interfaceMode.ts | — | **3+/1-** | OPC：类型联合 + normalize 加 opc 直通（类型不可避免类） |
| packages/ui/src/store/index.ts | — | **2+/1-** | OPC：跨窗口广播 guard 条件加 `"opc"`（门控分支类） |
| packages/ui/src/WorkspaceSidebarFooter.tsx | — | **4+** | OPC：模式菜单 +1 RadioItem（纯插入） |
| packages/ui/src/settingsPageHelpers.tsx | — | **4+** | OPC：设置页 +1 SelectItem（纯插入） |
| packages/ui/src/onboarding/occupationOptions.ts | — | **3+** | OPC：modeOptionIcons +1 行图标（纯插入） |
| packages/ui/src/onboarding/OnboardingModeSelector.tsx | — | **2+/1-** | OPC：模式数组字面量 +`"opc"`（1 行改写） |
| packages/ui/src/v4/SessionPane.tsx | 115+/31- | **23+/44- → 本轮 +21/-4** | OPC：草稿空态门控分支（isOpcMode 三元替换）+ 建议提示条件加 `!isOpcMode`（门控分支类） |
| packages/ui/src/App.tsx | 104+/1- | **10+/1- → 本轮 +4** | OPC：+1 import 行 + `<ZcodeGoOpcPanelMount />` 渲染行（纯插入） |
| packages/shared/src/onboardingRecord.ts | — | **2+/1-** | OPC：interfaceMode 枚举加 `"opc"`（类型不可避免类） |
| packages/desktop/electron-builder.config.js | — | **6+** | OPC 模板包：extraResources 存在性门控条目（build/opc-packs 存在才进包，纯插入带锚） |
| package.json（根） | — | **2+** | OPC：`opc:fetch-packs` / `opc:fetch-packs:desktop` 两个脚本行（JSON 无锚不可避免，同 services/package.json 先例） |
| .gitignore | — | **3+** | OPC 模板包构建产物排除（纯插入带锚） |

OPC 模板包（specs/opc-mode.md「模板包」节）：dev/打包期从用户 fork
（HighCWu/OpenOPC、HighCWu/claude-skills）经 `pnpm opc:fetch-packs[:desktop]`
拉取 codeload tarball，过滤落盘为带 pack.json 版本戳的模板包；打包由
electron-builder 存在性门控带进 resources/opc-packs；运行时 desktop main
（zcodeGoOpcPacks.ts）按 company.json `packImports` 戳做幂等填充（只创建缺失项，
用户改动/晋升产物永不被覆盖，纯逻辑在 shared opc-packs.ts）。本仓库零内容入库。
**插件 url-zip 发行链**：官方安装器拒绝 `.gitmodules` 仓库（无安装期脚本可依赖），
且对市场条目 url 来源强制 `type:"zip"` + 必填 sha256（无 type 按 git 克隆——bundle
`Jdt` 实证，静态分析纠回）：`.github/workflows/release-plugin.yml` 拉 packs 注入
`plugin/opc-packs/`（gitignore）打 zip 发到固定 tag `plugin-v<版本>`，并逐版本改写
marketplace.json（url + type + sha256）推送回仓库；未发布前清单保持 `"plugin"`。
插件 cjs 的 takeover/`packs` 子命令把内置包镜像到 `~/.zcode-go/opc-packs`
（按 fetchedAt 单调防降级），dev 直挂仓库则后台惰性拉取 fetch 脚本。

OPC 模式（specs/opc-mode.md）本轮新增上游足迹即上表 10 行；承载新文件：
`packages/shared/src/opc/`（契约+纯逻辑+内置模板包）、`packages/desktop/src/main/zcodeGoOpcStore.ts`
（唯一事实源 + IPC）、`packages/ui/src/opc/`（面板五视图/对话框/驾驶舱/挂载）与
`packages/ui/src/store/opcStore.ts`（投影缓存）。通道键与载荷映射在 channels.ts 纯新增
（OPC 段带 zcode-go 锚）；preload 增补在 zcodeGoEntries.ts（自有文件）。
**OPC 的 bundle 验证教训**：esbuild 对非 ASCII 日志字面量转义为大写十六进制
（`OPC \u516C\u53F8…`），grep 中文原文必假阴性——用 ASCII 前缀（如 `zcode-go] OPC`）
或通道字符串（`zcode:zcode-go-opc-*`）验模块体。

新文件承载（上游不存在，零冲突）：zcodeGoMobileBridgeSection.tsx、
zcodeGoWindowIntegration.ts、zcodeGoSessionPaneIntegration.ts、
zcodeGoSilentForkTransaction.ts、preload/zcodeGoEntries.ts、
zcodeGoUiAutoRecovery.ts、zcode-go.css、i18n/locales/zcode-go-{zh-CN,en-US}.ts，
以及历史上已独立的全部 zcodeGo* 模块（desktop main/services/ui/plugin/mobile-bridge/scripts）。

## 变更面全量审计基准（对 aac4755，第四轮收敛后）

118 新文件 + 63 个上游文件改动，其中 **36 个已纯新增插入（零删改行）**，
27 个含删改行但全部属于四类可接受形态（复验脚本：
`git diff --unified=0 aac4755 -- <file> | grep -c "^-[^-]"`，逐文件归零或归类）：
1. **函数级整替**（原则 3）：SessionPane（上游实现挪新文件，门控点=工厂调用行）、
   wire-assembler（自由函数→类方法供子类覆写）、primaryWindowCoordinator（单函数重构）；
2. **设置/环境门控分支**：WorkspaceShellLayout/WorkspaceSidebar/WorkspaceHeader/
   SettingsPage（`isMobileViewport` 分支）、useAppPanels（上游 useState 行保持
   原样 + useLayoutEffect 门控收起，设置关闭时回正）、zcodeAgentProcessManager
   重定向（official.json 存在才命中）；
3. **fork 惰性等价改写**（无 fork 活动时行为恒等上游）：zcodeAgentService 订阅
   翻译、zcodeTaskIndexSyncer remap、agentConversationTransport 别名、
   desktopHostProcess 多引用清理、index.ts disposeHostProcess 引用计数；
4. **品牌/类型不可避免**：logo import 资产行 ×3、index.html 启动屏、
   env.ts/settingsNavigation 类型联合扩展、services/package.json 逗号。

锚纪律：63/63 个上游改动文件的新增插入点均带 zcode-go 锚标识
（复验：`git diff --unified=0 aac4755 -- <file> | grep "^+" | grep -c zcode-go`，
为 0 即缺锚）。合并冲突时 `git diff aac4755...HEAD --name-only` +
逐文件 grep zcode-go 即可枚举我们全部插入位置。

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

## ⚠️ 去重教训：合并出现同名双 handler 时，先辨语义再取舍

v3.15.1 合并时 index.ts 出现两个 `ZcodeGoSilentFork` handler（Electron 首注册
生效、第二个抛未处理拒绝被吞——这个事实分工恰好是「手动=双会话模型、
自动=轮换模型」）。去重时按「执行器版是重构后的新架构」的臆断删掉了双会话
内联版，导致手动 hover fork 退化为轮换模型（无可见任务行 F、无 hover 标记、
无全量补齐），CI（只测 auto 路径）未能拦截。已恢复：手动=
`executeZcodeGoHoverForkDualSession`、自动=`executeZcodeGoSilentForkTransaction`，
两者共存于 zcodeGoSilentForkTransaction.ts、共用在途互斥。
**规则：去重前先确认两份代码是"新旧同物"还是"两个特性"。**
同族教训（takeover 空白页）：脚本化编辑对 src/main 的 import 块顶掉一行
成员后，本地 out/ 的陈旧产物会让 tsup 失败被"成功"假象掩盖——bundle 验证
必须核对产物 mtime，或直接以 CI 全新构建为权威。

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
第四轮同根因变体（takeover）：import 缺失 + 调用点大小写错
（`initZCodeGoTakeover` vs `initZcodeGoTakeover`）时 esbuild 把调用留成
自由全局变量，**构建期零报错**。bundle grep 必须：搜**模块体内的特征
字面量**（如日志串 `takeover-debug.log`）而非只搜调用点标识符——调用在、
定义不在才是 "is not defined" 的形态；只搜 `.js` 排除 `.map`（source map
永远含全部源串，假阳性）；大小写敏感精确匹配。

## 设置页「ZCode Go」板块（功能开关）

四个功能开关（settings 页侧边栏「ZCode Go」，全部默认启用）：
| 设置键 | 门控点 |
|---|---|
| zcodeGoP2pMobileBridge | WebRemoteControlDialog 的 P2P 直连区渲染（useOptionalServices 局部快照；关闭=弹层仅官方 relay） |
| zcodeGoHoverForkDualSession | index.ts 手动 IPC 路由（false=手动 fork 走兼容轮换模型；arm 自动路径恒为轮换） |
| zcodeGoMobileDrawerViewport | WorkspaceShellLayout 的 isMobileViewport（false=移动视口按桌面布局） |
| zcodeGoUiAutoRecovery | zcodeGoUiAutoRecovery 运行态标志（App 挂载时经 useZcodeGoUiAutoRecoverySync 同步；false=错误边界仅手动恢复） |

存储走上游 AppSettings（validationAppSettings 主/patch schema + protocol.ts
接口，三处纯新增键）；UI 在 settings/ZcodeGoSettingsSection.tsx（新文件），
上游触碰 = settingsPageConfig 条目 + settingsNavigation union + SettingsPage
render 三处小插入；文案在 zcode-go-{locale}.ts spread 文件。
**新增功能开关照此模式**：schema 三处加键 → 板块组件加行 → 门控点读
`settings?.key !== false`（无 Provider 环境用 useOptionalServices 局部快照，
缺失视为启用；class 组件用运行态标志 + 挂载同步 hook）。

## 新增 zcode-go 功能的规范

- 一律新文件；对上游文件最多加「import + 调用行」两段插入，注释锚统一
  `// zcode-go：`开头（合并时 grep 该前缀即可盘点全部门控点）。
- 文案进 i18n/locales/zcode-go-{locale}.ts；样式进 zcode-go.css；
  通道键进 shared 侧独立对象后 spread（当前 channels.ts 为历史形态——我们
  对它的侵入本就是纯新增行，保留即可，不必回改）。

## OPC E2E（CI-only 定版）

OPC 全栈闭环 E2E（scripts/e2e/opc-e2e.mjs）挂在 official-e2e 假 Provider
步骤的循环里（第七条，与六条既有 E2E 同一编排），**只在 GitHub Actions
跑，不在本地执行**——本地反复起 Electron 实例被用户明确叫停。CI 复用：
官方锚点构建 → ensure-official-electron 装配 → ZCODE_GO_E2E_APP_BIN/
ZCODE_GO_E2E_DISPLAY 约定 → Xvfb+openbox。脚本自足（Telegram mock API
随机端口、模板包写沙箱 ~/.zcode-go/opc-packs，零网络依赖）；启动前同步
仓库 out/main+out/preload → 装配产物（desktop main 不在 typecheck 覆盖，
bundle 保鲜是唯一防线）。paths 触发含 packages/shared/src/**（OPC 主体
逻辑在 shared；缺它则改 shared 不触发任何 E2E）。

教训——pkill 宽模式自杀：`pkill -f "<字面量>"` 会匹配**自己命令行里含
该字面量的父 shell**（bash -c 'pkill -f "..."'' 的 cmdline 就带匹配串，
pkill 不排除父进程，只排除自身）——曾用 `pkill -f /proc/self/exe` 清理
残留时杀掉自己的整条命令链。脚本内安全：spawn pkill 不经 shell、node
父进程 cmdline 无匹配串。人工清理残留进程一律走 `/proc/<pid>/exe` +
cmdline 双过滤后按 pid 杀（bash 的 exe 是 bash，过滤条件不可能命中自己）。

## 受影响单测的存量失败归因（2026-10-15，推送 c25b6ce3 实证）

pre-push 钩子 test:unit:affected 以远端 sha 为 base；OPC 改 shared 后大量
此前未被覆盖的测试首次进入集合，暴露四组**存量**失败（被测源码与测试文件
在 origin/rsi..HEAD 内零变更，基线同红）：
1. Node 版本漂移：Node 25 令 jsdom 29 的 window.localStorage 返回
   undefined（getter 存在、求值即失），所有裸调 localStorage.clear() 的
   jsdom 测试全红。mise.toml 要求 node 24.14.0——本地 shell 被 nvm 漂到
   v25.9.0 时放大至 71 例。Node 24 下这组全绿。自建 stub 的测试
   （installMemoryLocalStorage 模式）不受影响。
2. browserDataManager「LocalStorage 快照发现 origin」：测试期望
   chrome_executable_not_found（无 Chrome 分支），本机装有 Chrome 即红。
3. storagePreparationProtocol：import apps/zcode-cli 嵌套 workspace 的
   @zcode/adapters/storage → exports 指向 dist/ 构建产物；adapters 全量
   tsc 编译不过（@zcode/dynamic-workflow 缺 dist + 真实类型不匹配）——
   上游 CLI 内部构建链问题，fork 不修。部分构建后（contracts 先 build）
   该测试可过。
4. subagentRuntimeConfig「目录替换丢弃 in-flight 读」：fs.watch 时序型
   存量红，zcode-agent 目录零变更。
pre-push 钩子已加基线守卫：本地 node 主版本 ≠ mise.toml 时跳过单测段
（lint/架构检查照跑），测试一律由 CI（official-e2e 复用官版 zcode
electron 的装配链路）兜底——本地不在跑测试的工作流里，环境漂移不应成为
推送障碍（此前需 --no-verify 的场景即此根因）。

## desktop main 盲区第三次踩坑（parseOpcInboxFile，CI 九轮实证收口）

scanInbox 调用 parseOpcInboxFile 但缺 import——esbuild 把调用留成自由全局
变量，构建零报错，运行时 ReferenceError 被「单文件损坏不中断扫描」的
catch 吞掉 → 入站队列恒空。症状极具迷惑性：文件在磁盘（脚本 readdir 可见、
app root 视角可见）、路径一致、GetState 恒 []，耗九轮 CI 才定位。收口三
件事：①「未定义标识符」类问题必须 bundle grep 特征字面量（本次「入站扫
描跳过」warn 串 + parseOpcInboxFile 绑定计数）而非靠跑；②catch 吞错必须
留痕（warn 级），「静默降级」与「真没数据」无法区分就是排查黑洞；③E2E
诊断增强（失败分支 dump 双侧现场 + app.log 尾部进步骤日志）是九轮里真正
起作用的手段——写脚本时就该带上。

另两笔：受影响单测在 Node 25（本地 nvm 漂移，mise.toml 要求 24.14.0）下
jsdom 29 的 window.localStorage 求值即失 → 凡裸调 localStorage.clear() 的
测试全红；pre-push 钩子用当前 PATH 的 node，推送前先 `node --version` 对
齐 mise。Windows runner 的 lazy-history 临界超时是环境综合症（挂点漂移：
boot1 消息不足 / tail window / notOwned 风暴，mac+linux 同代码全绿），
不要按代码回归追。
