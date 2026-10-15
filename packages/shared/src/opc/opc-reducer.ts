/* eslint-disable max-lines -- 全部 mutation 的语义收口（case 分支密集，拆散会丢失状态机全景）. */
/**
 * zcode-go OPC 状态 reducer：applyOpcMutation 是全部写路径的唯一语义收口。
 * UI 与 main 共享本文件，保证「UI 预览的合法性」与「main 落盘的合法性」同一套规则。
 * 纯函数：非法 mutation 返回 error，不抛异常（IPC 边界友好）。
 */
import {
  createOpcEntityId,
  evaluateOpcPromotions,
  recordOpcRetro,
} from "./opc-evolution.js";
import { opcStableId, parseOpcRoleTemplate } from "./opc-template-format.js";
import {
  isOpcWorkItemTransition,
  type OpcCompanyState,
  type OpcEmployee,
  type OpcEvolutionEvent,
  type OpcMutation,
  type OpcMutationResult,
  type OpcRoleSlot,
} from "./opc-types.js";

export function createEmptyOpcCompanyState(now: number): OpcCompanyState {
  const founder: OpcEmployee = {
    id: "emp_founder",
    name: "创始人（CEO）",
    templateId: "custom",
    roleId: null,
    category: "executive",
    emoji: "👑",
    color: "amber",
    vibe: "定方向、拆目标、验收结果",
    description:
      "公司所有者。OpenOPC 语义下的 final decider：团队解决不了的事升级到这里。",
    seniority: "lead",
    status: "active",
    skillRefs: [],
    stats: { completed: 0, retrospectives: 0, lessons: 0 },
    createdAt: now,
    isFallback: true,
  };
  return {
    schemaVersion: 1,
    company: { name: "我的 OPC 公司", createdAt: now, topology: "flat" },
    roleSlots: [],
    employees: [founder],
    workItems: [],
    lessons: [],
    skills: [],
    roleTemplates: [],
    evolution: [
      {
        id: createOpcEntityId("ev", now),
        at: now,
        kind: "company-init",
        summary: "公司成立：初始化创始人（CEO）",
      },
    ],
  };
}

export function applyOpcMutation(
  state: OpcCompanyState,
  mutation: OpcMutation,
  now: number,
): OpcMutationResult {
  const applied = applyOnce(state, mutation, now);
  // 复盘后评估晋升（Self-Grown：2 次独立复盘同指纹 → 自动晋升）
  if (mutation.kind === "retro.record") {
    const promotion = evaluateOpcPromotions(applied.state, now);
    return {
      state: promotion.state,
      events: [...applied.events, ...promotion.events],
      promotedSkillIds: promotion.promotedSkillIds,
    };
  }
  return { state: applied.state, events: applied.events, promotedSkillIds: [] };
}

interface ApplyOnceResult {
  state: OpcCompanyState;
  events: OpcEvolutionEvent[];
}

