/**
 * zcode-go OPC 模式共享类型（纯类型层，零 IO、零跨包依赖）。
 *
 * OPC（AI 原生公司）是继 coding/office 之后的第三个界面模式。状态事实源在
 * desktop main（<workspace>/.opc/company.json），本文件是 main 持久化、
 * ui 展示、shared 纯逻辑（reducer/进化引擎/prompt 构造）三方共用的契约。
 * spec：specs/opc-mode.md
 */

export const OPC_STATE_SCHEMA_VERSION = 1;
export const OPC_DIR_NAME = ".opc";
export const OPC_COMPANY_FILE = "company.json";
export const OPC_SKILLS_DIR = "skills";
export const OPC_MEMORY_DIR = "memory";
export const OPC_TEMPLATES_DIR = "templates";
export const OPC_ROLES_TEMPLATES_SUBDIR = "roles";
export const OPC_EVOLUTION_LOG_FILE = "evolution-log.jsonl";

/** 工作项状态机（吸收 OpenOPC WorkItem 看板语义）。 */
export type OpcWorkItemStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "review"
  | "done"
  | "cancelled";

/**
 * 合法状态流转：正向推进 + 回退 backlog；done 为终态（重开须显式 cancelled→backlog
 * 之外的路径不存在——重做请新建工作项并引用原 id）。cancelled 允许回 backlog（误关恢复）。
 */
export const OPC_WORK_ITEM_TRANSITIONS: Record<
  OpcWorkItemStatus,
  readonly OpcWorkItemStatus[]
> = {
  backlog: ["ready", "cancelled"],
  ready: ["in_progress", "backlog", "cancelled"],
  in_progress: ["review", "ready", "cancelled"],
  review: ["done", "in_progress", "cancelled"],
  done: [],
  cancelled: ["backlog"],
};

export function isOpcWorkItemTransition(
  from: OpcWorkItemStatus,
  to: OpcWorkItemStatus,
): boolean {
  return from !== to && OPC_WORK_ITEM_TRANSITIONS[from].includes(to);
}

export type OpcWorkItemPriority = "low" | "medium" | "high" | "urgent";

export interface OpcWorkItem {
  id: string;
  title: string;
  /** 验收标准 / 背景说明（markdown）。 */
  detail: string;
  status: OpcWorkItemStatus;
  assigneeId: string | null;
  priority: OpcWorkItemPriority;
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** 最近一次委派对应的会话 id（可选留痕，便于回溯）。 */
  sessionId?: string;
}

export type OpcEmployeeSeniority = "junior" | "senior" | "lead";
export type OpcEmployeeStatus = "active" | "paused" | "departed";

export interface OpcEmployee {
  id: string;
  name: string;
  /** 实例化来源模板 id；自定义招聘为 "custom"。 */
  templateId: string;
  /** 组织岗位 id（roleSlots 内）；可为 null（扁平直隶创始人）。 */
  roleId: string | null;
  /** 领域分类（engineering/marketing/finance/...），来自模板或招聘时指定。 */
  category: string;
  emoji: string;
  color: string;
  vibe: string;
  description: string;
  seniority: OpcEmployeeSeniority;
  status: OpcEmployeeStatus;
  /** 挂接技能 id 列表（.opc/skills/<id>/SKILL.md）。 */
  skillRefs: string[];
  stats: {
    completed: number;
    retrospectives: number;
    lessons: number;
  };
  createdAt: number;
  /** OpenOPC 语义：无匹配模板时自动生成的占位员工。 */
  isFallback?: boolean;
}

/** 组织岗位槽位（极简拓扑；深度由 parentRoleId 链表达）。 */
export interface OpcRoleSlot {
  id: string;
  title: string;
  parentRoleId: string | null;
  employeeId: string | null;
}

/** 一条蒸馏后的经验教训（复盘产物）。 */
export interface OpcLesson {
  id: string;
  employeeId: string;
  workItemId: string | null;
  /** 一句话经验（可执行、可复用）。 */
  statement: string;
  tags: string[];
  /** 归一化指纹：跨复盘计数、晋升判定的 key。 */
  statementKey: string;
  /** 所属复盘批次 id：晋升阈值按「独立复盘次数」计数，同一批多条同指纹只算一次。 */
  retroId: string;
  createdAt: number;
}

export type OpcSkillOrigin = "builtin" | "imported" | "promoted";

export interface OpcSkillMeta {
  /** 目录名（.opc/skills/<id>/）。 */
  id: string;
  name: string;
  description: string;
  category: string;
  version: number;
  origin: OpcSkillOrigin;
  /** origin=promoted 时的来源员工。 */
  promotedFromEmployeeId?: string;
  /** 版本变更记录（每条一行 markdown）。 */
  changelog: string[];
  updatedAt: number;
}

export type OpcEvolutionEventKind =
  | "company-init"
  | "hire"
  | "depart"
  | "workitem"
  | "retro"
  | "promote"
  | "skill-upgrade"
  | "skill-import"
  | "template-import";

export interface OpcEvolutionEvent {
  id: string;
  at: number;
  kind: OpcEvolutionEventKind;
  summary: string;
}

