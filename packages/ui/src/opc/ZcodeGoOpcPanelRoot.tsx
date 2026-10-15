/* oxlint-disable eslint(max-lines) -- 公司面板是五标签 + 全部管理动作的编排收口（同 SessionPane/插件宿主惯例），拆散会破坏内聚。 */
/**
 * zcode-go OPC 公司面板（全屏 overlay，五标签：看板/组织/人才市场/技能/进化）。
 *
 * 打开方式：App 挂载 useZcodeGoOpcPanel 后，任意组件派发
 * window CustomEvent("zcode-go:opc-open") 即可唤起（草稿驾驶舱/快捷键/菜单）。
 * 全部写路径走 opcStore.apply（IPC → main reducer → 广播），本组件零本地状态事实。
 */
import { useCallback, useEffect, useState } from "react";
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
import { insertOpcPrompt } from "./opcComposerBridge.js";
import { downloadTextFile, readFileText } from "./opcFiles.js";
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
import { OpcProjectRetroDialog } from "./opcProjectRetroDialog.js";
import { OpcOrgGenerateDialog, OpcOrgPresetDialog } from "./opcOrgDialogs.js";
import { logger } from "@/logger.js";

export const OPC_OPEN_PANEL_EVENT = "zcode-go:opc-open";

type PanelTab = "kanban" | "office" | "org" | "market" | "skills" | "evolution";

export function ZcodeGoOpcPanelRoot({
  workspaceIdentity,
}: {
  workspaceIdentity?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const state = useOpcStore((s) => s.state);
  const apply = useOpcStore((s) => s.apply);
  const resolveRoleBody = useOpcStore((s) => s.resolveRoleBody);
  const resolveSkillBody = useOpcStore((s) => s.resolveSkillBody);
  const workspacePath = useOpcStore((s) => s.workspacePath);
  const bodies = useOpcStore((s) => s.bodies);
  const inbox = useOpcStore((s) => s.inbox);
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
  const [escalateDialog, setEscalateDialog] = useState<OpcWorkItem | null>(
    null,
  );
  const [projectRetroOpen, setProjectRetroOpen] = useState(false);
  const [orgGenerateOpen, setOrgGenerateOpen] = useState(false);
  const [orgPresetOpen, setOrgPresetOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [upgradeDialog, setUpgradeDialog] =
    useState<OpcUpgradeDialogState | null>(null);

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener(OPC_OPEN_PANEL_EVENT, handleOpen);
    return () => window.removeEventListener(OPC_OPEN_PANEL_EVENT, handleOpen);
  }, []);

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
    (workItem: OpcWorkItem) => {
      if (!state || !workspacePath) return;
      const dependents = state.workItems
        .filter((item) => item.dependsOn.includes(workItem.id))
        .map((item) => ({
          title: item.title,
          assigneeName:
            state.employees.find((employee) => employee.id === item.assigneeId)
              ?.name ?? null,
        }));
      const inserted = insertOpcPrompt({
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? undefined,
        text: buildOpcIntegrationPrompt({
          completedTitle: workItem.title,
          completedDetail: workItem.detail,
          dependents,
        }),
      });
      if (inserted) setOpen(false);
    },
    [state, workspacePath, workspaceIdentity],
  );

  const handleDeleteWorkItem = useCallback(
    (workItemId: string) => {
      void apply([{ kind: "workitem.delete", workItemId }]);
    },
    [apply],
  );

  /** 委派：角色正文 + 挂接技能 + 最近经验 → 委派 prompt → composer（用户确认发送）。 */
  const handleDelegate = useCallback(
    (workItem: OpcWorkItem) => {
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
      const inserted = insertOpcPrompt({
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? undefined,
        text: prompt,
      });
      if (inserted) {
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
      }
    },
    [
      state,
      workspacePath,
      workspaceIdentity,
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
            </TabsList>
            <TabsContent value="office" className="min-h-0 flex-1">
              <OpcOfficeMap
                state={state}
                onRetrospective={(employee) =>
                  setRetroDialog({ employeeId: employee.id })
                }
              />
            </TabsContent>
            <TabsContent value="kanban" className="min-h-0 flex-1">
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
