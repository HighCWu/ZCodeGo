import { describe, expect, it } from "vitest";
import {
  applyOpcMutation,
  createEmptyOpcCompanyState,
} from "../src/opc/opc-reducer.js";
import { isOpcWorkItemTransition } from "../src/opc/opc-types.js";
import {
  OPC_BUILTIN_ROLE_DRAFTS,
  OPC_BUILTIN_SKILL_DRAFTS,
} from "../src/opc/index.js";

const NOW = 1_700_000_000_000;

describe("createEmptyOpcCompanyState", () => {
  it("初始化创始人（所有者兜底，OpenOPC final decider 语义）", () => {
    const state = createEmptyOpcCompanyState(NOW);
    expect(state.employees).toHaveLength(1);
    expect(state.employees[0]?.isFallback).toBe(true);
    expect(state.evolution[0]?.kind).toBe("company-init");
  });
});

describe("工作项状态机", () => {
  it("合法链路 backlog→ready→in_progress→review→done", () => {
    let state = createEmptyOpcCompanyState(NOW);
    const created = applyOpcMutation(
      state,
      { kind: "workitem.create", title: "任务A" },
      NOW + 1,
    );
    state = created.state;
    const id = state.workItems[0]!.id;
    for (const next of ["ready", "in_progress", "review", "done"] as const) {
      const step = applyOpcMutation(
        state,
        { kind: "workitem.status", workItemId: id, status: next },
        NOW + 2,
      );
      expect(step.state).not.toBe(state);
      state = step.state;
    }
    expect(state.workItems[0]?.status).toBe("done");
    expect(state.workItems[0]?.completedAt).not.toBeNull();
  });

  it("非法跳转被拒绝（done 终态、backlog 不可直达 done）", () => {
    expect(isOpcWorkItemTransition("backlog", "done")).toBe(false);
    expect(isOpcWorkItemTransition("done", "backlog")).toBe(false);
    let state = createEmptyOpcCompanyState(NOW);
    const created = applyOpcMutation(
      state,
      { kind: "workitem.create", title: "任务B" },
      NOW + 1,
    );
    state = created.state;
    const id = state.workItems[0]!.id;
    const illegal = applyOpcMutation(
      state,
      { kind: "workitem.status", workItemId: id, status: "done" },
      NOW + 2,
    );
    expect(illegal.state).toBe(state);
  });

  it("cancelled 可回 backlog（误关恢复）", () => {
    expect(isOpcWorkItemTransition("cancelled", "backlog")).toBe(true);
  });
});

