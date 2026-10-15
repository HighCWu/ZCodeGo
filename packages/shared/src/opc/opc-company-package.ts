/**
 * zcode-go OPC 公司包（.opcpkg 对应物，OpenOPC 对齐：整公司可携带）。
 *
 * 导出 = 公司状态 + 技能正文 + 导入模板正文打包成一个 JSON 文档（浏览器侧
 * Blob 下载，不落仓库）；导入 = merge-fill——只创建缺失项（岗位/员工/技能/
 * 模板按 id/name 去重，用户现有状态永不被覆盖），与模板包同语义。
 * 纯函数；文件读写由 UI 完成（renderer Blob/FileReader）。
 */
import { createOpcEntityId } from "./opc-evolution.js";
import type { OpcCompanyState, OpcMutation } from "./opc-types.js";

export const OPC_COMPANY_PACKAGE_KIND = "zcode-go-opc-company";
export const OPC_COMPANY_PACKAGE_SCHEMA_VERSION = 1;

export interface OpcCompanyPackage {
  kind: typeof OPC_COMPANY_PACKAGE_KIND;
  schemaVersion: number;
  exportedAt: string;
  state: OpcCompanyState;
  /** 技能正文（id → SKILL.md 全文），随包携带。 */
  skillBodies: Record<string, string>;
  /** 导入角色模板正文（id → 原始 markdown），随包携带。 */
  roleTemplateBodies: Record<string, string>;
}

export function buildOpcCompanyPackage(input: {
  state: OpcCompanyState;
  skillBodies: Record<string, string>;
  roleTemplateBodies: Record<string, string>;
}): OpcCompanyPackage {
  return {
    kind: OPC_COMPANY_PACKAGE_KIND,
    schemaVersion: OPC_COMPANY_PACKAGE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    state: input.state,
    skillBodies: input.skillBodies,
    roleTemplateBodies: input.roleTemplateBodies,
  };
}

/** 解析公司包文档；kind/schema 校验失败返回 null（不猜）。 */
export function parseOpcCompanyPackage(text: string): OpcCompanyPackage | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.kind !== OPC_COMPANY_PACKAGE_KIND) return null;
    if (record.schemaVersion !== OPC_COMPANY_PACKAGE_SCHEMA_VERSION)
      return null;
    const state = record.state as OpcCompanyState | undefined;
    if (
      typeof state !== "object" ||
      state === null ||
      !Array.isArray(state.employees) ||
      !Array.isArray(state.workItems) ||
      !Array.isArray(state.skills)
    ) {
      return null;
    }
    const skillBodies =
      typeof record.skillBodies === "object" && record.skillBodies !== null
        ? (record.skillBodies as Record<string, string>)
        : {};
    const roleTemplateBodies =
      typeof record.roleTemplateBodies === "object" &&
      record.roleTemplateBodies !== null
        ? (record.roleTemplateBodies as Record<string, string>)
        : {};
    return {
      kind: OPC_COMPANY_PACKAGE_KIND,
      schemaVersion: OPC_COMPANY_PACKAGE_SCHEMA_VERSION,
      exportedAt:
        typeof record.exportedAt === "string" ? record.exportedAt : "",
      state,
      skillBodies,
      roleTemplateBodies,
    };
  } catch {
    return null;
  }
}

export interface OpcCompanyImportOutcome {
  mutations: OpcMutation[];
  /** 正文待落盘由 main 经 skill.import 自带 body 完成；这里仅统计口径。 */
  summary: {
    slots: number;
    hires: number;
    skills: number;
    roleTemplates: number;
    skipped: number;
  };
}

/**
 * 公司包 merge-fill 导入：岗位按标题去重、员工按姓名去重（在职同名跳过）、
 * 技能按 id 去重、导入模板按 id 去重；公司名仅在公司仍为默认名时采用。
 * 技能与模板正文都随包携带：skill.import 的 body 由 main 落 skills/<id>/SKILL.md，
 * template.importRole 的 markdown 由 main 落 templates/roles/<id>.md（Apply 通道
 * 与目录导入同构持久化）。merge-fill：只创建缺失项，不覆盖工作区现状。
 */
export function buildOpcCompanyImportMutations(
  state: OpcCompanyState,
  pkg: OpcCompanyPackage,
  now: number,
): OpcCompanyImportOutcome {
  const mutations: OpcMutation[] = [];
  const summary = {
    slots: 0,
    hires: 0,
    skills: 0,
    roleTemplates: 0,
    skipped: 0,
  };
  const importedState = pkg.state;

  // 公司名：仅当本地仍为默认名时采用包内名
  if (
    importedState.company?.name &&
    state.company.name === "我的 OPC 公司" &&
    importedState.company.name !== state.company.name
  ) {
    mutations.push({
      kind: "company.rename",
      name: importedState.company.name,
    });
  }

  const slotIdByTitle = new Map(
    state.roleSlots.map((slot) => [slot.title, slot.id]),
  );
  for (const slot of importedState.roleSlots ?? []) {
    if (slotIdByTitle.has(slot.title)) continue;
    const id = createOpcEntityId("slot", now);
    slotIdByTitle.set(slot.title, id);
    mutations.push({ kind: "role-slot.create", title: slot.title });
    summary.slots += 1;
  }

  const activeNames = new Set(
    state.employees
      .filter((employee) => employee.status === "active")
      .map((employee) => employee.name),
  );
  for (const employee of importedState.employees ?? []) {
    if (employee.isFallback) continue;
    if (activeNames.has(employee.name) || employee.status === "departed") {
      summary.skipped += 1;
      continue;
    }
    activeNames.add(employee.name);
    mutations.push({
      kind: "employee.hire",
      templateId: employee.templateId || "custom",
      roleId: employee.roleId
        ? (slotIdByTitle.get(
            state.roleSlots.find((slot) => slot.id === employee.roleId)
              ?.title ?? "",
          ) ?? null)
        : null,
      skillRefs: [...(employee.skillRefs ?? [])],
      custom: {
        name: employee.name,
        category: employee.category,
        emoji: employee.emoji,
        color: employee.color,
        vibe: employee.vibe,
        description: employee.description,
        seniority: employee.seniority ?? "junior",
      },
    });
    summary.hires += 1;
  }

  for (const skill of importedState.skills ?? []) {
    if (state.skills.some((existing) => existing.id === skill.id)) {
      summary.skipped += 1;
      continue;
    }
    mutations.push({
      kind: "skill.import",
      skillId: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      body:
        pkg.skillBodies[skill.id] ??
        `# ${skill.name}\n\n${skill.description}\n`,
    });
    summary.skills += 1;
  }

  for (const template of importedState.roleTemplates ?? []) {
    if (state.roleTemplates.some((existing) => existing.id === template.id)) {
      summary.skipped += 1;
      continue;
    }
    const markdown = pkg.roleTemplateBodies[template.id];
    if (!markdown) {
      // 无正文的模板条目照常入清单（人才市场按描述展示），正文缺失仅影响委派注入
      mutations.push({
        kind: "template.importRole",
        markdown: `---\nname: ${template.name}\ndescription: ${template.description}\ncolor: ${template.color}\nemoji: ${template.emoji}\nvibe: ${template.vibe}\n---\n\n${template.description}\n`,
      });
      summary.roleTemplates += 1;
      continue;
    }
    mutations.push({ kind: "template.importRole", markdown });
    summary.roleTemplates += 1;
  }

  return { mutations, summary };
}