function applyOnce(
  state: OpcCompanyState,
  mutation: OpcMutation,
  now: number,
): ApplyOnceResult {
  switch (mutation.kind) {
    case "company.rename": {
      const name = mutation.name.trim();
      if (!name) return { state, events: [] };
      return {
        state: { ...state, company: { ...state.company, name } },
        events: [],
      };
    }
    case "role-slot.create": {
      const title = mutation.title.trim();
      if (!title) return { state, events: [] };
      return {
        state: {
          ...state,
          roleSlots: [
            ...state.roleSlots,
            {
              id: createOpcEntityId("slot", now),
              title,
              parentRoleId: null,
              employeeId: null,
            },
          ],
        },
        events: [],
      };
    }
    case "role-slot.remove": {
      const slot = state.roleSlots.find((item) => item.id === mutation.roleId);
      if (!slot) return { state, events: [] };
      return {
        state: {
          ...state,
          roleSlots: state.roleSlots.filter(
            (item) => item.id !== mutation.roleId,
          ),
          employees: state.employees.map((employee) =>
            employee.roleId === mutation.roleId
              ? { ...employee, roleId: null }
              : employee,
          ),
        },
        events: [],
      };
    }
    case "employee.hire": {
      // 展示字段统一从 custom 草稿来：自定义招聘由用户填写；模板招聘由 UI 按
      // templateId 解出模板五字段后传入（内置或导入模板，reducer 不感知模板库）。
      const custom = mutation.custom;
      const name = custom?.name?.trim();
      if (!name) return { state, events: [] };
      const employee: OpcEmployee = {
        id: opcStableId("emp", `${name}-${now}`),
        name,
        templateId: mutation.templateId,
        roleId: mutation.roleId,
        category: custom?.category || "general",
        emoji: custom?.emoji || "🧑‍💼",
        color: custom?.color || "slate",
        vibe: custom?.vibe || "",
        description: custom?.description || "",
        seniority: custom?.seniority || "junior",
        status: "active",
        skillRefs: mutation.skillRefs ? [...mutation.skillRefs] : [],
        stats: { completed: 0, retrospectives: 0, lessons: 0 },
        createdAt: now,
      };
      const roleSlots = bindEmployeeToRole(
        state.roleSlots,
        employee.roleId,
        employee.id,
      );
      return {
        state: {
          ...state,
          employees: [...state.employees, employee],
          roleSlots,
        },
        events: [
          {
            id: createOpcEntityId("ev", now),
            at: now,
            kind: "hire",
            summary: `招聘 ${employee.name}（${employee.category}/${employee.seniority}，模板 ${employee.templateId}）`,
          },
        ],
      };
    }
    case "employee.update": {
      const previous = state.employees.find(
        (item) => item.id === mutation.employeeId,
      );
      if (!previous) return { state, events: [] };
      const employees = state.employees.map((item) =>
        item.id === mutation.employeeId ? { ...item, ...mutation.patch } : item,
      );
      // 换岗位时同步槽位占用（老槽位让出、新槽位绑定）。
      const roleSlots =
        mutation.patch.roleId !== undefined &&
        mutation.patch.roleId !== previous.roleId
          ? bindEmployeeToRole(
              state.roleSlots,
              mutation.patch.roleId,
              mutation.employeeId,
            )
          : state.roleSlots;
      return { state: { ...state, employees, roleSlots }, events: [] };
    }
    case "employee.depart": {
      const employee = state.employees.find(
        (item) => item.id === mutation.employeeId,
      );
      if (!employee) return { state, events: [] };
      return {
        state: {
          ...state,
          employees: state.employees.map((item) =>
            item.id === mutation.employeeId
              ? { ...item, status: "departed" as const }
              : item,
          ),
          roleSlots: state.roleSlots.map((slot) =>
            slot.employeeId === mutation.employeeId
              ? { ...slot, employeeId: null }
              : slot,
          ),
          workItems: state.workItems.map((item) =>
            item.assigneeId === mutation.employeeId &&
            item.status !== "done" &&
            item.status !== "cancelled"
              ? { ...item, assigneeId: null, updatedAt: now }
              : item,
          ),
        },
        events: [
          {
            id: createOpcEntityId("ev", now),
            at: now,
            kind: "depart",
            summary: `${employee.name} 离职（历史经验保留）`,
          },
        ],
      };
    }
    case "employee.assignSkill": {
      return {
        state: {
          ...state,
          employees: state.employees.map((item) => {
            if (item.id !== mutation.employeeId) return item;
            const has = item.skillRefs.includes(mutation.skillId);
            if (mutation.attach && !has) {
              return {
                ...item,
                skillRefs: [...item.skillRefs, mutation.skillId],
              };
            }
            if (!mutation.attach && has) {
              return {
                ...item,
                skillRefs: item.skillRefs.filter(
                  (id) => id !== mutation.skillId,
                ),
              };
            }
            return item;
          }),
        },
        events: [],
      };
    }
    case "workitem.create": {
      const title = mutation.title.trim();
      if (!title) return { state, events: [] };
      const timestamp = now;
      return {
        state: {
          ...state,
          workItems: [
            ...state.workItems,
            {
              id: createOpcEntityId("wi", timestamp),
              title,
              detail: mutation.detail ?? "",
              status: "backlog",
              assigneeId: mutation.assigneeId ?? null,
              priority: mutation.priority ?? "medium",
              dependsOn: mutation.dependsOn ? [...mutation.dependsOn] : [],
              createdAt: timestamp,
              updatedAt: timestamp,
              completedAt: null,
            },
          ],
        },
        events: [
          {
            id: createOpcEntityId("ev", timestamp),
            at: timestamp,
            kind: "workitem",
            summary: `新增工作项：${title}`,
          },
        ],
      };
    }
    case "workitem.update": {
      return {
        state: {
          ...state,
          workItems: state.workItems.map((item) =>
            item.id === mutation.workItemId
              ? { ...item, ...mutation.patch, updatedAt: now }
              : item,
          ),
        },
        events: [],
      };
    }
    case "workitem.status": {
      const target = state.workItems.find(
        (item) => item.id === mutation.workItemId,
      );
      if (!target) return { state, events: [] };
      if (!isOpcWorkItemTransition(target.status, mutation.status)) {
        return { state, events: [] };
      }
      return {
        state: {
          ...state,
          workItems: state.workItems.map((item) =>
            item.id === mutation.workItemId
              ? {
                  ...item,
                  status: mutation.status,
                  updatedAt: now,
                  completedAt: mutation.status === "done" ? now : null,
                }
              : item,
          ),
        },
        events:
          mutation.status === "done"
            ? [
                {
                  id: createOpcEntityId("ev", now),
                  at: now,
                  kind: "workitem",
                  summary: `工作项完成：${target.title}`,
                },
              ]
            : [],
      };
    }
    case "workitem.delete": {
      return {
        state: {
          ...state,
          workItems: state.workItems.filter(
            (item) => item.id !== mutation.workItemId,
          ),
        },
        events: [],
      };
    }
    case "retro.record": {
      const retro = recordOpcRetro(state, {
        employeeId: mutation.employeeId,
        workItemId: mutation.workItemId ?? null,
        lessons: mutation.lessons,
        note: mutation.note,
        now,
      });
      // 完成统计：带 workItemId 的复盘视为该工作项收口（stats.completed +1）
      const withCompletion =
        mutation.workItemId != null
          ? {
              ...retro.state,
              employees: retro.state.employees.map((item) =>
                item.id === mutation.employeeId
                  ? {
                      ...item,
                      stats: {
                        ...item.stats,
                        completed: item.stats.completed + 1,
                      },
                    }
                  : item,
              ),
            }
          : retro.state;
      return { state: withCompletion, events: retro.events };
    }
    case "skill.import": {
      const id = mutation.skillId
        ? opcStableId("skill", mutation.skillId)
        : opcStableId("skill", mutation.name);
      const existing = state.skills.find((skill) => skill.id === id);
      if (existing) {
        // 版本覆盖：正文与元数据更新，版本 +1（SKILL.md 由 main 落盘）
        return {
          state: {
            ...state,
            skills: state.skills.map((skill) =>
              skill.id === id
                ? {
                    ...skill,
                    name: mutation.name,
                    description: mutation.description,
                    category: mutation.category ?? skill.category,
                    version: skill.version + 1,
                    changelog: [
                      ...skill.changelog,
                      `v${skill.version + 1}：重新导入覆盖（${new Date(now).toISOString().slice(0, 10)}）`,
                    ],
                    updatedAt: now,
                  }
                : skill,
            ),
          },
          events: [
            {
              id: createOpcEntityId("ev", now),
              at: now,
              kind: "skill-import",
              summary: `技能 ${id} 重新导入（v${(existing.version ?? 0) + 1}）`,
            },
          ],
        };
      }
      return {
        state: {
          ...state,
          skills: [
            ...state.skills,
            {
              id,
              name: mutation.name,
              description: mutation.description,
              category: mutation.category ?? "general",
              version: 1,
              origin: "imported",
              changelog: [
                `v1：从外部导入（${new Date(now).toISOString().slice(0, 10)}）`,
              ],
              updatedAt: now,
            },
          ],
        },
        events: [
          {
            id: createOpcEntityId("ev", now),
            at: now,
            kind: "skill-import",
            summary: `导入技能 ${id}`,
          },
        ],
      };
    }
    case "skill.upgrade": {
      return {
        state: {
          ...state,
          skills: state.skills.map((skill) =>
            skill.id === mutation.skillId
              ? {
                  ...skill,
                  version: skill.version + 1,
                  changelog: [
                    ...skill.changelog,
                    `v${skill.version + 1}：${mutation.note || "自主迭代升级"}（${new Date(now).toISOString().slice(0, 10)}）`,
                  ],
                  updatedAt: now,
                }
              : skill,
          ),
        },
        events: [
          {
            id: createOpcEntityId("ev", now),
            at: now,
            kind: "skill-upgrade",
            summary: `技能 ${mutation.skillId} 升级到 v${
              (state.skills.find((skill) => skill.id === mutation.skillId)
                ?.version ?? 0) + 1
            }`,
          },
        ],
      };
    }
    case "skill.remove": {
      return {
        state: {
          ...state,
          skills: state.skills.filter((skill) => skill.id !== mutation.skillId),
          employees: state.employees.map((item) => ({
            ...item,
            skillRefs: item.skillRefs.filter((id) => id !== mutation.skillId),
          })),
        },
        events: [],
      };
    }
    case "template.importRole": {
      const draft = parseOpcRoleTemplate(mutation.markdown);
      if (!draft) return { state, events: [] };
      const exists = state.roleTemplates.some(
        (template) => template.id === draft.id,
      );
      if (exists) {
        return {
          state: {
            ...state,
            roleTemplates: state.roleTemplates.map((template) =>
              template.id === draft.id
                ? {
                    ...template,
                    name: draft.name,
                    description: draft.description,
                    color: draft.color,
                    emoji: draft.emoji,
                    vibe: draft.vibe,
                    category: draft.category,
                    importedAt: now,
                  }
                : template,
            ),
          },
          events: [],
        };
      }
      return {
        state: {
          ...state,
          roleTemplates: [
            ...state.roleTemplates,
            {
              id: draft.id,
              name: draft.name,
              description: draft.description,
              color: draft.color,
              emoji: draft.emoji,
              vibe: draft.vibe,
              category: draft.category,
              origin: "imported",
              importedAt: now,
            },
          ],
        },
        events: [
          {
            id: createOpcEntityId("ev", now),
            at: now,
            kind: "template-import",
            summary: `导入角色模板：${draft.name}`,
          },
        ],
      };
    }
    default:
      return { state, events: [] };
  }
}

function bindEmployeeToRole(
  roleSlots: OpcRoleSlot[],
  roleId: string | null,
  employeeId: string,
): OpcRoleSlot[] {
  if (!roleId) return roleSlots;
  return roleSlots.map((slot) =>
    slot.id === roleId
      ? { ...slot, employeeId }
      : slot.employeeId === employeeId
        ? { ...slot, employeeId: null }
        : slot,
  );
}
