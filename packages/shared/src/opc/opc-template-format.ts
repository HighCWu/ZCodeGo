/**
 * zcode-go OPC 模板格式解析（纯函数，零依赖）。
 *
 * 兼容两种上游格式：
 * - OpenOPC talent 模板：五字段 frontmatter（name/description/color/emoji/vibe）+ 正文；
 * - claude-skills SKILL.md：frontmatter（name/description/metadata{version,category,...}）+ 正文。
 *
 * frontmatter 解析是手写子集（平铺 key: value + 一层嵌套 map + 行内数组），
 * 不引入 YAML 依赖：两个上游的 frontmatter 都落在这个子集内，容错策略是
 * 「解析不出就回退正文首行/文件名」，绝不让单个坏文件中断批量导入。
 */
import type { OpcRoleTemplateDraft, OpcSkillDraft } from "./opc-types.js";

export interface OpcFrontmatter {
  values: Record<string, string>;
  /** 一层嵌套（如 metadata.version）。 */
  nested: Record<string, Record<string, string>>;
  body: string;
}

export function parseOpcFrontmatter(markdown: string): OpcFrontmatter {
  const values: Record<string, string> = {};
  const nested: Record<string, Record<string, string>> = {};
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { values, nested, body: normalized };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) {
    return { values, nested, body: normalized };
  }
  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "");
  let currentNestedKey: string | null = null;
  for (const rawLine of block.split("\n")) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const isNestedLine = /^\s{2,}/.test(rawLine);
    const line = rawLine.trim();
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (isNestedLine && currentNestedKey) {
      const bucket = (nested[currentNestedKey] ??= {});
      bucket[key] = value.replace(/^['"]|['"]$/g, "");
      continue;
    }
    currentNestedKey = value === "" ? key : null;
    values[key] = value.replace(/^['"]|['"]$/g, "");
  }
  return { values, nested, body };
}

/**
 * slug：CJK 保留原字、空格/标点转 -、小写化、去重连字符、截断 64（与
 * claude-skills 命名规范一致）。中文名称直接保留（目录名跨平台均可）。
 */
export function opcSlugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug;
}

let opcIdCounter = 0;

/** 模板/技能 id：slug 为空时回退 <prefix>-<时间+序号>（保证目录名可用）。 */
export function opcStableId(prefix: string, name: string): string {
  const slug = opcSlugify(name);
  if (slug.length > 0) return slug;
  opcIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${opcIdCounter}`;
}

const ROLE_CATEGORYHints: Array<[RegExp, string]> = [
  [
    /engineer|developer|devops|architect|backend|frontend|fullstack|qa|sre|工程|开发|测试|架构/i,
    "engineering",
  ],
  [/marketing|seo|growth|copy|brand|营销|增长|文案|品牌/i, "marketing"],
  [/finance|account|invest|cfo|财务|会计|投资/i, "finance"],
  [/sales|bd|customer|销售|客户|商务/i, "sales"],
  [/design|ux|ui|designer|设计/i, "design"],
  [/research|scientist|研究|科学/i, "research"],
  [/legal|hr|complian|法务|人力|合规/i, "operations"],
  [/education|teach|培训|教育/i, "education"],
  [/media|content|video|内容|媒体|视频/i, "media"],
  [/product|manager|pm|产品/i, "product"],
  [/ceo|cto|coo|founder|officer|执行官|创始人/i, "executive"],
];

/** 从名字/描述猜分类（导入模板常不写 category）。 */
export function guessOpcCategory(name: string, description: string): string {
  const haystack = `${name} ${description}`;
  for (const [pattern, category] of ROLE_CATEGORYHints) {
    if (pattern.test(haystack)) return category;
  }
  return "general";
}

/** OpenOPC talent 模板 → 标准草稿。 */
export function parseOpcRoleTemplate(
  markdown: string,
  options: { fallbackCategory?: string } = {},
): OpcRoleTemplateDraft | null {
  const { values, body } = parseOpcFrontmatter(markdown);
  const firstLine =
    body
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  const name = values.name || firstLine.replace(/^#+\s*/, "");
  if (!name) return null;
  const description = values.description || "";
  return {
    id: opcStableId("role", name),
    name,
    description,
    color: values.color || "slate",
    emoji: values.emoji || "🧑‍💼",
    vibe: values.vibe || "",
    category:
      values.category ||
      options.fallbackCategory ||
      guessOpcCategory(name, description),
    body,
  };
}

/** claude-skills SKILL.md → 标准草稿。 */
export function parseOpcSkillMarkdown(
  markdown: string,
  options: { fallbackName?: string; fallbackCategory?: string } = {},
): OpcSkillDraft | null {
  const { values, nested, body } = parseOpcFrontmatter(markdown);
  const firstLine =
    body
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  const name =
    values.name || options.fallbackName || firstLine.replace(/^#+\s*/, "");
  if (!name) return null;
  const description = values.description || "";
  const category =
    values.category ||
    values.domain ||
    nested.metadata?.category ||
    options.fallbackCategory ||
    guessOpcCategory(name, description);
  return {
    id: opcStableId("skill", name),
    name,
    description,
    category,
    body,
  };
}

/**
 * 提取 <fenceName> 围栏块内容（取第一个命中；容错缺失闭合取到文末）。
 * 支持三反引号与四反引号两种围栏——技能升级输出里嵌套 ``` 代码块时 prompt
 * 会要求 agent 用四反引号包裹，提取按开启围栏的长度匹配对应闭合，避免被
 * 嵌套代码块提前截断。
 */
export function extractOpcFencedBlock(
  text: string,
  fenceName: string,
): string | null {
  const normalized = text.replace(/\r\n/g, "\n");
  for (const fenceLength of [4, 3] as const) {
    const opener = "`".repeat(fenceLength) + fenceName;
    const start = normalized.indexOf(opener);
    if (start < 0) continue;
    const rest = normalized.slice(start + opener.length).replace(/^\n/, "");
    const closer = "\n" + "`".repeat(fenceLength);
    const closerIndex = rest.indexOf(closer);
    if (closerIndex < 0) return rest.trimEnd() || null;
    return rest.slice(0, closerIndex).trimEnd() || null;
  }
  return null;
}

export interface OpcParsedLesson {
  statement: string;
  tags: string[];
  /** 项目复盘时的员工归属（单员工复盘可缺省）。 */
  employee?: string;
}

/** 解析 agent 复盘输出的 ```opc-lessons JSON 块；容错：JSON 坏时逐行提取引号句。 */
export function parseOpcLessonsBlock(text: string): OpcParsedLesson[] {
  const raw = extractOpcFencedBlock(text, "opc-lessons");
  if (!raw) return [];
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      const lessons = (parsed as { lessons?: unknown }).lessons;
      if (Array.isArray(lessons)) {
        const result = lessons
          .map((item) => {
            const record = item as Record<string, unknown>;
            const statement =
              typeof record.statement === "string"
                ? record.statement.trim()
                : "";
            const tags = Array.isArray(record.tags)
              ? record.tags.filter(
                  (tag): tag is string =>
                    typeof tag === "string" && tag.trim().length > 0,
                )
              : [];
            if (statement.length === 0) return null;
            const employee =
              typeof record.employee === "string" && record.employee.trim()
                ? record.employee.trim()
                : undefined;
            return employee
              ? { statement, tags, employee }
              : { statement, tags };
          })
          .filter((item): item is OpcParsedLesson => item !== null);
        if (result.length > 0) return result;
      }
    } catch {
      /* 落入行级兜底 */
    }
  }
  // 行级兜底：取 "- " 列表项当经验句
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && line.length > 4)
    .map((line) => ({ statement: line.slice(2).trim(), tags: [] as string[] }));
}