describe("招聘与组织", () => {
  it("建岗位 → 招聘绑定槽位 → 离职释放", () => {
    let state = createEmptyOpcCompanyState(NOW);
    const slot = applyOpcMutation(
      state,
      { kind: "role-slot.create", title: "研发负责人" },
      NOW + 1,
    );
    state = slot.state;
    const roleId = state.roleSlots[0]!.id;
    const hire = applyOpcMutation(
      state,
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId,
        custom: {
          name: "老王",
          category: "engineering",
          emoji: "👨‍💻",
          color: "blue",
          vibe: "稳",
          description: "",
          seniority: "lead",
        },
      },
      NOW + 2,
    );
    state = hire.state;
    const employee = state.employees.find((item) => item.name === "老王")!;
    expect(state.roleSlots[0]?.employeeId).toBe(employee.id);
    expect(hire.events.some((event) => event.kind === "hire")).toBe(true);

    const depart = applyOpcMutation(
      state,
      { kind: "employee.depart", employeeId: employee.id },
      NOW + 3,
    );
    const departed = depart.state.employees.find(
      (item) => item.id === employee.id,
    )!;
    expect(departed.status).toBe("departed");
    expect(depart.state.roleSlots[0]?.employeeId).toBeNull();
  });

  it("离职员工未完成工作项自动释放负责人", () => {
    let state = createEmptyOpcCompanyState(NOW);
    const hire = applyOpcMutation(
      state,
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: null,
        custom: {
          name: "小张",
          category: "sales",
          emoji: "🧑‍💼",
          color: "red",
          vibe: "",
          description: "",
          seniority: "junior",
        },
      },
      NOW + 1,
    );
    state = hire.state;
    const employee = state.employees.find((item) => item.name === "小张")!;
    const item = applyOpcMutation(
      state,
      {
        kind: "workitem.create",
        title: "跟进客户",
        assigneeId: employee.id,
      },
      NOW + 2,
    );
    state = item.state;
    const departed = applyOpcMutation(
      state,
      { kind: "employee.depart", employeeId: employee.id },
      NOW + 3,
    );
    expect(departed.state.workItems[0]?.assigneeId).toBeNull();
  });

  it("换岗位时槽位占用同步", () => {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      { kind: "role-slot.create", title: "岗位一" },
      NOW + 1,
    ).state;
    state = applyOpcMutation(
      state,
      { kind: "role-slot.create", title: "岗位二" },
      NOW + 2,
    ).state;
    state = applyOpcMutation(
      state,
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: state.roleSlots[0]!.id,
        custom: {
          name: "小陈",
          category: "general",
          emoji: "🙂",
          color: "slate",
          vibe: "",
          description: "",
          seniority: "junior",
        },
      },
      NOW + 3,
    ).state;
    const employee = state.employees.find((item) => item.name === "小陈")!;
    const moved = applyOpcMutation(
      state,
      {
        kind: "employee.update",
        employeeId: employee.id,
        patch: { roleId: state.roleSlots[1]!.id },
      },
      NOW + 4,
    );
    expect(moved.state.roleSlots[0]?.employeeId).toBeNull();
    expect(moved.state.roleSlots[1]?.employeeId).toBe(employee.id);
  });
});

describe("员工级模型偏好与画像重置", () => {
  it("employee.update 可写入/清除 modelSelection（编排器派发依据）", () => {
    let state = applyOpcMutation(
      createEmptyOpcCompanyState(NOW),
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: null,
        custom: { name: "小陈", category: "engineering" },
      },
      NOW,
    ).state;
    const employee = state.employees.find((item) => item.name === "小陈")!;
    const withModel = applyOpcMutation(
      state,
      {
        kind: "employee.update",
        employeeId: employee.id,
        patch: {
          modelSelection: { providerId: "zcode-go-fake", modelId: "fake-model" },
        },
      },
      NOW + 1,
    ).state;
    expect(
      withModel.employees.find((item) => item.id === employee.id)?.modelSelection,
    ).toEqual({ providerId: "zcode-go-fake", modelId: "fake-model" });
    // null 哨兵清除（IPC 结构化克隆会丢 undefined 键，显式清除走 null）
    const cleared = applyOpcMutation(
      withModel,
      {
        kind: "employee.update",
        employeeId: employee.id,
        patch: { modelSelection: null },
      },
      NOW + 2,
    ).state;
    expect(
      cleared.employees.find((item) => item.id === employee.id)?.modelSelection,
    ).toBeUndefined();
  });

  it("employee.resetPersona 落 persona-reset 进化事件且不改员工状态", () => {
    let state = applyOpcMutation(
      createEmptyOpcCompanyState(NOW),
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: null,
        custom: { name: "小陈", category: "engineering" },
      },
      NOW,
    ).state;
    const employee = state.employees.find((item) => item.name === "小陈")!;
    const applied = applyOpcMutation(
      state,
      { kind: "employee.resetPersona", employeeId: employee.id },
      NOW + 1,
    );
    // wrapper 会把事件追加进进化日志（新 state 对象）；员工本体必须原样保留
    expect(
      applied.state.employees.find((item) => item.id === employee.id),
    ).toEqual(state.employees.find((item) => item.id === employee.id));
    expect(applied.events).toHaveLength(1);
    expect(applied.events[0]?.kind).toBe("persona-reset");
    expect(applied.events[0]?.summary).toContain("小陈");
  });

  it("employee.resetPersona 在员工 busy（在跑任务）时静默拒绝（主档冻结）", () => {
    let state = applyOpcMutation(
      createEmptyOpcCompanyState(NOW),
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: null,
        custom: { name: "小陈", category: "engineering" },
      },
      NOW,
    ).state;
    const employee = state.employees.find((item) => item.name === "小陈")!;
    state = applyOpcMutation(
      state,
      {
        kind: "workitem.create",
        title: "进行中的委派",
        detail: "d",
        assigneeId: employee.id,
        priority: "medium",
        dependsOn: [],
      },
      NOW + 1,
    ).state;
    const item = state.workItems.find((w) => w.assigneeId === employee.id)!;
    // 转换表：backlog → ready → in_progress；sessionId 由 workitem.update 落账
    state = applyOpcMutation(
      state,
      { kind: "workitem.status", workItemId: item.id, status: "ready" },
      NOW + 2,
    ).state;
    state = applyOpcMutation(
      state,
      { kind: "workitem.status", workItemId: item.id, status: "in_progress" },
      NOW + 3,
    ).state;
    state = applyOpcMutation(
      state,
      {
        kind: "workitem.update",
        workItemId: item.id,
        patch: { sessionId: "sess_x" },
      },
      NOW + 4,
    ).state;
    const applied = applyOpcMutation(
      state,
      { kind: "employee.resetPersona", employeeId: employee.id },
      NOW + 5,
    );
    // 主档冻结：无进化事件（Apply handler 据此跳过 persona.md 的 fs 删除）
    expect(applied.events).toHaveLength(0);
    // 员工在跑的任务本身不受影响
    expect(
      applied.state.workItems.find((w) => w.id === item.id)?.status,
    ).toBe("in_progress");
  });
});

