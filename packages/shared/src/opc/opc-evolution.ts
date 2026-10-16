/**
 * zcode-go OPC 自进化引擎（RSI 闭环的确定性部分，纯函数）。
 *
 * 吸收 OpenOPC 的 Self-Grown 语义：经验归因到角色 → 蒸馏为私人记忆 →
 * 同一指纹的经验在 ≥2 次独立复盘中重复出现 → 自动晋升为共享 playbook 技能并
 * 挂接到员工；此后每次再确认版本 +1 追加 changelog。晋升判定与技能文件内容
 * 渲染都在这里，main 只负责落盘。
 */
import type {
  OpcCompanyState,
  OpcEmployee,
  OpcEvolutionEvent,
  OpcLesson,
} from "./opc-types.js";
import { opcSlugify } from "./opc-template-format.js";

/** 归一化经验指纹：小写、去标点、压空白；tag 参与指纹（同句不同 tag 视为不同侧重）。 */
export function normalizeOpcStatementKey(
  statement: string,
  tags: string[],
): string {
  const normalizedStatement = statement
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, "")
    .slice(0, 200);
  const normalizedTags = tags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0)
    .sort()
    .join("|");
  return normalizedTags.length > 0
    ? `${normalizedStatement}#${normalizedTags}`
    : normalizedStatement;
}

/** 晋升技能 id：playbook-<statement 摘要 slug>。 */
export function promotionSkillId(statementKey: string): string {
  const slug =
    opcSlugify(statementKey.split("#")[0] ?? "").slice(0, 40) || "lesson";
  return `playbook-${slug}`;
}

export interface OpcPromotionOutcome {
  state: OpcCompanyState;
  events: OpcEvolutionEvent[];
  promotedSkillIds: string[];
}

let opcEntitySeq = 0;

/** 实体 id（经验/事件）：时间前缀 + 序号，可读且碰撞安全。 */
export function createOpcEntityId(prefix: string, now: number): string {
  opcEntitySeq += 1;
  return `${prefix}_${now.toString(36)}${(opcEntitySeq % 1296).toString(36).padStart(2, "0")}`;
}

/**
 * 记录一次复盘：追加经验、更新员工统计。
 * 返回新 state（不可变副本）；晋升评估由调用方继续调用 evaluateOpcPromotions。
 */
export function recordOpcRetro(
  state: OpcCompanyState,
  input: {
    employeeId: string;
    workItemId: string | null;
    lessons: Array<{ statement: string; tags: string[] }>;
    note?: string;
    now: number;
  },
): {
  state: OpcCompanyState;
  lessons: OpcLesson[];
  events: OpcEvolutionEvent[];
} {
  const employee = state.employees.find((item) => item.id === input.employeeId);
  if (!employee || input.lessons.length === 0) {
    return { state, lessons: [], events: [] };
  }
  const retroId = createOpcEntityId("retro", input.now);
  const created: OpcLesson[] = input.lessons.map((lesson) => ({
    id: createOpcEntityId("lesson", input.now),
    employeeId: input.employeeId,
    workItemId: input.workItemId ?? null,
    statement: lesson.statement,
    tags: lesson.tags,
    statementKey: normalizeOpcStatementKey(lesson.statement, lesson.tags),
    retroId,
    createdAt: input.now,
  }));
  const evolution: OpcEvolutionEvent[] = [
    {
      id: createOpcEntityId("ev", input.now),
      at: input.now,
      kind: "retro",
      summary: `${employee.name} 复盘：沉淀 ${created.length} 条经验${
        input.note ? `（${input.note}）` : ""
      }`,
    },
  ];
  const nextState: OpcCompanyState = {
    ...state,
    lessons: [...state.lessons, ...created],
    employees: state.employees.map((item) =>
      item.id === input.employeeId
        ? {
            ...item,
            stats: {
              ...item.stats,
              retrospectives: item.stats.retrospectives + 1,
              lessons: item.stats.lessons + created.length,
            },
          }
        : item,
    ),
    evolution: [...state.evolution, ...evolution],
  };
  return { state: nextState, lessons: created, events: evolution };
}

/**
 * 晋升评估：按指纹统计「独立复盘批次」数（retroId 去重；同一次复盘产出多条
 * 同指纹经验只算一次）。达到 2 → 创建 promoted 技能 + 挂接员工 + evolution 事件；
 * 已晋升且再确认 → 版本 +1 + changelog（同一评估轮内同一技能只升一次版）。
 */
