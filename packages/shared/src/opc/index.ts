/**
 * zcode-go OPC 模块公共入口（纯逻辑层）。
 * desktop main（持久化/IPC）与 packages/ui（展示/prompt 构造）都从这里取契约，
 * 两侧永远共享同一套状态机与进化语义。
 */
export * from "./opc-types.js";
export * from "./opc-template-format.js";
export * from "./opc-evolution.js";
export * from "./opc-reducer.js";
export * from "./opc-prompts.js";
export * from "./opc-packs.js";
export * from "./opc-org.js";
export { OPC_BUILTIN_ROLE_TEMPLATES } from "./opc-builtin-roles.js";
export type { OpcBuiltinRoleTemplate } from "./opc-builtin-roles.js";
export { OPC_BUILTIN_SKILLS } from "./opc-builtin-skills.js";
export type { OpcBuiltinSkill } from "./opc-builtin-skills.js";

import {
  parseOpcRoleTemplate,
  parseOpcSkillMarkdown,
} from "./opc-template-format.js";
import { OPC_BUILTIN_ROLE_TEMPLATES } from "./opc-builtin-roles.js";
import { OPC_BUILTIN_SKILLS } from "./opc-builtin-skills.js";
import type { OpcRoleTemplateDraft, OpcSkillDraft } from "./opc-types.js";

/** 内置角色模板解析产物（模块加载期解析一次；五字段来自各模板 frontmatter）。 */
export const OPC_BUILTIN_ROLE_DRAFTS: OpcRoleTemplateDraft[] =
  OPC_BUILTIN_ROLE_TEMPLATES.map((template) => {
    const draft = parseOpcRoleTemplate(template.markdown);
    if (!draft)
      throw new Error(`[zcode-go] 内置角色模板解析失败：${template.name}`);
    return draft;
  });

export function findOpcBuiltinRoleDraft(
  id: string,
): OpcRoleTemplateDraft | null {
  return OPC_BUILTIN_ROLE_DRAFTS.find((draft) => draft.id === id) ?? null;
}

/** 内置技能解析产物（body 为去掉 frontmatter 的正文）。 */
export const OPC_BUILTIN_SKILL_DRAFTS: OpcSkillDraft[] = OPC_BUILTIN_SKILLS.map(
  (skillPackage) => {
    const draft = parseOpcSkillMarkdown(skillPackage.markdown);
    if (!draft)
      throw new Error(`[zcode-go] 内置技能解析失败：${skillPackage.name}`);
    return draft;
  },
);

export function findOpcBuiltinSkillDraft(id: string): OpcSkillDraft | null {
  return OPC_BUILTIN_SKILL_DRAFTS.find((draft) => draft.id === id) ?? null;
}
