import { describe, expect, it } from "vitest";
import {
  buildOpcOrgGeneratePrompt,
  buildOpcOrgMutations,
  findOpcEscalationCandidates,
  matchOpcRoleTemplate,
  OPC_ORG_PRESETS,
  parseOpcOrgBlock,
} from "../src/opc/opc-org.js";
import {
  createEmptyOpcCompanyState,
  applyOpcMutation,
} from "../src/opc/opc-reducer.js";

const NOW = 1_700_000_000_000;

describe("parseOpcOrgBlock", () => {
  it("解析标准围栏 JSON（slots/hires/companyName）", () => {
    const text = [
      "前言",
      "```opc-org",
      JSON.stringify({
        companyName: "智能工作坊",
        slots: ["研发负责人", ""],
        hires: [
          {
            name: "老王",
            template: "全栈开发工程师",
            slot: "研发负责人",
            seniority: "lead",
          },
          { template: "无名字" },
        ],
      }),
      "```",
    ].join("\n");
    const draft = parseOpcOrgBlock(text)!;
    expect(draft.companyName).toBe("智能工作坊");
    expect(draft.slots).toEqual(["研发负责人"]);
    expect(draft.hires).toEqual([
      {
        name: "老王",
        template: "全栈开发工程师",
        slot: "研发负责人",
        seniority: "lead",
      },
    ]);
  });

  it("坏 JSON / 无围栏返回 null", () => {
    expect(parseOpcOrgBlock("```opc-org\n{ broken\n```")).toBeNull();
    expect(parseOpcOrgBlock("没有围栏")).toBeNull();
  });
});

describe("matchOpcRoleTemplate", () => {
  it("精确名称/包含匹配内置模板；未知返回 null", () => {
    const state = createEmptyOpcCompanyState(NOW);
    expect(
      matchOpcRoleTemplate("全栈开发工程师", state.roleTemplates)?.id,
    ).toBe("全栈开发工程师");
    expect(
      matchOpcRoleTemplate("需要一个全栈开发工程师帮手", state.roleTemplates)
        ?.id,
    ).toBe("全栈开发工程师");
    expect(
      matchOpcRoleTemplate("量子炼金术师", state.roleTemplates),
    ).toBeNull();
  });
});

describe("buildOpcOrgMutations", () => {
  it("岗位去重、员工去重（批内同名只招一次）、模板未命中走自定义", () => {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      { kind: "role-slot.create", title: "研发负责人" },
      NOW + 1,
    ).state;
    const draft = parseOpcOrgBlock(
      "```opc-org\n" +
        JSON.stringify({
          companyName: "新名字",
          slots: ["研发负责人", "增长负责人"],
          hires: [
            { name: "老王", template: "全栈开发工程师", slot: "研发负责人" },
            { name: "老王" },
            { name: "神秘人", template: "量子炼金术师" },
          ],
        }) +
        "\n```",
    )!;
    const outcome = buildOpcOrgMutations(state, draft, NOW + 2);
    expect(outcome.summary).toEqual({
      slots: 1,
      hires: 2,
      reused: 0,
      skipped: 1,
    });
    expect(outcome.mutations.some((m) => m.kind === "company.rename")).toBe(
      true,
    );
    const hires = outcome.mutations.filter(
      (m) => m.kind === "employee.hire",
    ) as Array<Extract<OpcMutation, { kind: "employee.hire" }>>;
    expect(hires.find((m) => m.custom?.name === "老王")?.templateId).toBe(
      "全栈开发工程师",
    );
    expect(hires.find((m) => m.custom?.name === "神秘人")?.templateId).toBe(
      "custom",
    );
    // 应用后岗位绑定正确
    for (const mutation of outcome.mutations) {
      state = applyOpcMutation(state, mutation, NOW + 3).state;
    }
    const laowang = state.employees.find(
      (employee) => employee.name === "老王",
    );
    const slot = state.roleSlots.find((slot) => slot.title === "研发负责人");
    expect(slot?.employeeId).toBe(laowang?.id);
  });

  it("同模板的暂停/离职员工被复用（恢复 + 换岗）而非重复招聘", () => {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: null,
        custom: {
          name: "退役老王",
          category: "engineering",
          emoji: "🧑‍💻",
          color: "blue",
          vibe: "",
          description: "",
          seniority: "senior",
        },
      },
      NOW + 1,
    ).state;
    const old = state.employees.find(
      (employee) => employee.name === "退役老王",
    )!;
    // 让其 templateId 与生成条目一致（直接部署复用路径：templateId 相等）
    state = {
      ...state,
      employees: state.employees.map((employee) =>
        employee.id === old.id
          ? {
              ...employee,
              templateId: "全栈开发工程师",
              status: "paused" as const,
            }
          : employee,
      ),
    };
    const draft = parseOpcOrgBlock(
      "```opc-org\n" +
        JSON.stringify({
          slots: [],
          hires: [{ name: "老王回归", template: "全栈开发工程师" }],
        }) +
        "\n```",
    )!;
    const outcome = buildOpcOrgMutations(state, draft, NOW + 2);
    expect(outcome.summary.reused).toBe(1);
    expect(outcome.summary.hires).toBe(0);
    const update = outcome.mutations.find(
      (m) => m.kind === "employee.update",
    ) as Extract<OpcMutation, { kind: "employee.update" }>;
    expect(update.employeeId).toBe(old.id);
    expect(update.patch.status).toBe("active");
  });
});