export function evaluateOpcPromotions(
  state: OpcCompanyState,
  now: number,
): OpcPromotionOutcome {
  const batchesByFingerprint = new Map<string, Set<string>>();
  for (const lesson of state.lessons) {
    const batches =
      batchesByFingerprint.get(lesson.statementKey) ?? new Set<string>();
    batches.add(lesson.retroId);
    batchesByFingerprint.set(lesson.statementKey, batches);
  }
  const PROMOTION_THRESHOLD = 2;

  const promotedSkillIds: string[] = [];
  const events: OpcEvolutionEvent[] = [];
  let skills = [...state.skills];
  let employees = [...state.employees];

  for (const [statementKey, batches] of batchesByFingerprint) {
    if (batches.size < PROMOTION_THRESHOLD) continue;
    const sample = state.lessons.find(
      (lesson) => lesson.statementKey === statementKey,
    );
    if (!sample) continue;
    const employee = state.employees.find(
      (item) => item.id === sample.employeeId,
    );
    if (!employee) continue;
    const skillId = promotionSkillId(statementKey);
    // 用户显式删除过的晋升技能不再重建（tombstone；新证据需重新导入）。
    if (state.promotedSkillTombstones?.includes(skillId)) continue;
    const existingIndex = skills.findIndex((skill) => skill.id === skillId);
    if (existingIndex < 0) {
      skills = [
        ...skills,
        {
          id: skillId,
          name: `Playbook：${sample.statement.slice(0, 40)}`,
          description: `由 ${employee.name} 的重复经验自动晋升（指纹 ${statementKey.slice(0, 24)}…）。`,
          category: employee.category,
          version: 1,
          origin: "promoted",
          promotedFromEmployeeId: employee.id,
          changelog: [
            `v1 ${formatOpcDate(now)}：经验在 ${batches.size} 次复盘中重复出现，自动晋升为共享 playbook。`,
          ],
          updatedAt: now,
        },
      ];
      promotedSkillIds.push(skillId);
      events.push({
        id: createOpcEntityId("ev", now),
        at: now,
        kind: "promote",
        summary: `${employee.name} 的重复经验晋升为技能 ${skillId}（v1）`,
      });
    } else {
      const existing = skills[existingIndex];
      if (!existing) continue;
      // 版本目标制：每多一个含本指纹的独立复盘批次 → 版本 +1（v1 对应
      // 达阈值的 2 个批次，故目标 = batches.size - 1）。此前用「changelog
      // 是否已有 v(n+1) 行」判重——批次不增长的无关复盘会永远放行，版本
      // 无限膨胀并伪造「经验再次被复盘确认」changelog（CI 复核实证）。
      const targetVersion = Math.max(1, batches.size - 1);
      if (existing.version >= targetVersion) continue;
      const batchStamp = `v${targetVersion}`;
      skills[existingIndex] = {
        ...existing,
        version: targetVersion,
        changelog: [
          ...existing.changelog,
          `${batchStamp} ${formatOpcDate(now)}：经验再次被复盘确认，版本升级。`,
        ],
        updatedAt: now,
      };
      events.push({
        id: createOpcEntityId("ev", now),
        at: now,
        kind: "promote",
        summary: `技能 ${skillId} 因经验再确认升级到 v${existing.version + 1}`,
      });
    }
    // 自动挂接到来源员工
    employees = employees.map((item) =>
      item.id === employee.id && !item.skillRefs.includes(skillId)
        ? { ...item, skillRefs: [...item.skillRefs, skillId] }
        : item,
    );
  }

  if (promotedSkillIds.length === 0 && events.length === 0) {
    return { state, events, promotedSkillIds };
  }
  return {
    state: {
      ...state,
      skills,
      employees,
      evolution: [...state.evolution, ...events],
    },
    events,
    promotedSkillIds,
  };
}

/** 员工私人记忆文件内容（memory/<employeeId>.md，全量重写；追加式语义由调用方保留历史）。 */
export function renderOpcEmployeeMemory(
  employee: OpcEmployee,
  lessons: OpcLesson[],
  generatedAt: number,
): string {
  const header = [
    `# ${employee.name} 的私人经验档案`,
    "",
    `- 岗位：${employee.category}（${employee.seniority}）`,
    `- 更新时间：${formatOpcDate(generatedAt)}`,
    `- 经验条目：${lessons.length}`,
    "",
    "> 本文件由 OPC 进化引擎维护：每次复盘追加新经验；重复经验会自动晋升为共享 playbook 技能。",
    "> 委派执行前请先读本文件，遵循已沉淀的经验教训。",
    "",
  ];
  const items = [...lessons]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((lesson) => {
      const tags = lesson.tags.length > 0 ? ` [${lesson.tags.join(", ")}]` : "";
      return `- ${formatOpcDate(lesson.createdAt)} ${lesson.statement}${tags}`;
    });
  return [...header, ...items, ""].join("\n");
}

/** 晋升/导入技能的 SKILL.md 正文包装（frontmatter + 正文 + changelog）。 */
export function renderOpcSkillFile(input: {
  id: string;
  name: string;
  description: string;
  category: string;
  version: number;
  changelog: string[];
  body: string;
}): string {
  const frontmatter = [
    "---",
    `name: ${input.name}`,
    `description: ${input.description.replace(/\n/g, " ")}`,
    `category: ${input.category}`,
    "metadata:",
    `  version: ${input.version}`,
    "  origin: opc",
    "---",
    "",
  ];
  const changelog =
    input.changelog.length > 0
      ? ["## 版本记录", "", ...input.changelog.map((line) => `- ${line}`), ""]
      : [];
  return [...frontmatter, input.body.trimEnd(), "", ...changelog].join("\n");
}

function formatOpcDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
