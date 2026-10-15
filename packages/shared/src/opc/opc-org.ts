/**
 * zcode-go OPC 组织智能（Self-Built 自动化）：
 * - 「按目标生成架构」：agent 输出 ```opc-org 围栏 JSON（slots/hires），本文件
 *   解析 + 模板匹配 + 构造 mutation 批，UI 预览后一键应用；
 * - 内置架构预设（corporate/flat），一键应用（岗位去重、招聘复用已有员工）。
 * 纯函数；与 reducer/prompt 构造共享同一套语义（specs/opc-mode.md「组织智能」节）。
 */
import { opcSlugify } from "./opc-template-format.js";
import { OPC_BUILTIN_ROLE_DRAFTS } from "./opc-builtin-roles.js";
import { createOpcEntityId } from "./opc-evolution.js";
import type {
  OpcCompanyState,
  OpcMutation,
  OpcRoleTemplateDraft,
} from "./opc-types.js";
import { extractOpcFencedBlock } from "./opc-template-format.js";

// ---------------------------------------------------------------------------
// opc-org 围栏解析
// ---------------------------------------------------------------------------

/** unknown → 资历字面量（unknown 不被 === 字面量收窄，须显式映射）。 */
function asOpcSeniority(
  value: unknown,
): OpcOrgDraft["hires"][number]["seniority"] {
  if (value === "junior") return "junior";
  if (value === "senior") return "senior";
  if (value === "lead") return "lead";
  return undefined;
}

function parseOpcOrgHire(hire: unknown): OpcOrgDraft["hires"][number] | null {
  if (typeof hire !== "object" || hire === null) return null;
  const item = hire as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!name) return null;
  return {
    name,
    template:
      typeof item.template === "string" ? item.template.trim() : undefined,
    slot: typeof item.slot === "string" ? item.slot.trim() : undefined,
    seniority: asOpcSeniority(item.seniority),
  };
}

export interface OpcOrgDraft {
  companyName?: string;
  /** 岗位标题（扁平；层级由先后与命名表达）。 */
  slots: string[];
  hires: Array<{
    name: string;
    /** 模板名（对内置/导入模板做名称匹配；未命中按自定义招聘）。 */
    template?: string;
    /** 目标岗位标题（须在 slots 中或已存在）。 */
    slot?: string;
    seniority?: "junior" | "senior" | "lead";
  }>;
}

/** 解析 agent 输出的 ```opc-org 围栏 JSON；容错：坏 JSON 返回 null（不猜）。 */
export function parseOpcOrgBlock(text: string): OpcOrgDraft | null {
  const raw = extractOpcFencedBlock(text, "opc-org");
  if (!raw) return null;
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const slots = Array.isArray(record.slots)
      ? record.slots.filter(
          (slot): slot is string =>
            typeof slot === "string" && slot.trim().length > 0,
        )
      : [];
    const hires = Array.isArray(record.hires)
      ? record.hires.map(parseOpcOrgHire).filter((hire) => hire !== null)
      : [];
    return {
      companyName:
        typeof record.companyName === "string" && record.companyName.trim()
          ? record.companyName.trim()
          : undefined,
      slots,
      hires,
    };
  } catch {
    return null;
  }
}

/** 「生成组织架构」prompt（注入 composer；输出 opc-org 围栏 JSON）。 */
export function buildOpcOrgGeneratePrompt(input: { goal: string }): string {
  return [
    "请为以下公司目标设计一套精干的 AI 员工组织架构（3-8 人为宜）：",
    "",
    input.goal.trim(),
    "",
    "设计要求：",
    "- slots 给出岗位标题（如「研发负责人」），hires 给出每位员工的姓名、模板、岗位与资历；",
    "- template 尽量从常见角色名里选（如「全栈开发工程师」「深度调研分析师」「内容营销策略师」「财务分析师」）；",
    "- 一人一岗，创始人（CEO）已存在不要重复安排；",
    "- 严格只输出以下 JSON 围栏块：",
    "",
    "```opc-org",
    '{ "companyName": "公司名", "slots": ["研发负责人"], "hires": [{ "name": "姓名", "template": "全栈开发工程师", "slot": "研发负责人", "seniority": "senior" }] }',
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 模板匹配 + mutation 构造
// ---------------------------------------------------------------------------

/** 按名称匹配模板：精确 slug → 名称包含（大小写不敏感）→ null（自定义招聘）。 */
export function matchOpcRoleTemplate(
  name: string,
  imported: OpcCompanyState["roleTemplates"],
): { id: string; draft: OpcRoleTemplateDraft } | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const wantedSlug = opcSlugify(wanted);
  const pool: Array<{
    id: string;
    name: string;
    description: string;
    color: string;
    emoji: string;
    vibe: string;
    category: string;
    body: string;
  }> = [
    ...imported.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      color: template.color,
      emoji: template.emoji,
      vibe: template.vibe,
      category: template.category,
      body: "",
    })),
    ...OPC_BUILTIN_ROLE_DRAFTS,
  ];
  const exact = pool.find(
    (draft) => draft.id === wantedSlug || draft.name === wanted,
  );
  if (exact) return { id: exact.id, draft: exact };
  const lower = wanted.toLowerCase();
  const contains = pool.find(
    (draft) =>
      draft.name.toLowerCase().includes(lower) ||
      lower.includes(draft.name.toLowerCase()),
  );
  if (contains) return { id: contains.id, draft: contains };
  return null;
}

