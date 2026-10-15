import { describe, expect, it } from "vitest";
import {
  applyOpcPackFiles,
  type OpcPackSourceFile,
} from "../src/opc/opc-packs.js";
import { createEmptyOpcCompanyState } from "../src/opc/opc-reducer.js";

const NOW = 1_700_000_000_000;
const MANIFEST = {
  id: "claude-skills",
  version: "abc123def456",
  repo: "HighCWu/claude-skills",
  ref: "main",
};

const TALENT_MD = [
  "---",
  "name: Content Creator",
  "description: Creates marketing content",
  "color: pink",
  "emoji: ✍️",
  "vibe: Audience first",
  "---",
  "",
  "正文",
].join("\n");

const SKILL_MD = [
  "---",
  "name: pack-skill",
  "description: Use when 测试模板包导入",
  "metadata:",
  "  version: 2.5.0",
  "  category: engineering",
  "---",
  "",
  "## 工作流",
  "1. 步骤",
].join("\n");

const FILES: OpcPackSourceFile[] = [
  { relativePath: "talent/marketing-content-creator.md", content: TALENT_MD },
  {
    relativePath: "productivity/pack-skill/skills/pack-skill/SKILL.md",
    content: SKILL_MD,
  },
  { relativePath: "README.md", content: "# 无 frontmatter，应跳过" },
  { relativePath: "broken.md", content: "---\n没有结束围栏" },
];

describe("applyOpcPackFiles", () => {
  it("导入角色与技能、跳过非模板文档、盖版本戳", () => {
    const base = createEmptyOpcCompanyState(NOW);
    const outcome = applyOpcPackFiles(base, MANIFEST, FILES, NOW + 1);
    expect(outcome.importedRoles).toBe(1);
    expect(outcome.importedSkills).toBe(1);
    expect(outcome.state.roleTemplates[0]?.id).toBe("content-creator");
    expect(
      outcome.state.skills.some((skill) => skill.id === "pack-skill"),
    ).toBe(true);
    expect(outcome.state.packImports?.["claude-skills"]).toBe("abc123def456");
    expect(outcome.skillBodies["pack-skill"]).toContain("工作流");
    expect(outcome.roleTemplateFiles["content-creator"]).toBe(TALENT_MD);
    expect(outcome.events).toHaveLength(1);
  });

  it("幂等：同批文件重放不产生重复项、不再记事件", () => {
    const base = createEmptyOpcCompanyState(NOW);
    const first = applyOpcPackFiles(base, MANIFEST, FILES, NOW + 1);
    const second = applyOpcPackFiles(first.state, MANIFEST, FILES, NOW + 2);
    expect(second.importedRoles).toBe(0);
    expect(second.importedSkills).toBe(0);
    expect(second.state.roleTemplates).toHaveLength(1);
    expect(
      second.state.skills.filter((skill) => skill.id === "pack-skill"),
    ).toHaveLength(1);
    expect(second.state.evolution).toHaveLength(first.state.evolution.length);
  });

  it("用户已有同 id 技能（含晋升产物）不被包覆盖", () => {
    const base = createEmptyOpcCompanyState(NOW);
    const withPromoted = {
      ...base,
      skills: [
        {
          id: "pack-skill",
          name: "Playbook：用户自己的",
          description: "用户晋升产物",
          category: "general",
          version: 3,
          origin: "promoted" as const,
          changelog: [],
          updatedAt: NOW,
        },
      ],
    };
    const outcome = applyOpcPackFiles(withPromoted, MANIFEST, FILES, NOW + 1);
    expect(outcome.importedSkills).toBe(0);
    expect(outcome.state.skills[0]?.origin).toBe("promoted");
    expect(outcome.state.skills[0]?.version).toBe(3);
    expect(outcome.skillBodies["pack-skill"]).toBeUndefined();
  });

  it("包更新（新版本戳）时补齐新增项并刷新戳", () => {
    const base = createEmptyOpcCompanyState(NOW);
    const v1 = applyOpcPackFiles(base, MANIFEST, FILES, NOW + 1);
    const newFiles: OpcPackSourceFile[] = [
      ...FILES,
      {
        relativePath: "finance/估值分析师.md",
        content:
          "---\nname: Valuation Analyst\ndescription: DCF 估值\ncolor: lime\nemoji: 📈\nvibe: 先证伪\n---\n\n正文",
      },
    ];
    const v2 = applyOpcPackFiles(
      v1.state,
      { ...MANIFEST, version: "fff000aaa111" },
      newFiles,
      NOW + 3,
    );
    expect(v2.importedRoles).toBe(1);
    expect(v2.state.packImports?.["claude-skills"]).toBe("fff000aaa111");
    expect(v2.state.roleTemplates).toHaveLength(2);
  });
});
