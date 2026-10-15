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
