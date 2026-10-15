import { describe, expect, it } from "vitest";
import {
  extractOpcFencedBlock,
  opcSlugify,
  parseOpcLessonsBlock,
  parseOpcRoleTemplate,
  parseOpcSkillMarkdown,
} from "../src/opc/opc-template-format.js";

describe("opcSlugify", () => {
  it("中文保留、空格与标点转连字符", () => {
    expect(opcSlugify("全栈开发工程师")).toBe("全栈开发工程师");
    expect(opcSlugify("Deep Research Skill!")).toBe("deep-research-skill");
    expect(opcSlugify("  SEO  审计  ")).toBe("seo-审计");
  });

  it("空结果回退为空串（调用方负责兜底 id）", () => {
    expect(opcSlugify("!!!")).toBe("");
  });
});

describe("parseOpcRoleTemplate", () => {
  const openOpcStyle = [
    "---",
    "name: DevOps Automator",
    "description: Automates deployment pipelines",
    "color: orange",
    "emoji: ⚙️",
    "vibe: Ship boring releases",
    "---",
    "",
    "## Core Mission",
    "",
    "Keep deploys boring.",
  ].join("\n");

  it("解析 OpenOPC 五字段 frontmatter", () => {
    const draft = parseOpcRoleTemplate(openOpcStyle);
    expect(draft).not.toBeNull();
    expect(draft?.name).toBe("DevOps Automator");
    expect(draft?.color).toBe("orange");
    expect(draft?.emoji).toBe("⚙️");
    expect(draft?.vibe).toBe("Ship boring releases");
    expect(draft?.category).toBe("engineering");
    expect(draft?.body).toContain("Keep deploys boring");
    expect(draft?.id).toBe("devops-automator");
  });

  it("无 frontmatter 时回退正文首个标题，不抛错", () => {
    const draft = parseOpcRoleTemplate("# 财务分析师\n\n负责预算。");
    expect(draft?.name).toBe("财务分析师");
    expect(draft?.category).toBe("finance");
  });

  it("空内容返回 null", () => {
    expect(parseOpcRoleTemplate("")).toBeNull();
  });
});

describe("parseOpcSkillMarkdown", () => {
  it("解析 claude-skills 风格 frontmatter（含 metadata 嵌套 category）", () => {
    const draft = parseOpcSkillMarkdown(
      [
        "---",
        "name: deep-work",
        "description: Use when planning a deep work day",
        "metadata:",
        "  version: 1.0.0",
        "  category: productivity",
        "---",
        "",
        "## Workflow",
        "1. Classify tasks",
      ].join("\n"),
    );
    expect(draft?.id).toBe("deep-work");
    expect(draft?.category).toBe("productivity");
    expect(draft?.body).toContain("Classify tasks");
  });

  it("frontmatter 缺 category 时按名称猜测", () => {
    const draft = parseOpcSkillMarkdown(
      [
        "---",
        "name: seo-audit",
        "description: 搜索引擎优化审计",
        "---",
        "",
        "正文",
      ].join("\n"),
    );
    expect(draft?.category).toBe("marketing");
  });
});

describe("extractOpcFencedBlock", () => {
  it("三反引号围栏", () => {
    const text = '前言\n```opc-lessons\n{"a":1}\n```\n后记';
    expect(extractOpcFencedBlock(text, "opc-lessons")).toBe('{"a":1}');
  });

  it("四反引号围栏容忍内部三反引号代码块", () => {
    const text = "````opc-skill\n# Title\n```js\ncode()\n```\n````\n尾部";
    expect(extractOpcFencedBlock(text, "opc-skill")).toBe(
      "# Title\n```js\ncode()\n```",
    );
  });

  it("缺失闭合时取到文末", () => {
    expect(extractOpcFencedBlock("```opc-lessons\nabc", "opc-lessons")).toBe(
      "abc",
    );
  });

  it("无命中返回 null", () => {
    expect(extractOpcFencedBlock("没有任何围栏", "opc-lessons")).toBeNull();
  });
});

describe("parseOpcLessonsBlock", () => {
  it("解析标准 JSON 围栏块", () => {
    const text = [
      "复盘如下：",
      "```opc-lessons",
      '{"lessons":[{"statement":"先止血再归因","tags":["incident"]}], "summary":"ok"}',
      "```",
    ].join("\n");
    expect(parseOpcLessonsBlock(text)).toEqual([
      { statement: "先止血再归因", tags: ["incident"] },
    ]);
  });

  it("JSON 损坏时回退列表行提取", () => {
    const text = "```opc-lessons\n- 经验一\n- 经验二\n```";
    expect(parseOpcLessonsBlock(text)).toEqual([
      { statement: "经验一", tags: [] },
      { statement: "经验二", tags: [] },
    ]);
  });

  it("无围栏返回空数组", () => {
    expect(parseOpcLessonsBlock("普通文本")).toEqual([]);
  });
});
