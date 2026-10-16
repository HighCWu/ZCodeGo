import { describe, expect, it } from "vitest";
import {
  buildOpcCompanyImportMutations,
  buildOpcCompanyPackage,
  parseOpcCompanyPackage,
} from "../src/opc/opc-company-package.js";
import {
  createEmptyOpcCompanyState,
  applyOpcMutation,
} from "../src/opc/opc-reducer.js";
import {
  extractOpcDoneMarkers,
  buildOpcDelegationPrompt,
  buildOpcDoneMarker,
  extractOpcDoneMarkerIds,
} from "../src/opc/opc-prompts.js";

const NOW = 1_700_000_000_000;

describe("完成标记（opc-done）", () => {
  it("构建与提取往返一致；多标记全收集；轮次后缀兼容", () => {
    const marker = buildOpcDoneMarker("wi_abc");
    expect(marker).toBe("<!-- zcode-go:opc-done wi_abc:r0 -->");
    const text = `第一行\n${marker}\n中间 ${buildOpcDoneMarker("wi_def")}\n尾部`;
    expect(extractOpcDoneMarkerIds(text)).toEqual(["wi_abc", "wi_def"]);
    // 旧格式（无轮次）兼容提取；轮次随返工递增
    expect(extractOpcDoneMarkers("<!-- zcode-go:opc-done wi_old -->")).toEqual([
      { id: "wi_old", round: 0 },
    ]);
    expect(extractOpcDoneMarkers(buildOpcDoneMarker("wi_x", 2))).toEqual([
      { id: "wi_x", round: 2 },
    ]);
  });

  it("普通文本与残缺标记不误报", () => {
    expect(extractOpcDoneMarkerIds("完成情况核对清单\n全部通过")).toEqual([]);
    expect(extractOpcDoneMarkerIds("<!-- zcode-go:opc-done -->")).toEqual([]);
  });

  it("委派 prompt 注入完成标记约定（含本工作项 id）", () => {
    const prompt = buildOpcDelegationPrompt({
      companyName: "演示公司",
      employee: {
        id: "emp_a",
        name: "测试员工",
        templateId: "tpl",
        roleId: null,
        category: "engineering",
        emoji: "🧪",
        color: "blue",
        vibe: "",
        description: "",
        seniority: "senior",
        status: "active",
        skillRefs: [],
        stats: { completed: 0, retrospectives: 0, lessons: 0 },
        createdAt: NOW,
      },
      roleBody: null,
      workItem: {
        id: "wi_marker",
        title: "任务",
        detail: "",
        status: "ready",
        assigneeId: "emp_a",
        priority: "medium",
        dependsOn: [],
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      },
      skillBodies: [],
      skillNamesRemaining: [],
      recentLessons: [],
      memoryFilePath: ".opc/memory/emp_a.md",
    });
    expect(prompt).toContain(buildOpcDoneMarker("wi_marker"));
    expect(prompt).toContain("完成判定");
  });
});

describe("公司包（导出/导入）", () => {
  function makeSourceState() {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      { kind: "role-slot.create", title: "研发负责人" },
      NOW + 1,
    ).state;
    const roleId = state.roleSlots[0]!.id;
    state = applyOpcMutation(
      state,
      {
        kind: "employee.hire",
        templateId: "全栈开发工程师",
        roleId,
        custom: {
          name: "老王",
          category: "engineering",
          emoji: "🧑‍💻",
          color: "blue",
          vibe: "稳",
          description: "",
          seniority: "lead",
        },
      },
      NOW + 2,
    ).state;
    state = applyOpcMutation(
      state,
      {
        kind: "skill.import",
        skillId: "demo",
        name: "演示技能",
        description: "d",
        body: "# 正文",
      },
      NOW + 3,
    ).state;
    return state;
  }

  it("导出→解析往返保真（含正文映射）", () => {
    const state = makeSourceState();
    const pkg = buildOpcCompanyPackage({
      state,
      skillBodies: { demo: "# 正文" },
      roleTemplateBodies: {},
    });
    const parsed = parseOpcCompanyPackage(
      JSON.stringify(JSON.parse(JSON.stringify(pkg))),
    );
    expect(parsed?.state.employees.map((employee) => employee.name)).toContain(
      "老王",
    );
    expect(parsed?.skillBodies.demo).toBe("# 正文");
  });

  it("merge-fill 导入：只创建缺失项（创始人/默认名公司不覆盖）", () => {
    const sourceState = makeSourceState();
    const pkg = buildOpcCompanyPackage({
      state: sourceState,
      skillBodies: { demo: "# 正文" },
      roleTemplateBodies: {},
    });
    let target = createEmptyOpcCompanyState(NOW);
    const outcome = buildOpcCompanyImportMutations(target, pkg, NOW + 10);
    expect(outcome.summary.hires).toBe(1);
    expect(outcome.summary.skills).toBe(1);
    expect(outcome.summary.slots).toBe(1);
    for (const mutation of outcome.mutations) {
      target = applyOpcMutation(target, mutation, NOW + 11).state;
    }
    expect(target.employees.map((employee) => employee.name)).toContain("老王");
    expect(target.skills.map((skill) => skill.id)).toContain("demo");
    // 再导入一次 → 全部跳过（幂等）
    const again = buildOpcCompanyImportMutations(target, pkg, NOW + 12);
    expect(again.summary.hires).toBe(0);
    expect(again.summary.skills).toBe(0);
  });

  it("非法文档返回 null", () => {
    expect(parseOpcCompanyPackage("not json")).toBeNull();
    expect(
      parseOpcCompanyPackage(JSON.stringify({ kind: "other" })),
    ).toBeNull();
  });
});