describe("技能导入与升级", () => {
  it("首次导入创建 v1，重复导入走版本覆盖", () => {
    let state = createEmptyOpcCompanyState(NOW);
    const first = applyOpcMutation(
      state,
      {
        kind: "skill.import",
        skillId: "demo-skill",
        name: "演示技能",
        description: "desc",
        body: "正文",
      },
      NOW + 1,
    );
    state = first.state;
    expect(state.skills[0]?.version).toBe(1);
    const second = applyOpcMutation(
      state,
      {
        kind: "skill.import",
        skillId: "demo-skill",
        name: "演示技能",
        description: "desc2",
        body: "新正文",
      },
      NOW + 2,
    );
    expect(second.state.skills).toHaveLength(1);
    expect(second.state.skills[0]?.version).toBe(2);
  });

  it("技能升级版本 +1 并留进化事件；移除时清理员工挂接", () => {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      {
        kind: "skill.import",
        skillId: "up-skill",
        name: "待升级",
        description: "d",
        body: "b",
      },
      NOW + 1,
    ).state;
    const upgraded = applyOpcMutation(
      state,
      {
        kind: "skill.upgrade",
        skillId: "up-skill",
        body: "新正文",
        note: "补充边界",
      },
      NOW + 2,
    );
    expect(upgraded.state.skills[0]?.version).toBe(2);
    expect(
      upgraded.events.some((event) => event.kind === "skill-upgrade"),
    ).toBe(true);
    state = upgraded.state;
    const hire = applyOpcMutation(
      state,
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: null,
        skillRefs: ["up-skill"],
        custom: {
          name: "小赵",
          category: "general",
          emoji: "🙂",
          color: "slate",
          vibe: "",
          description: "",
          seniority: "junior",
        },
      },
      NOW + 3,
    );
    state = hire.state;
    const removed = applyOpcMutation(
      state,
      { kind: "skill.remove", skillId: "up-skill" },
      NOW + 4,
    );
    expect(removed.state.skills).toHaveLength(0);
    expect(
      removed.state.employees.find((item) => item.name === "小赵")?.skillRefs,
    ).toHaveLength(0);
  });
});

describe("角色模板导入", () => {
  it("OpenOPC talent 格式 markdown 入库（重复 id 覆盖不重复入库）", () => {
    let state = createEmptyOpcCompanyState(NOW);
    const markdown = [
      "---",
      "name: Growth Marketer",
      "description: 增长营销",
      "color: pink",
      "emoji: 📣",
      "vibe: Data first",
      "---",
      "",
      "正文",
    ].join("\n");
    const first = applyOpcMutation(
      state,
      { kind: "template.importRole", markdown },
      NOW + 1,
    );
    expect(first.state.roleTemplates).toHaveLength(1);
    expect(first.state.roleTemplates[0]?.category).toBe("marketing");
    const second = applyOpcMutation(
      first.state,
      { kind: "template.importRole", markdown },
      NOW + 2,
    );
    expect(second.state.roleTemplates).toHaveLength(1);
  });
});

