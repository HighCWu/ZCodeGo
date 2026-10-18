/* oxlint-disable eslint(max-lines) -- 公司面板是五标签 + 全部管理动作的编排收口（同 SessionPane/插件宿主惯例），拆散会破坏内聚。 */
/**
 * zcode-go OPC 公司面板（全屏 overlay，五标签：看板/组织/人才市场/技能/进化）。
 *
 * 打开方式：App 挂载 useZcodeGoOpcPanel 后，任意组件派发
 * window CustomEvent("zcode-go:opc-open") 即可唤起（草稿驾驶舱/快捷键/菜单）。
 * 全部写路径走 opcStore.apply（IPC → main reducer → 广播），本组件零本地状态事实。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpcStore } from "@/store/opcStore.js";
import {
  buildOpcOrgMutations,
  buildOpcCompanyPackage,
  buildOpcDelegationPrompt,
  buildOpcIntegrationPrompt,
  buildOpcCompanyImportMutations,
  isOpcWorkItemRunnable,
  parseOpcCompanyPackage,
  type OpcRoleTemplateDraft,
  type OpcWorkItem,
} from "@zcode/shared";
import { OpcStatChip } from "./opcDisplay.js";
import { OpcKanbanBoard } from "./OpcKanbanBoard.js";
import { OpcOrgView } from "./OpcOrgView.js";
import { OpcTalentMarket } from "./OpcTalentMarket.js";
import { OpcSkillsView } from "./OpcSkillsView.js";
import { OpcEvolutionView } from "./OpcEvolutionView.js";
import { OpcOfficeMap } from "./OpcOfficeMap.js";
import { OpcModelsView } from "./OpcModelsView.js";
import {
  insertOpcPrompt,
  insertOpcPromptWithReceipt,
} from "./opcComposerBridge.js";
import { downloadTextFile, readFileText } from "./opcFiles.js";
import {
  countOrchestratable,
  dispatchReadyWorkItems,
} from "./opcOrchestrator.js";
import {
  buildOpcReflectionPrompt,
  buildOpcToolDenylist,
  opcEmployeeMemoryIdentity,
  shouldRunOpcReflection,
  OPC_REFLECTION_THROTTLE_MS,
} from "@zcode/shared";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useServices } from "@/hooks/useServices.js";
import {
  OpcReworkDialog,
  OpcWorkItemDialog,
  type OpcWorkItemDialogState,
} from "./opcDialogs.js";
import {
  OpcCustomHireDialog,
  OpcHireDialog,
  type OpcHireDialogState,
} from "./opcHireDialogs.js";
import {
  OpcRetroDialog,
  OpcUpgradeDialog,
  type OpcRetroDialogState,
  type OpcUpgradeDialogState,
} from "./opcEvolutionDialogs.js";
import { OpcEscalateDialog } from "./opcEscalateDialog.js";
import { OpcInboxDialog } from "./opcInboxDialog.js";
import { OpcProjectRetroDialog } from "./opcProjectRetroDialog.js";
import { OpcOrgGenerateDialog, OpcOrgPresetDialog } from "./opcOrgDialogs.js";
import { logger } from "@/logger.js";

export const OPC_OPEN_PANEL_EVENT = "zcode-go:opc-open";

type PanelTab =
  | "kanban"
  | "office"
  | "models"
  | "org"
  | "market"
  | "skills"
  | "evolution";

export function ZcodeGoOpcPanelRoot({
  workspaceIdentity,
  workspacePath: workspacePathProp,
}: {
  workspaceIdentity?: string | null;
  /** Mount 下传的当前工作区：预热门控到 opc 模式后 store 的 workspacePath
   * 只在 initialize 后才有值——非 opc 模式面板唤起时的兜底来源。 */
  workspacePath?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const state = useOpcStore((s) => s.state);
  const apply = useOpcStore((s) => s.apply);
  const resolveRoleBody = useOpcStore((s) => s.resolveRoleBody);
  const resolveSkillBody = useOpcStore((s) => s.resolveSkillBody);
  const workspacePath = useOpcStore((s) => s.workspacePath);
  const bodies = useOpcStore((s) => s.bodies);
  const inbox = useOpcStore((s) => s.inbox);
  const employeeMemoryIndexes = useOpcStore((s) => s.employeeMemoryIndexes);
  const employeePersonaDigests = useOpcStore((s) => s.employeePersonaDigests);
  const employeePrinciples = useOpcStore((s) => s.employeePrinciples);
  const employeeMemoryPaths = useOpcStore((s) => s.employeeMemoryPaths);
  // 派发/反思时命令式读取当前模型选型（员工空库不传选型会落 builtin 默认
  // 模型，可能与用户所选不符并放大调用成本）。用 base services（SessionPane
  // 同款；workspace-scoped 的 getView 在面板上下文会挂起）。不挂选型订阅
  // hook——命令式 getView 拿 effectiveSelection 且零订阅。
  const { modelSelectionService } = useServices();
  const readPinnedModelSelection = useCallback(async () => {
    try {
      const view = await modelSelectionService.getView();
      // preferred = 用户当前在选型器里选中的模型（composer 草稿同语义）；
      // effective 是叠加账号可用性后的可执行投影，未连接账号时为空——
      // 派发钉定跟随用户意图（preferred），可执行性由子会话注册表裁决。
      return view.preferredSelection ?? view.effectiveSelection ?? undefined;
    } catch {
      return undefined;
    }
  }, [modelSelectionService]);
  const { settings } = useSettings();
  const taskService = useZCodeTaskService(
    workspacePath ?? undefined,
    undefined,
    workspaceIdentity ?? undefined,
  );
  // 员工记忆反思轮（金字塔 L2/L4）：工作项收口 → 员工身份反思会话
  //（归纳原则 + 更新 persona），6h 节流（面板会话级内存）。
  const reflectStateRef = useRef<{
    lastAt: Map<string, number>;
    seenDone: Set<string>;
  }>({ lastAt: new Map(), seenDone: new Set() });
  const workItems = state?.workItems;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>("kanban");
  const [workItemDialog, setWorkItemDialog] =
    useState<OpcWorkItemDialogState | null>(null);
  const [hireDialog, setHireDialog] = useState<OpcHireDialogState | null>(null);
  const [customHireOpen, setCustomHireOpen] = useState(false);
  const [retroDialog, setRetroDialog] = useState<OpcRetroDialogState | null>(
    null,
  );
  const [reworkDialog, setReworkDialog] = useState<OpcWorkItem | null>(null);

  // 员工记忆反思轮触发：检测「新进入 done」的工作项 → 员工身份反思会话
  //（归纳原则到 memory/principle、更新 persona.md；fire-and-forget——产物
  // 是记忆文件，无轻量完成判定）。6h 节流按员工（内存级，面板会话有效）。
  useEffect(() => {
    if (!workspacePath || !workItems) return;
    const { lastAt, seenDone } = reflectStateRef.current;
    const now = Date.now();
    for (const item of workItems) {
      if (item.status !== "done") continue;
      const doneKey = item.id + "@" + (item.updatedAt ?? "");
      if (seenDone.has(doneKey)) continue;
      seenDone.add(doneKey);
      if (seenDone.size > 200) {
        // 保留最近的 100 条：全清会让历史 done 项被重新视为「未见过」，
        // 触发一轮不该有的重复反思（节流只能限制频率，不能消除）
        const keep = Array.from(seenDone).slice(-100);
        seenDone.clear();
        for (const key of keep) seenDone.add(key);
      }
      const employee = state?.employees.find((e) => e.id === item.assigneeId);
      if (
        !employee ||
        employee.status !== "active" ||
        employee.permissionLevel === "read-only"
      ) {
        continue;
      }
      // 员工有在跑的任务时跳过：反思会话与任务会话并发写同一记忆目录
      // 会产生文件级竞态（两者同身份、同目录）
      const busy = state?.workItems.some(
        (w) =>
          w.assigneeId === employee.id &&
          w.status === "in_progress" &&
          w.sessionId,
      );
      if (busy) continue;
      if (!shouldRunOpcReflection({ lastReflectAtMs: lastAt.get(employee.id) ?? 0, nowMs: now })) {
        continue;
      }
      lastAt.set(employee.id, now);
      if (
        !employeeMemoryIndexes ||
        employeePrinciples?.[employee.id] === undefined
      ) {
        // GetState 尚未回读（索引/原则清单未加载）——跳过本轮，下次收口再反思
        continue;
      }
      const reworkCount = item.reworkNotes?.length ?? 0;
      const prompt = buildOpcReflectionPrompt({
        employeeName: employee.name,
        memoryIndex: employeeMemoryIndexes[employee.id] ?? null,
        existingPrinciples: employeePrinciples[employee.id] ?? [],
        reworkCount,
        finishedTopics: [item.title],
      });
      void (async () => {
        try {
          // 钉定模型：与派发同一 fail-safe（无选型不派发，防 builtin 默认兜底）
          const pinnedModelSelection = await readPinnedModelSelection();
          if (!pinnedModelSelection) return;
          const created = await taskService.createTask({
            workspacePath,
            workspaceIdentity: opcEmployeeMemoryIdentity(employee.id, workspacePath),
            modelSelection: pinnedModelSelection,
            v4Create: true,
            deferPersistenceUntilFirstPrompt: true,
            permissionScope: "session",
          });
          await taskService.sendPrompt({
            taskId: created.taskId,
            traceId: `opc-reflect:${item.id}:${now}`,
            content: prompt,
            // 反思要读写记忆文件：拒绝 shell/node_repl 等执行通道，保留文件工具
            toolDenylist: buildOpcToolDenylist("workspace-write"),
          });
          logger.info(
            `[zcode-go][opc] 反思轮已派发：${employee.name}（${item.id}）`,
          );
        } catch (error) {
          logger.warn("[zcode-go][opc] 反思轮派发失败", error);
        }
      })();
    }
  }, [workItems, workspacePath, state?.employees, employeeMemoryIndexes, employeePrinciples, taskService, readPinnedModelSelection]);
  const [escalateDialog, setEscalateDialog] = useState<OpcWorkItem | null>(
    null,
  );
  const [projectRetroOpen, setProjectRetroOpen] = useState(false);
  const [orgGenerateOpen, setOrgGenerateOpen] = useState(false);
  const [orgPresetOpen, setOrgPresetOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [upgradeDialog, setUpgradeDialog] =
    useState<OpcUpgradeDialogState | null>(null);

  useEffect(() => {
    // detail.tab 允许快捷入口直达指定标签；detail.action 直达面板内动作
    // （如驾驶舱「新建工作项」→ 打开建项对话框，而不是只开看板）
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: PanelTab; action?: string }>)
        .detail;
      if (detail?.tab) setTab(detail.tab);
      if (detail?.action === "createWorkItem") {
        setWorkItemDialog({ mode: "create", workItem: null });
      }
      setOpen(true);
    };
    window.addEventListener(OPC_OPEN_PANEL_EVENT, handleOpen);
    return () => window.removeEventListener(OPC_OPEN_PANEL_EVENT, handleOpen);
  }, []);

  // 非 opc 模式下 mount 预热被门控（E2E 启动开销归零），面板经 CustomEvent
  // 唤起时在此兜底 initialize——幂等，重复调用短路。
  const initialize = useOpcStore((s) => s.initialize);
  const workspacePathFromStore = useOpcStore((s) => s.workspacePath);
  useEffect(() => {
    if (!open || !workspacePathFromStore) return;
    // 键约定 workspaceIdentity?.trim() || workspacePath——漏传会与 Mount 的
    // 预热键不一致，触发多余 GetState
    void initialize(
      workspacePathFromStore,
      workspaceIdentity ?? undefined,
    ).catch(() => {
      /* 初始化失败由面板内错误态呈现 */
    });
  }, [open, initialize, workspacePathFromStore, workspaceIdentity]);

  /** 导出公司包（状态 + 技能/模板正文 → JSON 下载）。 */
  const handleExportCompany = useCallback(() => {
    if (!state) return;
    const pkg = buildOpcCompanyPackage({
      state,
      skillBodies: bodies.skillBodies,
      roleTemplateBodies: bodies.roleTemplateBodies,
    });
    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `opc-company-${state.company.name}-${date}.json`.replace(/\s+/g, "-"),
      JSON.stringify(pkg, null, 1),
    );
  }, [state, bodies]);

  /** 导入公司包（merge-fill：只创建缺失项）。 */
  const handleImportCompany = useCallback(
    async (file: File) => {
      const pkg = parseOpcCompanyPackage(await readFileText(file));
      if (!pkg) {
        logger.warn("[zcode-go][opc] 公司包导入失败：格式无效");
        return;
      }
      if (!state) return;
      // 目标 = 当前工作区状态（merge-fill，只创建缺失项）；pkg.state 是来源。
      const outcome = buildOpcCompanyImportMutations(state, pkg, Date.now());
      void apply(outcome.mutations);
    },
    [apply, state],
  );

  /** 架构-only 导出（OpcOrgDraft：岗位 + 在职员工编制计划，不含工作项/经验）。 */
  const handleExportArchitecture = useCallback(() => {
    if (!state) return;
    const slotTitleById = new Map(
      state.roleSlots.map((slot) => [slot.id, slot.title]),
    );
    const draft = {
      companyName: state.company.name,
      slots: state.roleSlots.map((slot) => slot.title),
      hires: state.employees
        .filter(
          (employee) => employee.status === "active" && !employee.isFallback,
        )
        .map((employee) => ({
          name: employee.name,
          template:
            employee.templateId === "custom" ? undefined : employee.templateId,
          slot: employee.roleId
            ? (slotTitleById.get(employee.roleId) ?? undefined)
            : undefined,
          seniority: employee.seniority,
        })),
    };
    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `opc-architecture-${state.company.name}-${date}.json`.replace(
        /\s+/g,
        "-",
      ),
      JSON.stringify(draft, null, 1),
    );
  }, [state]);

  /** 架构导入（merge-fill：岗位/招聘去重建项）。 */
  const handleImportArchitecture = useCallback(
    async (file: File) => {
      let draft: unknown;
      try {
        draft = JSON.parse(await readFileText(file));
      } catch {
        logger.warn("[zcode-go][opc] 架构导入失败：非法 JSON");
        return;
      }
      if (!state || typeof draft !== "object" || draft === null) return;
      const record = draft as Record<string, unknown>;
      const importedName =
        typeof record.companyName === "string" ? record.companyName : undefined;
      if (!Array.isArray(record.slots) && !Array.isArray(record.hires)) {
        logger.warn("[zcode-go][opc] 架构导入失败：缺少 slots/hires");
        return;
      }
      const outcome = buildOpcOrgMutations(
        state,
        {
          companyName: importedName,
          slots: Array.isArray(record.slots)
            ? record.slots.filter(
                (slot): slot is string => typeof slot === "string",
              )
            : [],
          hires: Array.isArray(record.hires) ? (record.hires as never) : [],
        },
        Date.now(),
      );
      void apply(outcome.mutations);
    },
    [apply, state],
  );

  /** 技能导出（SKILL.md 下载）。 */
  const handleExportSkill = useCallback(
    (skillId: string) => {
      const skill = state?.skills.find((item) => item.id === skillId);
      const body = resolveSkillBody(skillId) ?? skill?.description ?? "";
      downloadTextFile(`${skillId}.SKILL.md`, body);
    },
    [state, resolveSkillBody],
  );

  const orchestratableCount = useMemo(
    () => (state ? countOrchestratable(state) : 0),
    [state],
  );
  const orchestrateEnabled = settings?.zcodeGoOpcAutoOrchestrate !== false;
  const [orchestrating, setOrchestrating] = useState(false);
  const handleOrchestrate = useCallback(() => {
    logger.info(
      `[zcode-go][opc] 编排点击进入：state=${Boolean(state)} ws=${Boolean(workspacePath)} svc=${Boolean(taskService)} busy=${orchestrating}`,
    );
    if (!state || !workspacePath || !taskService || orchestrating) return;
    setOrchestrating(true);
    void (async () => {
      // 派发钉定模型：跟随工作区当前选型（缺失则编排器 fail-safe 不派发）
      const pinnedModelSelection = await readPinnedModelSelection();
      // 编排是会话生命周期事件：走 lifecycle 通道（生产构建仍经桥落盘，
      // 普通日志在生产 renderer 是 no-op）。
      logger.lifecycle.info(
        `[zcode-go][opc] 编排开始：钉定选型${pinnedModelSelection ? ` ${pinnedModelSelection.providerId}/${pinnedModelSelection.modelId}` : "缺失（fail-safe 不派发）"}`,
      );
      const outcome = await dispatchReadyWorkItems({
        state,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? undefined,
        taskService,
        resolveRoleBody,
        resolveSkillBody,
        // 员工持久记忆索引（GetState 时 main 批量绑定并回读）
        employeeMemoryIndexes: employeeMemoryIndexes ?? {},
        employeePersonaDigests: employeePersonaDigests ?? {},
        employeePrinciples: employeePrinciples ?? {},
        employeeMemoryPaths: employeeMemoryPaths ?? {},
        modelSelection: pinnedModelSelection,
        onMutations: (mutations) => void apply(mutations),
      });
      if (outcome.mutations.length > 0) void apply(outcome.mutations);
      logger.lifecycle.info(
        `[zcode-go][opc] 编排完成：派发 ${outcome.dispatched.length} / 失败 ${outcome.failed.length}`,
      );
    })()
      .catch((error) => {
        logger.warn("[zcode-go][opc] 编排执行异常", error);
      })
      .finally(() => setOrchestrating(false));
  }, [
    state,
    workspacePath,
    workspaceIdentity,
    taskService,
    resolveRoleBody,
    resolveSkillBody,
    apply,
    orchestrating,
    readPinnedModelSelection,
  ]);

  // E2E 句柄（同 __zcodeTabStoreE2E 惯例）：CDP 直调编排回调，绕开 Dialog
  // portal 内按钮的 DOM 点击可靠性问题；仅暴露既有回调，不新增产品面。
  useEffect(() => {
    const host = window as Window & {
      __zcodeOpcOrchestrateE2E?: () => void;
    };
    host.__zcodeOpcOrchestrateE2E = handleOrchestrate;
    return () => {
      if (host.__zcodeOpcOrchestrateE2E === handleOrchestrate) {
        delete host.__zcodeOpcOrchestrateE2E;
      }
    };
  }, [handleOrchestrate]);

  const handleStatusChange = useCallback(
    (workItemId: string, status: OpcWorkItem["status"]) => {
      void apply([{ kind: "workitem.status", workItemId, status }]);
    },
    [apply],
  );

  // 升级动作 → 对话框（先团队内路由，后所有者）；workItem 由看板回填
  const handleEscalate = useCallback((workItem: OpcWorkItem) => {
    setEscalateDialog(workItem);
  }, []);

  const handleResolveEscalation = useCallback(
    (workItemId: string, action: "resume" | "takeover") => {
      void apply([{ kind: "workitem.resolveEscalation", workItemId, action }]);
    },
    [apply],
  );

  const handleRework = useCallback((workItem: OpcWorkItem) => {
    setReworkDialog(workItem);
  }, []);

  /** integrate：完成产出 → 下游整合 prompt 注入 composer（Self-Run 整合动作）。 */
  const handleIntegrate = useCallback(
    async (workItem: OpcWorkItem) => {
      if (!state || !workspacePath) return;
      const dependents = state.workItems
        .filter((item) => item.dependsOn.includes(workItem.id))
        .map((item) => ({
          title: item.title,
          assigneeName:
            state.employees.find((employee) => employee.id === item.assigneeId)
              ?.name ?? null,
        }));
      const inserted = await insertOpcPromptWithReceipt({
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? undefined,
        text: buildOpcIntegrationPrompt({
          completedTitle: workItem.title,
          completedDetail: workItem.detail,
          dependents,
        }),
      });
      if (inserted) {
        setNotice(null);
        setOpen(false);
      } else {
        setNotice(intl.formatMessage({ id: "opc.injectFailed" }));
      }
    },
    [state, workspacePath, workspaceIdentity, intl],
  );

  const handleDeleteWorkItem = useCallback(
    (workItemId: string) => {
      void apply([{ kind: "workitem.delete", workItemId }]);
    },
    [apply],
  );

  /** 委派：角色正文 + 挂接技能 + 最近经验 → 委派 prompt → composer（用户确认发送）。 */
  const handleDelegate = useCallback(
    async (workItem: OpcWorkItem) => {
      if (!state || !workspacePath) return;
      const employee = state.employees.find(
        (item) => item.id === workItem.assigneeId,
      );
      if (!employee) return;
      const roleBody =
        employee.templateId === "custom"
          ? null
          : resolveRoleBody(employee.templateId);
      const skillBodies = employee.skillRefs
        .map((skillId) => {
          const meta = state.skills.find((skill) => skill.id === skillId);
          const body = resolveSkillBody(skillId);
          return meta && body ? { id: skillId, name: meta.name, body } : null;
        })
        .filter(
          (item): item is { id: string; name: string; body: string } =>
            item !== null,
        );
      const recentLessons = state.lessons
        .filter((lesson) => lesson.employeeId === employee.id)
        .slice(-10)
        .map((lesson) => lesson.statement);
      const prompt = buildOpcDelegationPrompt({
        companyName: state.company.name,
        employee,
        roleBody,
        workItem,
        skillBodies,
        skillNamesRemaining: [],
        recentLessons,
        memoryFilePath: `.opc/memory/${employee.id}.md`,
        reworkNotes: workItem.reworkNotes,
        permissionLevel: employee.permissionLevel,
      });
      // 依赖就绪门控（与 reducer/看板同规则）：未就绪不允许委派。
      if (!isOpcWorkItemRunnable(workItem, state.workItems)) return;
      const inserted = await insertOpcPromptWithReceipt({
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? undefined,
        text: prompt,
      });
      if (inserted) {
        setNotice(null);
        // 委派即开跑：ready → in_progress（reducer 同规则门控兜底）。
        if (workItem.status === "ready") {
          void apply([
            {
              kind: "workitem.status",
              workItemId: workItem.id,
              status: "in_progress",
            },
          ]);
        }
        setOpen(false);
      } else {
        // 回执失败：活跃会话/非草稿态——prompt 没有出现，不落账不误导
        setNotice(intl.formatMessage({ id: "opc.injectFailed" }));
      }
    },
    [
      state,
      workspacePath,
      workspaceIdentity,
      intl,
      resolveRoleBody,
      resolveSkillBody,
      apply,
    ],
  );

  const handleHireTemplate = useCallback(
    (draft: OpcRoleTemplateDraft, origin: "builtin" | "imported") => {
      setHireDialog({ template: draft, origin });
    },
    [],
  );

  const handleImportRoleFolder = useCallback(async (sourcePath: string) => {
    const result = await useOpcStore.getState().importRoleTemplates(sourcePath);
    logger.debug("[zcode-go][opc] 角色模板导入完成", result);
  }, []);

  const handleImportSkillFolder = useCallback(async (sourcePath: string) => {
    const result = await useOpcStore.getState().importSkillFolder(sourcePath);
    logger.debug("[zcode-go][opc] 技能导入完成", result);
  }, []);

  const handleAddRoleSlot = useCallback(
    (title: string) => {
      void apply([{ kind: "role-slot.create", title }]);
    },
    [apply],
  );

  if (!state) return null;

  const doneCount = state.workItems.filter(
    (item) => item.status === "done",
  ).length;
  const activeCount = state.workItems.filter(
    (item) => item.status === "in_progress" || item.status === "review",
  ).length;
  const promotedCount = state.skills.filter(
    (skill) => skill.origin === "promoted",
  ).length;

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[85vh] max-w-5xl flex-col gap-3 overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="size-4" />
              {state.company.name}
              <span className="text-ui-xs font-normal text-foreground-faint">
                OPC
              </span>
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "opc.panel.subtitle" })}
            </DialogDescription>
          </DialogHeader>
          {notice ? (
            <div className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-ui-xs text-foreground-subtle">
              {notice}
            </div>
          ) : null}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <OpcStatChip
              value={state.employees.length}
              labelId="opc.stat.employees"
            />
            <OpcStatChip
              value={state.workItems.length}
              labelId="opc.stat.workItems"
            />
            <OpcStatChip value={activeCount} labelId="opc.stat.active" />
            <OpcStatChip value={doneCount} labelId="opc.stat.done" />
            <OpcStatChip
              value={state.skills.length}
              labelId="opc.stat.skills"
            />
            <OpcStatChip value={promotedCount} labelId="opc.stat.promoted" />
          </div>
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as PanelTab)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="shrink-0">
              <TabsTrigger value="kanban">
                {intl.formatMessage({ id: "opc.tab.kanban" })}
              </TabsTrigger>
              <TabsTrigger value="org">
                {intl.formatMessage({ id: "opc.tab.org" })}
              </TabsTrigger>
              <TabsTrigger value="market">
                {intl.formatMessage({ id: "opc.tab.market" })}
              </TabsTrigger>
              <TabsTrigger value="skills">
                {intl.formatMessage({ id: "opc.tab.skills" })}
              </TabsTrigger>
              <TabsTrigger value="evolution">
                {intl.formatMessage({ id: "opc.tab.evolution" })}
              </TabsTrigger>
              {/* spec「产品规则」七标签：缺触发器则对应面板不可达 */}
              <TabsTrigger value="office">
                {intl.formatMessage({ id: "opc.tab.office" })}
              </TabsTrigger>
              <TabsTrigger value="models">
                {intl.formatMessage({ id: "opc.tab.models" })}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="office" className="min-h-0 flex-1">
              <OpcOfficeMap
                state={state}
                onRetrospective={(employee) =>
                  setRetroDialog({ employeeId: employee.id })
                }
              />
            </TabsContent>
            <TabsContent value="models" className="min-h-0 flex-1">
              <OpcModelsView
                state={state}
                workspaceIdentity={workspaceIdentity}
              />
            </TabsContent>
            <TabsContent value="kanban" className="min-h-0 flex-1">
              <div className="flex shrink-0 items-center justify-between gap-2 pb-2">
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage(
                    {
                      id: "opc.orchestrate.hint",
                    },
                    { count: orchestratableCount },
                  )}
                </span>
                <button
                  type="button"
                  className="rounded-md border border-border px-2 py-1 text-ui-sm enabled:hover:bg-background-muted disabled:opacity-50"
                  disabled={
                    !orchestrateEnabled ||
                    orchestrating ||
                    orchestratableCount === 0
                  }
                  onClick={handleOrchestrate}
                >
                  {intl.formatMessage({ id: "opc.orchestrate.button" })}
                </button>
              </div>
              <OpcKanbanBoard
                state={state}
                onCreateWorkItem={() =>
                  setWorkItemDialog({ mode: "create", workItem: null })
                }
                onEditWorkItem={(workItem) =>
                  setWorkItemDialog({ mode: "edit", workItem })
                }
                onStatusChange={handleStatusChange}
                onDeleteWorkItem={handleDeleteWorkItem}
                onDelegate={handleDelegate}
                onEscalate={handleEscalate}
                onResolveEscalation={handleResolveEscalation}
                onRework={handleRework}
                onIntegrate={handleIntegrate}
                onOpenInbox={() => setInboxOpen(true)}
                inboxCount={inbox.length}
              />
            </TabsContent>
            <TabsContent value="org" className="min-h-0 flex-1">
              <OpcOrgView
                state={state}
                onAddRoleSlot={handleAddRoleSlot}
                onHire={() => setCustomHireOpen(true)}
                onOpenGenerate={() => setOrgGenerateOpen(true)}
                onOpenPresets={() => setOrgPresetOpen(true)}
                onExportCompany={handleExportCompany}
                onImportCompany={(file) => void handleImportCompany(file)}
                onExportArchitecture={handleExportArchitecture}
                onImportArchitecture={(file) =>
                  void handleImportArchitecture(file)
                }
                onRetrospective={(employee) =>
                  setRetroDialog({ employeeId: employee.id })
                }
                onUpdateEmployee={(employeeId, patch) => {
                  void apply([{ kind: "employee.update", employeeId, patch }]);
                }}
                onDepart={(employeeId) => {
                  void apply([{ kind: "employee.depart", employeeId }]);
                }}
              />
            </TabsContent>
            <TabsContent value="market" className="min-h-0 flex-1">
              <OpcTalentMarket
                state={state}
                onHireTemplate={handleHireTemplate}
                onImportFolder={handleImportRoleFolder}
              />
            </TabsContent>
            <TabsContent value="skills" className="min-h-0 flex-1">
              <OpcSkillsView
                state={state}
                onUpgrade={(skillId) => setUpgradeDialog({ skillId })}
                onExportSkill={handleExportSkill}
                onToggleAttach={(employeeId, skillId, attach) => {
                  void apply([
                    {
                      kind: "employee.assignSkill",
                      employeeId,
                      skillId,
                      attach,
                    },
                  ]);
                }}
                onImportFolder={handleImportSkillFolder}
              />
            </TabsContent>
            <TabsContent value="evolution" className="min-h-0 flex-1">
              <OpcEvolutionView
                state={state}
                onOpenProjectRetro={() => setProjectRetroOpen(true)}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      {escalateDialog ? (
        <OpcEscalateDialog
          state={state}
          workItem={escalateDialog}
          onClose={() => setEscalateDialog(null)}
          onSubmit={(mutations) => {
            void apply(mutations);
            setEscalateDialog(null);
          }}
        />
      ) : null}
      {projectRetroOpen ? (
        <OpcProjectRetroDialog
          onClose={() => setProjectRetroOpen(false)}
          workspaceIdentity={workspaceIdentity}
        />
      ) : null}
      {orgGenerateOpen ? (
        <OpcOrgGenerateDialog
          onClose={() => setOrgGenerateOpen(false)}
          workspaceIdentity={workspaceIdentity}
        />
      ) : null}
      {orgPresetOpen ? (
        <OpcOrgPresetDialog onClose={() => setOrgPresetOpen(false)} />
      ) : null}
      {inboxOpen ? (
        <OpcInboxDialog onClose={() => setInboxOpen(false)} />
      ) : null}
      {reworkDialog ? (
        <OpcReworkDialog
          workItem={reworkDialog}
          onClose={() => setReworkDialog(null)}
          onSubmit={(mutations) => {
            void apply(mutations);
            setReworkDialog(null);
          }}
        />
      ) : null}
      {workItemDialog ? (
        <OpcWorkItemDialog
          state={state}
          initial={workItemDialog}
          onClose={() => setWorkItemDialog(null)}
          onSubmit={(mutations) => {
            void apply(mutations);
            setWorkItemDialog(null);
          }}
        />
      ) : null}
      {hireDialog ? (
        <OpcHireDialog
          state={state}
          template={hireDialog.template}
          onClose={() => setHireDialog(null)}
          onSubmit={(mutations) => {
            void apply(mutations);
            setHireDialog(null);
          }}
        />
      ) : null}
      {customHireOpen ? (
        <OpcCustomHireDialog
          onClose={() => setCustomHireOpen(false)}
          onSubmit={(mutations) => {
            void apply(mutations);
            setCustomHireOpen(false);
          }}
        />
      ) : null}
      {retroDialog ? (
        <OpcRetroDialog
          state={state}
          initialEmployeeId={retroDialog.employeeId}
          onClose={() => setRetroDialog(null)}
          workspaceIdentity={workspaceIdentity}
        />
      ) : null}
      {upgradeDialog ? (
        <OpcUpgradeDialog
          state={state}
          skillId={upgradeDialog.skillId}
          onClose={() => setUpgradeDialog(null)}
          workspaceIdentity={workspaceIdentity}
        />
      ) : null}
    </>
  );
}
