import { describe, expect, it } from "vitest";
import {
  buildOpcDelegationPrompt,
  buildOpcRetroPrompt,
  buildOpcSkillUpgradePrompt,
} from "../src/opc/opc-prompts.js";
import { createEmptyOpcCompanyState } from "../src/opc/opc-reducer.js";
import type { OpcWorkItem } from "../src/opc/opc-types.js";

const NOW = 1_700_000_000_000;

const workItem: OpcWorkItem = {
  id: "wi_1",
  title: "重构发布脚本",
  detail: "验收：冒烟通过 + 回滚方案成文",
  status: "ready",
  assigneeId: "emp_a",
  priority: "high",
  dependsOn: ["wi_0"],
  createdAt: NOW,
  updatedAt: NOW,
  completedAt: null,
};

const employee = {
  id: "emp_a",
  name: "测试员工",
  templateId: "tpl",
  roleId: null,
  category: "engineering",
  emoji: "🧪",
  color: "blue",
  vibe: "稳",
  description: "",
  seniority: "senior" as const,
  status: "active" as const,
  skillRefs: ["tdd"],
  stats: { completed: 0, retrospectives: 0, lessons: 0 },
  createdAt: NOW,
};

describe("buildOpcDelegationPrompt", () => {
  it("注入角色正文、技能正文、经验与验收标准", () => {
    const prompt = buildOpcDelegationPrompt({
      companyName: "演示公司",
      employee,
      roleBody: "# 角色说明书\n先测试后实现",
      workItem,
      skillBodies: [{ id: "tdd", name: "TDD", body: "红绿重构" }],
      skillNamesRemaining: ["code-review"],
      recentLessons: ["部署前先跑冒烟"],
      memoryFilePath: ".opc/memory/emp_a.md",
    });
    expect(prompt).toContain("演示公司");
    expect(prompt).toContain("测试员工");
    expect(prompt).toContain("角色说明书");
    expect(prompt).toContain("红绿重构");
    expect(prompt).toContain("部署前先跑冒烟");
    expect(prompt).toContain("重构发布脚本");
    expect(prompt).toContain("冒烟通过 + 回滚方案成文");
    expect(prompt).toContain(".opc/memory/emp_a.md");
    expect(prompt).toContain("wi_0");
  });

  it("自定义员工（无角色正文）也能委派", () => {
    const prompt = buildOpcDelegationPrompt({
      companyName: "演示公司",
      employee: { ...employee, templateId: "custom" },
      roleBody: null,
      workItem,
      skillBodies: [],
      skillNamesRemaining: [],
      recentLessons: [],
      memoryFilePath: ".opc/memory/emp_a.md",
    });
    expect(prompt).toContain("重构发布脚本");
  });
});

describe("复盘 / 升级 prompt", () => {
  it("复盘 prompt 要求 opc-lessons 围栏 JSON", () => {
    const prompt = buildOpcRetroPrompt({
      employeeName: "小李",
      workItemTitle: "发布脚本",
    });
    expect(prompt).toContain("opc-lessons");
    expect(prompt).toContain("小李");
    expect(prompt).toContain("发布脚本");
  });

  it("升级 prompt 用四反引号围栏并注入当前正文", () => {
    const prompt = buildOpcSkillUpgradePrompt({
      skillName: "TDD",
      currentBody: "# 当前正文",
      goal: "补充边界",
    });
    expect(prompt).toContain("````opc-skill");
    expect(prompt).toContain("# 当前正文");
    expect(prompt).toContain("补充边界");
  });

  it("createEmptyOpcCompanyState 与 prompt 无耦合（冒烟）", () => {
    const state = createEmptyOpcCompanyState(NOW);
    expect(state.company.name.length).toBeGreaterThan(0);
  });
});
