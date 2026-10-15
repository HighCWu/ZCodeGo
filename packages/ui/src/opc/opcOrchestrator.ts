/**
 * zcode-go OPC 编排器（Self-Run 自动派发，desktop-continuous 链路）：
 * 把「就绪且已分配」的工作项经 IZCodeTaskService 无界面派发为后台会话
 * （v4Create + deferPersistenceUntilFirstPrompt——bots/automation 同款模式），
 * 派发即 in_progress；完成仍由人工在任务列表验收（opc-done watcher 只覆盖
 * 有面板的会话，headless 会话的完成判定如实标注为人工）。
 * 门控：AppSettings.zcodeGoOpcAutoOrchestrate（默认启用）。
 */
import type { IZCodeTaskService } from "@zcode/services";
import {
  buildOpcDelegationPrompt,
  buildOpcToolDenylist,
  isOpcWorkItemRunnable,
  type OpcCompanyState,
  type OpcMutation,
  type OpcPermissionLevel,
  type OpcWorkItem,
} from "@zcode/shared";

export interface OpcOrchestratorDeps {
  state: OpcCompanyState;
  workspacePath: string;
  workspaceIdentity?: string;
  taskService: IZCodeTaskService;
  resolveRoleBody: (templateId: string) => string | null;
  resolveSkillBody: (skillId: string) => string | null;
  /** 并发上限（同时 headless 会话数）；超出留待下一轮手动编排。 */
  cap?: number;
}

export interface OpcOrchestrationOutcome {
  dispatched: Array<{ workItemId: string; taskId: string }>;
  failed: Array<{ workItemId: string; error: string }>;
  mutations: OpcMutation[];
}

function buildDelegationPromptFor(
  state: OpcCompanyState,
  workItem: OpcWorkItem,
  deps: Pick<OpcOrchestratorDeps, "resolveRoleBody" | "resolveSkillBody">,
): { prompt: string; permissionLevel: OpcPermissionLevel | undefined } | null {
  const employee = state.employees.find(
    (item) => item.id === workItem.assigneeId,
  );
  if (!employee) return null;
  const roleBody =
    employee.templateId === "custom"
      ? null
      : deps.resolveRoleBody(employee.templateId);
  const skillBodies = employee.skillRefs
    .map((skillId) => {
      const meta = state.skills.find((skill) => skill.id === skillId);
      const body = deps.resolveSkillBody(skillId);
      return meta && body ? { id: skillId, name: meta.name, body } : null;
    })
    .filter(
      (item): item is { id: string; name: string; body: string } =>
        item !== null,
    );
  const delegationPrompt = buildOpcDelegationPrompt({
    companyName: state.company.name,
    employee,
    roleBody,
    workItem,
    skillBodies,
    skillNamesRemaining: [],
    recentLessons: state.lessons
      .filter((lesson) => lesson.employeeId === employee.id)
      .slice(-10)
      .map((lesson) => lesson.statement),
    memoryFilePath: `.opc/memory/${employee.id}.md`,
    reworkNotes: workItem.reworkNotes,
    permissionLevel: employee.permissionLevel,
  });
  return {
    prompt: delegationPrompt,
    permissionLevel: employee.permissionLevel,
  };
}

/**
 * 派发全部就绪项：ready + runnable + 已分配 + 未在执行中。逐项无界面建会话并
 * 发送委派 prompt（并发上限 cap）；全部派发完成后批量推 in_progress。
 * 单项失败不中断批（失败项留待下一轮）。
 */
export async function dispatchReadyWorkItems(
  deps: OpcOrchestratorDeps,
): Promise<OpcOrchestrationOutcome> {
  const {
    state,
    workspacePath,
    workspaceIdentity,
    taskService,
    cap = 3,
  } = deps;
  const dispatchable = state.workItems.filter(
    (item) =>
      item.status === "ready" &&
      item.assigneeId !== null &&
      isOpcWorkItemRunnable(item, state.workItems),
  );
  const outcome: OpcOrchestrationOutcome = {
    dispatched: [],
    failed: [],
    mutations: [],
  };
  for (const workItem of dispatchable.slice(0, cap)) {
    const delegation = buildDelegationPromptFor(state, workItem, deps);
    if (!delegation) {
      outcome.failed.push({
        workItemId: workItem.id,
        error: "员工缺失或无可用上下文",
      });
      continue;
    }
    const { prompt, permissionLevel } = delegation;
    try {
      const created = await taskService.createTask({
        workspacePath,
        workspaceIdentity,
        v4Create: true,
        deferPersistenceUntilFirstPrompt: true,
        permissionScope: "session",
      });
      await taskService.sendPrompt({
        taskId: created.taskId,
        traceId: `${workItem.id}` as never,
        content: prompt,
        // 会话级硬约束：按员工权限级别隐藏写入/执行类工具（无界面会话由我们
        // 创建，参数即真约束；手动 composer 路径仍为委派 prompt 级边界）。
        toolDenylist: buildOpcToolDenylist(permissionLevel),
      });
      outcome.dispatched.push({
        workItemId: workItem.id,
        taskId: created.taskId,
      });
      outcome.mutations.push({
        kind: "workitem.status",
        workItemId: workItem.id,
        status: "in_progress",
      });
    } catch (error) {
      outcome.failed.push({
        workItemId: workItem.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}

/** 可编排数量（UI 按钮显隐）。 */
export function countOrchestratable(state: OpcCompanyState): number {
  return state.workItems.filter(
    (item) =>
      item.status === "ready" &&
      item.assigneeId !== null &&
      isOpcWorkItemRunnable(item, state.workItems),
  ).length;
}