describe("内置模板包", () => {
  it("24 个角色模板全部可解析且五字段齐全", () => {
    expect(OPC_BUILTIN_ROLE_DRAFTS).toHaveLength(24);
    for (const draft of OPC_BUILTIN_ROLE_DRAFTS) {
      expect(draft.name.length).toBeGreaterThan(0);
      expect(draft.description.length).toBeGreaterThan(0);
      expect(draft.emoji.length).toBeGreaterThan(0);
      expect(draft.vibe.length).toBeGreaterThan(0);
      expect(draft.body.length).toBeGreaterThan(100);
    }
  });

  it("16 个内置技能全部可解析（SKILL.md frontmatter）", () => {
    expect(OPC_BUILTIN_SKILL_DRAFTS).toHaveLength(16);
    const ids = new Set(OPC_BUILTIN_SKILL_DRAFTS.map((draft) => draft.id));
    expect(ids.size).toBe(16);
  });
});

import { isOpcWorkItemRunnable } from "../src/opc/opc-types.js";

describe("依赖就绪门控与传播（Self-Run）", () => {
  function makeDeps() {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      { kind: "workitem.create", title: "上游" },
      NOW + 1,
    ).state;
    state = applyOpcMutation(
      state,
      {
        kind: "workitem.create",
        title: "下游",
        dependsOn: [state.workItems[0]!.id],
      },
      NOW + 2,
    ).state;
    return state;
  }

  it("runnability：前置 done/cancelled 才就绪；悬空 id 视为已解决", () => {
    const state = makeDeps();
    const [up, down] = state.workItems;
    expect(isOpcWorkItemRunnable(down!, state.workItems)).toBe(false);
    // 上游走完整链（backlog→ready→in_progress→review→done）
    let walking = state;
    for (const next of ["ready", "in_progress", "review", "done"] as const) {
      walking = applyOpcMutation(
        walking,
        { kind: "workitem.status", workItemId: up!.id, status: next },
        NOW + 3,
      ).state;
    }
    const done = { state: walking };
    // 传播：下游 backlog → ready
    expect(done.state.workItems[1]?.status).toBe("ready");
    expect(
      isOpcWorkItemRunnable(done.state.workItems[1]!, done.state.workItems),
    ).toBe(true);
    const withDangling = {
      ...done.state,
      workItems: [
        {
          ...done.state.workItems[1]!,
          status: "backlog" as const,
          dependsOn: ["wi_deleted"],
        },
      ],
    };
    expect(
      isOpcWorkItemRunnable(withDangling.workItems[0]!, withDangling.workItems),
    ).toBe(true);
  });

  it("ready→in_progress 在前置未解决时被拒绝", () => {
    const state = makeDeps();
    const down = state.workItems[1]!;
    const ready = applyOpcMutation(
      state,
      { kind: "workitem.status", workItemId: down.id, status: "ready" },
      NOW + 3,
    );
    const blocked = applyOpcMutation(
      ready.state,
      { kind: "workitem.status", workItemId: down.id, status: "in_progress" },
      NOW + 4,
    );
    expect(blocked.state).toBe(ready.state);
  });

  it("部分依赖完成不触发传播（还有其他未解决前置）", () => {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      { kind: "workitem.create", title: "前置A" },
      NOW + 1,
    ).state;
    const a = state.workItems[0]!.id;
    state = applyOpcMutation(
      state,
      { kind: "workitem.create", title: "前置B" },
      NOW + 2,
    ).state;
    const b = state.workItems[1]!.id;
    state = applyOpcMutation(
      state,
      { kind: "workitem.create", title: "汇总", dependsOn: [a, b] },
      NOW + 3,
    ).state;
    const half = applyOpcMutation(
      state,
      { kind: "workitem.status", workItemId: a, status: "done" },
      NOW + 4,
    );
    expect(half.state.workItems[2]?.status).toBe("backlog");
  });
});

