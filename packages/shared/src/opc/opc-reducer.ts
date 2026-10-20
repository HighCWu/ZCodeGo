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
import { compareOpcFingerprints } from "./opc-fingerprint.js";
import type { OpcModelFingerprintEntry } from "./opc-types.js";
import {
  isOpcWorkItemRunnable,
  isOpcWorkItemTransition,
  type OpcCompanyState,
  type OpcEmployee,
  type OpcEvolutionEvent,
  type OpcMutation,
  type OpcMutationResult,
  type OpcRoleSlot,
  type OpcWorkItem,
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
  // 进化事件统一合并进 state.evolution（spec「所有权与边界」：evolution-log
  // 是事件镜像）。此前各 case 分裂：retro/promote 自行写入、escalate/
  // transfer/rework 等只回响应——后者从未落 evolution-log（留痕承诺未兑现）。
  // 按事件 id 去重，两种形态（自行写入/只返回）都恰好落一次。
  if (applied.events.length > 0) {
    const merged = [...applied.state.evolution];
    const seen = new Set(merged.map((event) => event.id));
    for (const event of applied.events) {
      if (!seen.has(event.id)) merged.push(event);
    }
    if (merged.length !== applied.state.evolution.length) {
      return {
        state: { ...applied.state, evolution: merged },
        events: applied.events,
        promotedSkillIds: [],
      };
    }
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
              id: mutation.id ?? createOpcEntityId("slot", now),
              title,
              // 汇报上级：上级岗位不存在（悬空引用）时落为顶层，避免死链
              parentRoleId:
                mutation.parentRoleId &&
                (mutation.parentRoleId === mutation.id ||
                  state.roleSlots.some(
                    (slot) => slot.id === mutation.parentRoleId,
                  ))
                  ? mutation.parentRoleId
                  : null,
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
          roleSlots: state.roleSlots
            .filter((item) => item.id !== mutation.roleId)
            .map((item) =>
              // 子岗位提升为顶层：parent 悬空会产生渲染死链
              item.parentRoleId === mutation.roleId
                ? { ...item, parentRoleId: null }
                : item,
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
        permissionLevel: custom?.permissionLevel,
        // 公司包导入 paused 员工时保持暂停态（导入语义保真）；缺省 active
        status: custom?.status === "paused" ? "paused" : "active",
        skillRefs: [
          ...new Set([
            ...(mutation.skillRefs ? [...mutation.skillRefs] : []),
            // 新员工入职即继承共享 playbook（OpenOPC 语义：晋升技能是组织
            // 资产而非个人所有；tombstone 中的已删技能精确排除）
            ...state.skills
              .filter((skill) => skill.origin === "promoted")
              .filter(
                (skill) =>
                  !(state.promotedSkillTombstones ?? []).includes(skill.id),
              )
              .map((skill) => skill.id),
          ]),
        ],
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
      // modelSelection 的 null 哨兵归一为键删除（IPC 克隆会丢 undefined 键，
      // 显式清除必须经 null 表达）。
      const { modelSelection: modelSelectionPatch, ...restPatch } = mutation.patch;
      const patch: Partial<OpcEmployee> =
        modelSelectionPatch === null
          ? { ...restPatch, modelSelection: undefined }
          : {
              ...restPatch,
              ...(modelSelectionPatch !== undefined
                ? { modelSelection: modelSelectionPatch }
                : {}),
            };
      const employees = state.employees.map((item) =>
        item.id === mutation.employeeId ? { ...item, ...patch } : item,
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
    case "employee.resetPersona": {
      // 人格画像重置（spec「人格画像」）：persona.md 的删除在 desktop Apply
      // handler 落地（fs 副作用不过 reducer）；这里只留进化事件痕迹。
      const employee = state.employees.find(
        (item) => item.id === mutation.employeeId,
      );
      if (!employee) return { state, events: [] };
      // 主档冻结（spec「记忆主档与多地点」）：员工有在跑任务时拒绝重置——
      // 执行中的抽取/反思轮可能正在写 persona.md，删除会与写入竞态；
      // 静默 no-op（同 workitem.status 非法转换），Apply handler 以事件
      // 是否产生判定是否执行 fs 删除。
      const busy = state.workItems.some(
        (workItem) =>
          workItem.assigneeId === mutation.employeeId &&
          workItem.status === "in_progress" &&
          Boolean(workItem.sessionId),
      );
      if (busy) return { state, events: [] };
      const now = Date.now();
      return {
        state,
        events: [
          {
            id: opcStableId("ev", `${employee.name}-persona-reset-${now}`),
            at: now,
            kind: "persona-reset",
            summary: `重置 ${employee.name} 的人格画像（persona.md 已删除，记忆事实保留）`,
          },
        ],
      };
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
              // 任务分解树：父项由 UI 传（管理者拆解动作）；悬空父引用落 null
              parentWorkItemId:
                mutation.parentWorkItemId &&
                state.workItems.some(
                  (item) => item.id === mutation.parentWorkItemId,
                )
                  ? mutation.parentWorkItemId
                  : null,
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
      // 依赖就绪门控：进入执行态必须前置全部解决（OpenOPC "runnability"）。
      if (
        mutation.status === "in_progress" &&
        !isOpcWorkItemRunnable(target, state.workItems)
      ) {
        return { state, events: [] };
      }
      let workItems: OpcWorkItem[] = state.workItems.map((item) =>
        item.id === mutation.workItemId
          ? {
              ...item,
              status: mutation.status,
              updatedAt: now,
              completedAt: mutation.status === "done" ? now : null,
              // 终态即解除升级：不清则 done 项仍显示「升级中」徽标、
              // 计入待所有者处理，且 resolveEscalation 可把创始人指派到已终态项
              ...(mutation.status === "done" || mutation.status === "cancelled"
                ? { escalatedAt: null, escalationNote: null }
                : {}),
            }
          : item,
      );
      // 依赖传播：前置完成 → backlog 中的被依赖项全部就绪时自动升 ready（静默）。
      if (mutation.status === "done") {
        workItems = workItems.map((item) =>
          item.status === "backlog" &&
          item.dependsOn.includes(mutation.workItemId) &&
          isOpcWorkItemRunnable(item, workItems)
            ? { ...item, status: "ready" as const, updatedAt: now }
            : item,
        );
      }
      return {
        state: { ...state, workItems },
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
    case "workitem.escalate": {
      const target = state.workItems.find(
        (item) => item.id === mutation.workItemId,
      );
      if (
        !target ||
        target.status === "done" ||
        target.status === "cancelled"
      ) {
        return { state, events: [] };
      }
      return {
        state: {
          ...state,
          workItems: state.workItems.map((item) =>
            item.id === mutation.workItemId
              ? {
                  ...item,
                  escalatedAt: now,
                  escalationNote: mutation.note?.trim() || undefined,
                  updatedAt: now,
                }
              : item,
          ),
        },
        events: [
          {
            id: createOpcEntityId("ev", now),
            at: now,
            kind: "workitem",
            summary: `升级给所有者：${target.title}${mutation.note ? `（${mutation.note}）` : ""}`,
          },
        ],
      };
    }
    case "workitem.resolveEscalation": {
      const target = state.workItems.find(
        (item) => item.id === mutation.workItemId,
      );
      if (!target || !target.escalatedAt) return { state, events: [] };
      // takeover：解除升级并转派创始人（所有者亲自接手）。
      const founder = state.employees.find((item) => item.isFallback);
      return {
        state: {
          ...state,
          workItems: state.workItems.map((item) =>
            item.id === mutation.workItemId
              ? {
                  ...item,
                  escalatedAt: null,
                  escalationNote: undefined,
                  updatedAt: now,
                  ...(mutation.action === "takeover" && founder
                    ? { assigneeId: founder.id }
                    : {}),
                }
              : item,
          ),
        },
        events:
          mutation.action === "takeover"
            ? [
                {
                  id: createOpcEntityId("ev", now),
                  at: now,
                  kind: "workitem",
                  summary: `所有者接手：${target.title}`,
                },
              ]
            : [],
      };
    }
    case "workitem.rework": {
      const target = state.workItems.find(
        (item) => item.id === mutation.workItemId,
      );
      const note = mutation.note.trim();
      if (!target || target.status !== "review" || note.length === 0) {
        return { state, events: [] };
      }
      return {
        state: {
          ...state,
          workItems: state.workItems.map((item) =>
            item.id === mutation.workItemId
              ? {
                  ...item,
                  status: "in_progress" as const,
                  reworkNotes: [...(item.reworkNotes ?? []), note],
                  // 清编排幂等锚：返工后允许编排器重新派发（旧会话已死）
                  ...(item.sessionId ? { sessionId: null } : {}),
                  updatedAt: now,
                }
              : item,
          ),
        },
        events: [
          {
            id: createOpcEntityId("ev", now),
            at: now,
            kind: "workitem",
            summary: `返工退回：${target.title}`,
          },
        ],
      };
    }
    case "workitem.transfer": {
      const target = state.workItems.find(
        (item) => item.id === mutation.workItemId,
      );
      const to = state.employees.find(
        (item) => item.id === mutation.toEmployeeId,
      );
      if (
        !target ||
        !to ||
        to.status !== "active" ||
        to.id === target.assigneeId
      ) {
        return { state, events: [] };
      }
      return {
        state: {
          ...state,
          workItems: state.workItems.map((item) =>
            item.id === mutation.workItemId
              ? { ...item, assigneeId: to.id, updatedAt: now }
              : item,
          ),
        },
        events: [
          {
            id: createOpcEntityId("ev", now),
            at: now,
            kind: "workitem",
            summary: `转派：${target.title} → ${to.name}${mutation.note ? `（${mutation.note}）` : ""}`,
          },
        ],
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
    case "fingerprint.capture": {
      const fingerprint = mutation.fingerprint;
      const existing = state.modelFingerprints?.[fingerprint.modelKey];
      if (!existing) {
        return {
          state: {
            ...state,
            modelFingerprints: {
              ...state.modelFingerprints,
              [fingerprint.modelKey]: {
                baseline: fingerprint,
                last: fingerprint,
              },
            },
          },
          events: [],
        };
      }
      const comparison = compareOpcFingerprints(existing.baseline, fingerprint);
      const changed = comparison.verdict !== "match";
      const events: OpcEvolutionEvent[] = changed
        ? [
            {
              id: createOpcEntityId("ev", now),
              at: now,
              kind: "workitem",
              summary: `模型 ${fingerprint.modelKey} 指纹${comparison.verdict === "mismatch" ? "变动" : "疑似变动"}（meanJsd ${comparison.meanJsd.toFixed(3)}，${comparison.comparedCells} 格可比）——员工能力可能需重新拟合，或确认新指纹`,
            },
          ]
        : [];
      return {
        state: {
          ...state,
          ...(changed
            ? {
                evolution: [...state.evolution, ...events],
              }
            : {}),
          modelFingerprints: {
            ...state.modelFingerprints,
            [fingerprint.modelKey]: {
              baseline: existing.baseline,
              last: fingerprint,
              lastVerdict: comparison.verdict,
              ...(changed ? { lastChangedAt: now } : {}),
            },
          },
        },
        events,
      };
    }
    case "fingerprint.acknowledge": {
      const entry = state.modelFingerprints?.[mutation.modelKey];
      if (!entry) return { state, events: [] };
      return {
        state: {
          ...state,
          modelFingerprints: {
            ...state.modelFingerprints,
            [mutation.modelKey]: {
              ...entry,
              baseline: entry.last,
              lastVerdict: undefined,
              acknowledgedAt: now,
            },
          },
        },
        events: [],
      };
    }
    case "skill.remove": {
      const removed = state.skills.find(
        (skill) => skill.id === mutation.skillId,
      );
      // 晋升技能删除留 tombstone：否则任何一次无关 retro.record 凭历史
      // 批次立即重建已删 playbook（删除不持久）。
      const tombstones =
        removed?.origin === "promoted"
          ? Array.from(
              new Set([
                ...(state.promotedSkillTombstones ?? []),
                mutation.skillId,
              ]),
            )
          : state.promotedSkillTombstones;
      return {
        state: {
          ...state,
          skills: state.skills.filter((skill) => skill.id !== mutation.skillId),
          employees: state.employees.map((item) => ({
            ...item,
            skillRefs: item.skillRefs.filter((id) => id !== mutation.skillId),
          })),
          ...(tombstones ? { promotedSkillTombstones: tombstones } : {}),
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
  if (!roleId) {
    // null = 上岗「不占槽」：必须释放旧槽，否则暂停员工复用为无槽后
    // slot.employeeId 仍指向他，组织视图出现幽灵占用
    return roleSlots.map((slot) =>
      slot.employeeId === employeeId ? { ...slot, employeeId: null } : slot,
    );
  }
  return roleSlots.map((slot) =>
    slot.id === roleId
      ? { ...slot, employeeId }
      : slot.employeeId === employeeId
        ? { ...slot, employeeId: null }
        : slot,
  );
}
