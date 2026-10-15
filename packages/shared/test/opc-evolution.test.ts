import { describe, expect, it } from "vitest";
import {
  createOpcEntityId,
  evaluateOpcPromotions,
  normalizeOpcStatementKey,
  promotionSkillId,
  renderOpcEmployeeMemory,
  renderOpcSkillFile,
} from "../src/opc/opc-evolution.js";
import { createEmptyOpcCompanyState } from "../src/opc/opc-reducer.js";
import { applyOpcMutation } from "../src/opc/opc-reducer.js";

const NOW = 1_700_000_000_000;

function makeState() {
  const base = createEmptyOpcCompanyState(NOW);
  // 招一名工程师供复盘用
  const hired = applyOpcMutation(
    base,
    {
      kind: "employee.hire",
      templateId: "custom",
      roleId: null,
      custom: {
        name: "测试工程师小李",
        category: "engineering",
        emoji: "🧪",
        color: "amber",
        vibe: "先复现",
        description: "负责质量",
        seniority: "senior",
      },
    },
    NOW + 1,
  );
  return hired.state;
}

describe("normalizeOpcStatementKey", () => {
  it("大小写、标点与空白不影响指纹", () => {
    expect(normalizeOpcStatementKey("先止血，再归因！", ["Incident"])).toBe(
      normalizeOpcStatementKey("先止血 再归因", ["incident"]),
    );
  });

  it("不同 tag 集合视为不同指纹", () => {
    expect(normalizeOpcStatementKey("同一句话", ["a"])).not.toBe(
      normalizeOpcStatementKey("同一句话", ["b"]),
    );
  });
});

describe("RSI 闭环：复盘 → 晋升 → 版本递增", () => {
  it("一次复盘不晋升", () => {
    const state = makeState();
    const employee = state.employees.find(
      (item) => item.templateId === "custom",
    )!;
    const afterRetro = applyOpcMutation(
      state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        lessons: [{ statement: "先止血再归因", tags: ["incident"] }],
      },
      NOW + 2,
    );
    expect(afterRetro.state.lessons).toHaveLength(1);
    expect(afterRetro.promotedSkillIds).toHaveLength(0);
  });

  it("两次独立复盘出现同指纹经验 → 自动晋升为 playbook 并挂接员工", () => {
    const state = makeState();
    const employee = state.employees.find(
      (item) => item.templateId === "custom",
    )!;
    const retro1 = applyOpcMutation(
      state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        lessons: [{ statement: "先止血再归因", tags: ["incident"] }],
      },
      NOW + 2,
    );
    const retro2 = applyOpcMutation(
      retro1.state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        lessons: [{ statement: "先止血。再归因。", tags: ["incident"] }],
      },
      NOW + 3,
    );
    expect(retro2.promotedSkillIds).toHaveLength(1);
    const skillId = promotionSkillId(
      normalizeOpcStatementKey("先止血再归因", ["incident"]),
    );
    const skill = retro2.state.skills.find((item) => item.id === skillId);
    expect(skill?.origin).toBe("promoted");
    expect(skill?.version).toBe(1);
    const hired = retro2.state.employees.find(
      (item) => item.id === employee.id,
    );
    expect(hired?.skillRefs).toContain(skillId);
    // 进化事件留痕
    expect(retro2.events.some((event) => event.kind === "promote")).toBe(true);
  });

  it("同一批复盘内的重复经验只算一次，不触发晋升", () => {
    const state = makeState();
    const employee = state.employees.find(
      (item) => item.templateId === "custom",
    )!;
    const afterRetro = applyOpcMutation(
      state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        lessons: [
          { statement: "重复经验", tags: [] },
          { statement: "重复经验", tags: [] },
        ],
      },
      NOW + 2,
    );
    expect(afterRetro.promotedSkillIds).toHaveLength(0);
  });

  it("第三次再确认 → 技能版本 +1 并追加 changelog", () => {
    const state = makeState();
    const employee = state.employees.find(
      (item) => item.templateId === "custom",
    )!;
    const r1 = applyOpcMutation(
      state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        lessons: [{ statement: "部署前先跑冒烟", tags: ["deploy"] }],
      },
      NOW + 2,
    );
    const r2 = applyOpcMutation(
      r1.state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        lessons: [{ statement: "部署前先跑冒烟", tags: ["deploy"] }],
      },
      NOW + 3,
    );
    const r3 = applyOpcMutation(
      r2.state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        lessons: [{ statement: "部署前先跑冒烟", tags: ["deploy"] }],
      },
      NOW + 4,
    );
    const skillId = promotionSkillId(
      normalizeOpcStatementKey("部署前先跑冒烟", ["deploy"]),
    );
    const skill = r3.state.skills.find((item) => item.id === skillId);
    expect(skill?.version).toBe(2);
    expect(skill?.changelog.some((line) => line.startsWith("v2"))).toBe(true);
  });

  it("不同员工各自复盘同指纹也计数（共享 playbook 语义）", () => {
    const state = makeState();
    const employeeA = state.employees.find(
      (item) => item.templateId === "custom",
    )!;
    const founder = state.employees.find((item) => item.isFallback)!;
    const r1 = applyOpcMutation(
      state,
      {
        kind: "retro.record",
        employeeId: employeeA.id,
        lessons: [{ statement: "口径先行", tags: ["data"] }],
      },
      NOW + 2,
    );
    const r2 = applyOpcMutation(
      r1.state,
      {
        kind: "retro.record",
        employeeId: founder.id,
        lessons: [{ statement: "口径先行", tags: ["data"] }],
      },
      NOW + 3,
    );
    expect(r2.promotedSkillIds).toHaveLength(1);
  });
});

