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
  buildOpcEmployeeMemoryDenylist,
  buildOpcEmployeeMemoryPromptSection,
  buildOpcPersonaPromptSection,
  isOpcWorkItemRunnable,
  opcEmployeeMemoryIdentity,
  type ModelSelection,
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
  /** 员工持久记忆的 MEMORY.md 索引（GetState 时 main 批量绑定并回读，
   * key=employeeId）。缺员工条目视为索引未建（prompt 走初期分支）。 */
  employeeMemoryIndexes?: Record<string, string | null>;
  /** 员工人格画像摘要（persona.md 前 ~600 字，GetState 回读） */
  employeePersonaDigests?: Record<string, string | null>;
  /** 员工原则文件 name 清单（L2 归纳产物；反思轮的既有原则清单） */
  employeePrinciples?: Record<string, string[]>;
  /** 员工记忆根相对工作区的显示路径（GetState 回读；委派 prompt 的写入指引。
   * 缺条目 = 绑定未就绪，不注入记忆段——指向不存在的目录会误导员工写入。） */
  employeeMemoryPaths?: Record<string, string>;
  /**
   * 派发钉定的模型选型（工作区当前选型，含档位）。员工 db 是全新空库，
   * 不显式钉定时会落到 builtin 默认模型（如 gpt-6-astra）——与用户所选
   * 模型不符且可能放大调用成本。缺失时宁可不派发（fail-safe）。
   */
  modelSelection?: ModelSelection;
  /** 并发上限（同时 headless 会话数）；超出留待下一轮手动编排。 */
  cap?: number;
  /**
   * 逐项落账回调：每项派发成功立即写 in_progress + sessionId。批量返回的
   * mutations 仍在 outcome 里，但逐项即时落账防「全部派发完才落账」的窗口
   * ——期间崩溃/apply 失败会让 ready 项带着已跑会话再次被派发（双跑）。
   */
  onMutations?: (mutations: OpcMutation[]) => void;
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
 * 派发全部就绪项：ready + runnable + 已分配 + 未派发过（sessionId 幂等锚）。
 * 逐项无界面建会话并发送委派 prompt；并发门控按「在跑 headless 会话数」
 * （in_progress 且有 sessionId）计算剩余配额。逐项派发成功即经 onMutations
 * 落账；单项失败不中断批（失败项留待下一轮）。
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
  const runningCount = state.workItems.filter(
    (item) => item.status === "in_progress" && item.sessionId,
  ).length;
  const remaining = Math.max(0, cap - runningCount);
  // fail-safe：无钉定选型不派发——员工空库下不传选型 = 落 builtin 默认模型
  //（可能是用户没选过的高价模型），宁可留 ready 也不烧错模型的钱。
  if (!deps.modelSelection) {
    return { dispatched: [], failed: [], mutations: [] };
  }
  const dispatchable = state.workItems
    .filter(
      (item) =>
        item.status === "ready" &&
        item.assigneeId !== null &&
        isOpcWorkItemRunnable(item, state.workItems) &&
        // 幂等锚：派发过（sessionId 已回写）的项永不重派——状态落账失败也
        // 不会双跑
        !item.sessionId,
    )
    .slice(0, remaining);
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
    const employee = state.employees.find((item) => item.id === workItem.assigneeId);
    if (!employee) {
      outcome.failed.push({ workItemId: workItem.id, error: "员工缺失" });
      continue;
    }
    // 员工持久记忆：绑定（.opc data dir 内的记忆根）→ 索引注入 prompt；
    // 会话身份切到员工键（记忆根与会话隔离同键，spec「员工持久记忆」）。
    const personaSection = buildOpcPersonaPromptSection(
      deps.employeePersonaDigests?.[employee.id] ?? null,
    );
    let memorySection: string | null = null;
    const memoryDirDisplay = deps.employeeMemoryPaths?.[employee.id] ?? null;
    if (permissionLevel !== "read-only" && memoryDirDisplay) {
      // read-only 员工无写工具，记忆维护指令会与权限约束矛盾——不注入
      // （其记忆依赖 CLI 管线的自动抽取，spec 边界已注明）。
      memorySection = buildOpcEmployeeMemoryPromptSection({
        memoryDirDisplay,
        memoryIndex: deps.employeeMemoryIndexes?.[employee.id] ?? null,
      });
    }
    const memoryDenylist = buildOpcEmployeeMemoryDenylist(
      employee.id,
      state.employees.map((item) => item.id),
    );
    try {
      const created = await taskService.createTask({
        workspacePath,
        // 员工键覆盖 workspace 键：记忆根与会话隔离落到员工维度
        workspaceIdentity: opcEmployeeMemoryIdentity(employee.id, workspacePath),
        // 钉定模型：员工会话跟随工作区当前选型（防 builtin 默认兜底烧错模型）
        modelSelection: deps.modelSelection,
        v4Create: true,
        deferPersistenceUntilFirstPrompt: true,
        permissionScope: "session",
      });
      await taskService.sendPrompt({
        taskId: created.taskId,
        traceId: workItem.id,
        content:
          (personaSection ? personaSection + "\n\n" : "") +
          (memorySection ? `${prompt}\n\n${memorySection}` : prompt),
        // 会话级硬约束：按员工权限级别隐藏写入/执行类工具（无界面会话由我们
        // 创建，参数即真约束；手动 composer 路径仍为委派 prompt 级边界）。
        // 追加员工记忆隔离：其它员工记忆目录读写拒绝 + 公司状态写保护。
        toolDenylist: [
          ...(buildOpcToolDenylist(permissionLevel) ?? []),
          ...memoryDenylist,
        ],
      });
      outcome.dispatched.push({
        workItemId: workItem.id,
        taskId: created.taskId,
      });
      const itemMutations: OpcMutation[] = [
        {
          kind: "workitem.status",
          workItemId: workItem.id,
          status: "in_progress",
        },
        // 派发留痕：taskId 写回工作项，任务列表可从看板双向追溯
        {
          kind: "workitem.update",
          workItemId: workItem.id,
          patch: { sessionId: created.taskId },
        },
      ];
      outcome.mutations.push(...itemMutations);
      // 逐项即时落账：批量落账前的崩溃窗口会留下「会话在跑、项仍 ready」
      // 的双跑态
      deps.onMutations?.(itemMutations);
    } catch (error) {
      outcome.failed.push({
        workItemId: workItem.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}

/** 可编排数量（UI 按钮显隐）：与 dispatchable 同过滤（含 sessionId 幂等锚）。 */
export function countOrchestratable(state: OpcCompanyState): number {
  return state.workItems.filter(
    (item) =>
      item.status === "ready" &&
      item.assigneeId !== null &&
      isOpcWorkItemRunnable(item, state.workItems) &&
      !item.sessionId,
  ).length;
}