describe("升级上报与接手（escalation）", () => {
  it("升级留痕 + 进化事件；takeover 转派创始人", () => {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      { kind: "workitem.create", title: "卡住的任务" },
      NOW + 1,
    ).state;
    const id = state.workItems[0]!.id;
    const escalated = applyOpcMutation(
      state,
      { kind: "workitem.escalate", workItemId: id, note: "超预算" },
      NOW + 2,
    );
    expect(escalated.state.workItems[0]?.escalatedAt).toBe(NOW + 2);
    expect(escalated.state.workItems[0]?.escalationNote).toBe("超预算");
    expect(
      escalated.events.some((event) => event.summary.includes("升级给所有者")),
    ).toBe(true);
    const takeover = applyOpcMutation(
      escalated.state,
      {
        kind: "workitem.resolveEscalation",
        workItemId: id,
        action: "takeover",
      },
      NOW + 3,
    );
    expect(takeover.state.workItems[0]?.escalatedAt).toBeNull();
    expect(takeover.state.workItems[0]?.assigneeId).toBe(
      takeover.state.employees.find((item) => item.isFallback)?.id,
    );
    // resume 仅解除不转派
    state = applyOpcMutation(
      takeover.state,
      { kind: "workitem.escalate", workItemId: id },
      NOW + 4,
    ).state;
    const resumed = applyOpcMutation(
      state,
      { kind: "workitem.resolveEscalation", workItemId: id, action: "resume" },
      NOW + 5,
    );
    expect(resumed.state.workItems[0]?.assigneeId).toBe(
      takeover.state.workItems[0]?.assigneeId,
    );
    // done/cancelled 不可升级
    state = applyOpcMutation(
      resumed.state,
      { kind: "workitem.status", workItemId: id, status: "ready" },
      NOW + 6,
    ).state;
    state = applyOpcMutation(
      state,
      { kind: "workitem.status", workItemId: id, status: "in_progress" },
      NOW + 7,
    ).state;
    state = applyOpcMutation(
      state,
      { kind: "workitem.status", workItemId: id, status: "review" },
      NOW + 8,
    ).state;
    state = applyOpcMutation(
      state,
      { kind: "workitem.status", workItemId: id, status: "done" },
      NOW + 9,
    ).state;
    const after = applyOpcMutation(
      state,
      { kind: "workitem.escalate", workItemId: id },
      NOW + 10,
    );
    expect(after.state.workItems[0]?.escalatedAt).toBeNull();
  });
});

describe("返工（rework）", () => {
  it("review 退回 in_progress + 意见追加；非 review 态拒绝", () => {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      { kind: "workitem.create", title: "要返工" },
      NOW + 1,
    ).state;
    const id = state.workItems[0]!.id;
    for (const next of ["ready", "in_progress", "review"] as const) {
      state = applyOpcMutation(
        state,
        { kind: "workitem.status", workItemId: id, status: next },
        NOW + 2,
      ).state;
    }
    const reworked = applyOpcMutation(
      state,
      { kind: "workitem.rework", workItemId: id, note: "边界没覆盖" },
      NOW + 3,
    );
    expect(reworked.state.workItems[0]?.status).toBe("in_progress");
    expect(reworked.state.workItems[0]?.reworkNotes).toEqual(["边界没覆盖"]);
    const reReview = applyOpcMutation(
      reworked.state,
      { kind: "workitem.status", workItemId: id, status: "review" },
      NOW + 4,
    );
    const again = applyOpcMutation(
      reReview.state,
      { kind: "workitem.rework", workItemId: id, note: "还不行" },
      NOW + 5,
    );
    expect(again.state.workItems[0]?.reworkNotes).toEqual([
      "边界没覆盖",
      "还不行",
    ]);
    // 非 review 态（in_progress）不可返工
    const inProgress = applyOpcMutation(
      again.state,
      { kind: "workitem.status", workItemId: id, status: "in_progress" },
      NOW + 6,
    );
    const rejected = applyOpcMutation(
      inProgress.state,
      { kind: "workitem.rework", workItemId: id, note: "x" },
      NOW + 7,
    );
    expect(rejected.state).toBe(inProgress.state);
  });
});

