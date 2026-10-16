/* oxlint-disable eslint(max-lines) -- 组织智能三类能力（生成/预设/升级路由）共用模板匹配基础设施，单文件收口（同插件宿主惯例）。 */
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
    // 显式携带预生成 id：reducer 自造 id 与批内 roleId 映射脱节 → 幽灵绑定
    mutations.push({ kind: "role-slot.create", title, id });
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
    // 复用：同模板的暂停/离职员工 → 恢复 + 换岗，而非新招。
    // hire.template 是模板名（或 id）；员工存的是模板 id——直接比名字只有
    // CJK 模板（slug=名称）碰巧命中，ASCII 名永不复用。先解析成 id 再比。
    const reuseTemplateId = hire.template
      ? (matchOpcRoleTemplate(hire.template, state.roleTemplates)?.id ??
        hire.template)
      : null;
    const reusable = state.employees.find(
      (employee) =>
        employee.status !== "active" &&
        reuseTemplateId !== null &&
        employee.templateId === reuseTemplateId &&
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

import type { OpcInboxItem } from "./opc-types.js";

/** inbox 文件内容 → 条目（宽松解析：title 必填，其余缺省；坏文件返回 null）。 */
export function parseOpcInboxFile(
  fileName: string,
  text: string,
): OpcInboxItem | null {
  if (fileName.includes("/") || fileName.includes("\\")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return null;
  const priority =
    record.priority === "low" ||
    record.priority === "medium" ||
    record.priority === "high" ||
    record.priority === "urgent"
      ? record.priority
      : "medium";
  return {
    fileName,
    title,
    detail: typeof record.detail === "string" ? record.detail : undefined,
    priority,
    source: typeof record.source === "string" ? record.source : undefined,
    receivedAt:
      typeof record.receivedAt === "string"
        ? record.receivedAt
        : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 升级团队内路由（OpenOPC：先团队内解决，超权限才升级所有者）
// ---------------------------------------------------------------------------

export interface OpcEscalationCandidate {
  employeeId: string;
  name: string;
  emoji: string;
  /** 同类目同事优先，其次按完成数排序的依据说明。 */
  reason: "peer-category" | "top-completed";
  completed: number;
}

/**
 * 升级转派候选：同类目在职同事（排除当前负责人与创始人）按完成数排序优先，
 * 不足额时用完成数最高的其他非创始人成员补齐。
 */
export function findOpcEscalationCandidates(
  state: OpcCompanyState,
  workItem: Pick<OpcCompanyState["workItems"][number], "assigneeId">,
  topN = 3,
): OpcEscalationCandidate[] {
  const currentAssignee = state.employees.find(
    (employee) => employee.id === workItem.assigneeId,
  );
  const category = currentAssignee?.category;
  const candidates = state.employees.filter(
    (employee) =>
      employee.status === "active" &&
      !employee.isFallback &&
      employee.id !== workItem.assigneeId,
  );
  const peers = category
    ? candidates.filter((employee) => employee.category === category)
    : [];
  const others = candidates.filter(
    (employee) => !category || employee.category !== category,
  );
  const byCompleted = (
    a: OpcEscalationCandidate,
    b: OpcEscalationCandidate,
  ): number => b.completed - a.completed;
  const toCandidate = (
    employee: OpcCompanyState["employees"][number],
    reason: OpcEscalationCandidate["reason"],
  ): OpcEscalationCandidate => ({
    employeeId: employee.id,
    name: employee.name,
    emoji: employee.emoji,
    reason,
    completed: employee.stats.completed,
  });
  const ranked = [
    ...peers
      .sort((a, b) =>
        byCompleted(
          toCandidate(a, "peer-category"),
          toCandidate(b, "peer-category"),
        ),
      )
      .map((employee) => toCandidate(employee, "peer-category")),
    ...others
      .sort((a, b) =>
        byCompleted(
          toCandidate(a, "top-completed"),
          toCandidate(b, "top-completed"),
        ),
      )
      .map((employee) => toCandidate(employee, "top-completed")),
  ];
  return ranked.slice(0, topN);
}