describe("OPC_ORG_PRESETS", () => {
  it("预设可整体应用（corporate 四部门）", () => {
    let state = createEmptyOpcCompanyState(NOW);
    const corporate = OPC_ORG_PRESETS.find(
      (preset) => preset.id === "corporate",
    )!;
    const outcome = buildOpcOrgMutations(state, corporate.draft, NOW + 1);
    for (const mutation of outcome.mutations) {
      state = applyOpcMutation(state, mutation, NOW + 2).state;
    }
    expect(state.roleSlots).toHaveLength(4);
    expect(
      state.employees.filter((employee) => employee.templateId !== "custom"),
    ).toHaveLength(4);
  });
});

describe("buildOpcOrgGeneratePrompt", () => {
  it("含目标与 opc-org 围栏样例", () => {
    const prompt = buildOpcOrgGeneratePrompt({ goal: "做一个电商公司" });
    expect(prompt).toContain("电商");
    expect(prompt).toContain("opc-org");
  });
});

import { parseOpcInboxFile } from "../src/opc/opc-org.js";

describe("parseOpcInboxFile（入站契约）", () => {
  it("标准条目解析 + 缺省填充", () => {
    const item = parseOpcInboxFile(
      "1-plugin.json",
      JSON.stringify({
        title: "修复登录页",
        source: "plugin",
        receivedAt: "2026-01-01T00:00:00Z",
      }),
    )!;
    expect(item?.title).toBe("修复登录页");
    expect(item?.priority).toBe("medium");
    expect(item?.fileName).toBe("1-plugin.json");
  });

  it("坏文件/无标题/路径分隔符拒绝", () => {
    expect(parseOpcInboxFile("a.json", "not json")).toBeNull();
    expect(
      parseOpcInboxFile("a.json", JSON.stringify({ detail: "无标题" })),
    ).toBeNull();
    expect(
      parseOpcInboxFile("../evil.json", JSON.stringify({ title: "x" })),
    ).toBeNull();
  });
});

describe("升级路由按汇报线（五轮 review 补齐）", () => {
  it("直属上级排候选首位（direct-manager），无汇报线时回退同类目", () => {
    const state = createEmptyOpcCompanyState(NOW);
    // 岗位层级：研发负责人（上级） ← 前端工程师（下属）
    const s1 = applyOpcMutation(
      state,
      { kind: "role-slot.create", title: "研发负责人" },
      NOW + 1,
    ).state;
    const leadSlot = s1.roleSlots.at(-1)!;
    const s2 = applyOpcMutation(
      s1,
      {
        kind: "role-slot.create",
        title: "前端工程师",
        parentRoleId: leadSlot.id,
      },
      NOW + 2,
    ).state;
    const frontSlot = s2.roleSlots.at(-1)!;
    // 上级员工 + 下属员工（同 category 工程师）
    const lead = applyOpcMutation(
      s2,
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: leadSlot.id,
        custom: { name: "研发负责人甲", category: "engineering" },
      },
      NOW + 3,
    ).state;
    const founder = lead.employees.find((e) => e.isFallback)!;
    const junior = applyOpcMutation(
      lead,
      {
        kind: "employee.hire",
        templateId: "custom",
        roleId: frontSlot.id,
        custom: { name: "前端工程师乙", category: "engineering" },
      },
      NOW + 4,
    ).state;
    const candidates = findOpcEscalationCandidates(
      junior,
      { assigneeId: junior.employees.at(-1)!.id },
      3,
    );
    expect(candidates[0]?.reason).toBe("direct-manager");
    expect(candidates[0]?.name).toBe("研发负责人甲");
    expect(candidates.some((c) => c.id ?? c.employeeId === founder.id)).toBe(
      candidates.some((c) => c.employeeId === founder.id),
    );
  });
});