describe("新员工入职继承共享 playbook（三轮 review 回归）", () => {
  it("hire 时自动挂接全部晋升技能（tombstone 除外）", () => {
    let state = createEmptyOpcCompanyState(NOW);
    const promoted = {
      id: "playbook-incident",
      name: "Playbook：止血",
      description: "shared",
      category: "engineering" as const,
      version: 1,
      origin: "promoted" as const,
      changelog: ["v1"],
      updatedAt: NOW,
    };
    const removed = {
      ...promoted,
      id: "playbook-gone",
      name: "Playbook：已删",
    };
    state = {
      ...state,
      skills: [promoted, removed],
      promotedSkillTombstones: ["playbook-gone"],
    };
    const applied = applyOpcMutation(
      state,
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: null,
        custom: { name: "新人", category: "engineering" },
      },
      NOW + 1,
    );
    const hired = applied.state.employees.at(-1)!;
    expect(hired.skillRefs).toContain("playbook-incident");
    expect(hired.skillRefs).not.toContain("playbook-gone");
  });
});

describe("汇报线层级（五轮 review 补齐）", () => {
  it("role-slot.create 透传 parentRoleId；悬空 parent 落顶层；remove 孤儿提升", () => {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      { kind: "role-slot.create", title: "研发负责人" },
      NOW + 1,
    ).state;
    const parentSlot = state.roleSlots.at(-1)!;
    // 注意：同一标题岗位不重复创建（createOpcEntityId 带全局序号——重放会
    // 产生不同 id，parent 引用会指向幽灵岗位）
    state = applyOpcMutation(
      state,
      {
        kind: "role-slot.create",
        title: "前端工程师",
        parentRoleId: parentSlot.id,
      },
      NOW + 2,
    ).state;
    const childSlot = state.roleSlots.at(-1)!;
    expect(childSlot.parentRoleId).toBe(parentSlot.id);
    // 悬空 parent（未存在岗位 id）→ 顶层
    state = applyOpcMutation(
      state,
      { kind: "role-slot.create", title: "测试岗", parentRoleId: "slot:ghost" },
      NOW + 3,
    ).state;
    expect(state.roleSlots.at(-1)!.parentRoleId).toBeNull();
    // 删除上级岗位 → 子岗位提升为顶层
    const afterRemove = applyOpcMutation(
      state,
      { kind: "role-slot.remove", roleId: parentSlot.id },
      NOW + 4,
    );
    expect(
      afterRemove.state.roleSlots.find((slot) => slot.title === "前端工程师")
        ?.parentRoleId,
    ).toBeNull();
  });
});

describe("进化事件统一合并（五轮 review：升级链路留痕回归）", () => {
  it("escalate 的事件经统一合并进 state.evolution（evolution-log 落盘前提）", () => {
    const state = createEmptyOpcCompanyState(NOW);
    const employee = applyOpcMutation(
      state,
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: null,
        custom: { name: "执行者", category: "engineering" },
      },
      NOW + 1,
    ).state;
    const hired = employee.employees.at(-1)!;
    const item = applyOpcMutation(
      employee,
      {
        kind: "workitem.create",
        title: "E2E 留痕项",
        assigneeId: hired.id,
      },
      NOW + 2,
    ).state;
    const created = item.workItems.at(-1)!;
    const escalated = applyOpcMutation(
      item,
      { kind: "workitem.escalate", workItemId: created.id, note: "卡住了" },
      NOW + 3,
    );
    // 统一合并：escalate 的事件进 state.evolution（persistDerivedFiles 的
    // evolution-log.jsonl 增量前提）——修复前只回响应不落盘
    expect(
      escalated.state.evolution.some((event) =>
        event.summary.includes("升级给所有者"),
      ),
    ).toBe(true);
    expect(escalated.state.evolution.length).toBeGreaterThan(
      escalated.state.evolution.filter(() => false).length,
    );
  });
});