/** 导入的角色模板（OpenOPC talent 五字段格式）元数据；正文在 templates/roles/<id>.md。 */
export interface OpcRoleTemplateMeta {
  id: string;
  name: string;
  description: string;
  color: string;
  emoji: string;
  vibe: string;
  category: string;
  /** imported = 用户从磁盘导入；builtin 由内置包按 id 提供。 */
  origin: "imported";
  importedAt: number;
}

export interface OpcCompanyState {
  schemaVersion: typeof OPC_STATE_SCHEMA_VERSION;
  company: {
    name: string;
    createdAt: number;
    topology: "flat" | "corporate";
  };
  roleSlots: OpcRoleSlot[];
  employees: OpcEmployee[];
  workItems: OpcWorkItem[];
  lessons: OpcLesson[];
  skills: OpcSkillMeta[];
  roleTemplates: OpcRoleTemplateMeta[];
  evolution: OpcEvolutionEvent[];
}

// ---------------------------------------------------------------------------
// Mutation（UI → main 的唯一写入路径；reducer 在 shared，main/ui 共享语义）
// ---------------------------------------------------------------------------

export interface OpcCustomEmployeeDraft {
  name: string;
  category: string;
  emoji: string;
  color: string;
  vibe: string;
  description: string;
  seniority: OpcEmployeeSeniority;
}

export type OpcMutation =
  | { kind: "company.rename"; name: string }
  | { kind: "role-slot.create"; title: string }
  | { kind: "role-slot.remove"; roleId: string }
  | {
      kind: "employee.hire";
      templateId: string;
      /** 内置模板 id 或导入模板 id；"custom" 时必须给 custom。 */
      roleId: string | null;
      custom?: Partial<OpcCustomEmployeeDraft>;
      skillRefs?: string[];
    }
  | {
      kind: "employee.update";
      employeeId: string;
      patch: Partial<
        Pick<
          OpcEmployee,
          "name" | "seniority" | "status" | "vibe" | "description" | "roleId"
        >
      >;
    }
  | { kind: "employee.depart"; employeeId: string }
  | {
      kind: "employee.assignSkill";
      employeeId: string;
      skillId: string;
      attach: boolean;
    }
  | {
      kind: "workitem.create";
      title: string;
      detail?: string;
      assigneeId?: string | null;
      priority?: OpcWorkItemPriority;
      dependsOn?: string[];
    }
  | {
      kind: "workitem.update";
      workItemId: string;
      patch: Partial<
        Pick<
          OpcWorkItem,
          "title" | "detail" | "assigneeId" | "priority" | "dependsOn"
        >
      >;
    }
  | { kind: "workitem.status"; workItemId: string; status: OpcWorkItemStatus }
  | { kind: "workitem.delete"; workItemId: string }
  | {
      kind: "retro.record";
      employeeId: string;
      workItemId?: string | null;
      lessons: Array<{ statement: string; tags: string[] }>;
      note?: string;
    }
  | {
      kind: "skill.import";
      /** 缺省由名称 slug 生成；重复 id 走版本覆盖。 */
      skillId?: string;
      name: string;
      description: string;
      category?: string;
      /** SKILL.md 全文（含或不含 frontmatter 均可）。 */
      body: string;
    }
  | { kind: "skill.upgrade"; skillId: string; body: string; note?: string }
  | { kind: "skill.remove"; skillId: string }
  | { kind: "template.importRole"; markdown: string };

export interface OpcMutationResult {
  state: OpcCompanyState;
  /** 本次应用产生的进化事件（用于 UI 提示 / 测试断言）。 */
  events: OpcEvolutionEvent[];
  /** 进化引擎自动晋升产生的技能 id（用于 UI 提示）。 */
  promotedSkillIds: string[];
}

// ---------------------------------------------------------------------------
// 模板 / 技能草稿（解析器产物）
// ---------------------------------------------------------------------------

/** OpenOPC talent 模板解析产物（五字段 frontmatter + 正文）。 */
export interface OpcRoleTemplateDraft {
  id: string;
  name: string;
  description: string;
  color: string;
  emoji: string;
  vibe: string;
  /** frontmatter 未给出时的兜底分类（导入方可传目录名）。 */
  category: string;
  body: string;
}

/** SKILL.md（claude-skills 格式）解析产物。 */
export interface OpcSkillDraft {
  id: string;
  name: string;
  description: string;
  category: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Prompt 构造输入
// ---------------------------------------------------------------------------

export interface OpcDelegationPromptInput {
  companyName: string;
  employee: OpcEmployee;
  /** 角色模板正文（内置包或导入模板；自定义员工给 null）。 */
  roleBody: string | null;
  workItem: OpcWorkItem;
  /** 挂接技能正文（最多取前 4 个，超出的只列名）。 */
  skillBodies: Array<{ id: string; name: string; body: string }>;
  skillNamesRemaining: string[];
  /** 该员工最近的私人经验（新→旧，最多 10 条）。 */
  recentLessons: string[];
  memoryFilePath: string;
}

/** agent 复盘输出围栏名：```opc-lessons { "lessons": [...] } */
export const OPC_LESSONS_FENCE = "opc-lessons";
/** agent 技能升级输出围栏名：```opc-skill ...（完整新 SKILL.md 正文） */
export const OPC_SKILL_FENCE = "opc-skill";