describe("复盘副作用", () => {
  it("统计与工作项完成计数", () => {
    const state = makeState();
    const employee = state.employees.find(
      (item) => item.templateId === "custom",
    )!;
    const withItem = applyOpcMutation(
      state,
      {
        kind: "workitem.create",
        title: "修复发布脚本",
        assigneeId: employee.id,
      },
      NOW + 2,
    );
    const workItem = withItem.state.workItems[0]!;
    const afterRetro = applyOpcMutation(
      withItem.state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        workItemId: workItem.id,
        lessons: [{ statement: "脚本先在临时目录试跑", tags: ["ci"] }],
      },
      NOW + 3,
    );
    const hired = afterRetro.state.employees.find(
      (item) => item.id === employee.id,
    )!;
    expect(hired.stats.retrospectives).toBe(1);
    expect(hired.stats.lessons).toBe(1);
    expect(hired.stats.completed).toBe(1);
  });
});

describe("文件渲染", () => {
  it("员工记忆档案包含经验与新→旧排序", () => {
    const state = makeState();
    const employee = state.employees.find(
      (item) => item.name === "测试工程师小李",
    )!;
    // 两次复盘不同时间戳，验证「新→旧」排序（同毫秒并列时保持插入序，不构成断言）。
    const withFirst = applyOpcMutation(
      state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        lessons: [{ statement: "经验一", tags: [] }],
      },
      NOW + 2,
    );
    const withLessons = applyOpcMutation(
      withFirst.state,
      {
        kind: "retro.record",
        employeeId: employee.id,
        lessons: [{ statement: "经验二", tags: ["t"] }],
      },
      NOW + 3,
    );
    const lessons = withLessons.state.lessons.filter(
      (lesson) => lesson.employeeId === employee.id,
    );
    const memory = renderOpcEmployeeMemory(employee, lessons, NOW + 3);
    expect(memory).toContain("# 测试工程师小李 的私人经验档案");
    expect(memory.indexOf("经验二")).toBeLessThan(memory.indexOf("经验一"));
  });

  it("晋升技能文件带 frontmatter 与版本记录", () => {
    const file = renderOpcSkillFile({
      id: "playbook-demo",
      name: "Playbook：演示",
      description: "测试",
      category: "general",
      version: 2,
      changelog: ["v1：晋升", "v2：再确认"],
      body: "# 正文",
    });
    expect(file.startsWith("---\nname: Playbook：演示")).toBe(true);
    expect(file).toContain("version: 2");
    expect(file).toContain("- v2：再确认");
  });
});

describe("evaluateOpcPromotions 幂等性", () => {
  it("无新晋升时返回原 state（引用相等）", () => {
    const state = makeState();
    const outcome = evaluateOpcPromotions(state, NOW);
    expect(outcome.state).toBe(state);
    expect(outcome.promotedSkillIds).toHaveLength(0);
  });
});

describe("createOpcEntityId", () => {
  it("同毫秒多次调用不碰撞", () => {
    const a = createOpcEntityId("lesson", NOW);
    const b = createOpcEntityId("lesson", NOW);
    expect(a).not.toBe(b);
  });
});