export interface OpcOrgApplyOutcome {
  mutations: OpcMutation[];
  /** 摘要（UI 预览）：新建岗位/招聘/复用 数量。 */
  summary: { slots: number; hires: number; reused: number; skipped: number };
}

/**
 * 把组织草稿转成 mutation 批：岗位去重（已存在不重建）、模板匹配（内置/导入库
 * 名称匹配，未命中走自定义）、员工去重（同名在职员工跳过；同模板的暂停/离职
 * 员工复用 = employee.update 恢复 + 换岗）。
 */
export function buildOpcOrgMutations(
  state: OpcCompanyState,
  draft: OpcOrgDraft,
  now: number,
): OpcOrgApplyOutcome {
  const mutations: OpcMutation[] = [];
  let slotsCreated = 0;
  let hiresCreated = 0;
  let reused = 0;
  let skipped = 0;

  if (draft.companyName && draft.companyName !== state.company.name) {
    mutations.push({ kind: "company.rename", name: draft.companyName });
  }

  // 岗位：已存在的同名岗位直接复用 id
  const slotIdByTitle = new Map(
    state.roleSlots.map((slot) => [slot.title, slot.id]),
  );
  for (const title of draft.slots) {
    if (slotIdByTitle.has(title)) continue;
    const id = createOpcEntityId("slot", now);
    slotIdByTitle.set(title, id);
    mutations.push({ kind: "role-slot.create", title });
    slotsCreated += 1;
  }

  const activeNames = new Set(
    state.employees
      .filter((employee) => employee.status === "active")
      .map((employee) => employee.name),
  );

  for (const hire of draft.hires) {
    if (activeNames.has(hire.name)) {
      skipped += 1;
      continue;
    }
    const roleId = hire.slot ? (slotIdByTitle.get(hire.slot) ?? null) : null;
    // 复用：同模板的暂停/离职员工 → 恢复 + 换岗，而非新招
    const reusable = state.employees.find(
      (employee) =>
        employee.status !== "active" &&
        hire.template !== undefined &&
        employee.templateId === hire.template &&
        !employee.isFallback,
    );
    if (reusable) {
      mutations.push({
        kind: "employee.update",
        employeeId: reusable.id,
        patch: { status: "active", roleId, name: hire.name },
      });
      reused += 1;
      continue;
    }
    const matched = hire.template
      ? matchOpcRoleTemplate(hire.template, state.roleTemplates)
      : null;
    if (matched) {
      mutations.push({
        kind: "employee.hire",
        templateId: matched.id,
        roleId,
        custom: {
          name: hire.name,
          category: matched.draft.category,
          emoji: matched.draft.emoji,
          color: matched.draft.color,
          vibe: matched.draft.vibe,
          description: matched.draft.description,
          seniority: hire.seniority ?? "senior",
        },
      });
    } else {
      mutations.push({
        kind: "employee.hire",
        templateId: "custom",
        roleId,
        custom: {
          name: hire.name,
          category: "general",
          emoji: "🧑‍💼",
          color: "slate",
          vibe: "",
          description: hire.template
            ? `按架构生成（模板「${hire.template}」未在模板库命中）`
            : "按架构生成",
          seniority: hire.seniority ?? "junior",
        },
      });
    }
    // 批内同名去重：后续条目按在职处理
    activeNames.add(hire.name);
    hiresCreated += 1;
  }

  return {
    mutations,
    summary: { slots: slotsCreated, hires: hiresCreated, reused, skipped },
  };
}

// ---------------------------------------------------------------------------
// 内置架构预设
// ---------------------------------------------------------------------------

export interface OpcOrgPreset {
  id: string;
  title: string;
  description: string;
  draft: OpcOrgDraft;
}

export const OPC_ORG_PRESETS: OpcOrgPreset[] = [
  {
    id: "corporate",
    title: "标准公司（四部门）",
    description:
      "技术 / 产品 / 增长 / 运营 四位负责人，覆盖研发-产品-获客-交付闭环。",
    draft: {
      slots: ["技术负责人", "产品负责人", "增长负责人", "运营负责人"],
      hires: [
        {
          name: "技术合伙人",
          template: "CTO 技术顾问",
          slot: "技术负责人",
          seniority: "lead",
        },
        {
          name: "首席产品官",
          template: "产品经理",
          slot: "产品负责人",
          seniority: "lead",
        },
        {
          name: "增长负责人",
          template: "销售增长负责人",
          slot: "增长负责人",
          seniority: "senior",
        },
        {
          name: "运营管家",
          template: "行政与流程管家",
          slot: "运营负责人",
          seniority: "senior",
        },
      ],
    },
  },
  {
    id: "engineering",
    title: "研发铁三角",
    description: "前后端 + 质量的最小研发单元，适合以交付为绝对重心的小团队。",
    draft: {
      slots: ["前端负责人", "后端负责人", "质量负责人"],
      hires: [
        {
          name: "前端负责人",
          template: "前端工程师",
          slot: "前端负责人",
          seniority: "senior",
        },
        {
          name: "后端负责人",
          template: "后端架构师",
          slot: "后端负责人",
          seniority: "lead",
        },
        {
          name: "质量负责人",
          template: "测试工程师",
          slot: "质量负责人",
          seniority: "senior",
        },
      ],
    },
  },
  {
    id: "flat",
    title: "扁平（无岗位）",
    description: "不设岗位，员工直隶创始人；适合一人公司的轻量协作。",
    draft: { slots: [], hires: [] },
  },
];
