/**
 * zcode-go OPC 文件助手：技能正文来源解析、目录扫描、技能正文落盘、
 * prompt 正文映射读取。从 zcodeGoOpcStore.ts 拆出以控制文件行数。
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  OPC_BUILTIN_SKILL_DRAFTS,
  OPC_ROLES_TEMPLATES_SUBDIR,
  OPC_SKILLS_DIR,
  OPC_TEMPLATES_DIR,
  parseOpcRoleTemplate,
  parseOpcSkillMarkdown,
  type OpcCompanyState,
  type OpcMutation,
  type OpcSkillMeta,
} from "@zcode/shared";

/** 技能正文来源：晋升技能按指纹渲染 playbook 正文；其余用内置包或占位。 */
export function resolveSkillBodySource(meta: OpcSkillMeta): string {
  if (meta.origin === "promoted") {
    const statement = meta.name.replace(/^Playbook：/, "");
    return [
      `# ${meta.name}`,
      "",
      "> 本 playbook 由复盘经验自动晋升生成（来源员工档案见 .opc/memory/）。",
      "",
      "## 适用场景",
      "",
      `- ${meta.description}`,
      "",
      "## 核心经验",
      "",
      `- ${statement}`,
      "",
      "## 执行约定",
      "",
      "- 在同类任务开始前主动应用本经验；",
      "- 若经验与新环境冲突，以当前任务验收标准优先，并在复盘时提出修订。",
      "",
    ].join("\n");
  }
  const builtin = OPC_BUILTIN_SKILL_DRAFTS.find(
    (draft) => draft.id === meta.id,
  );
  return builtin?.body ?? `# ${meta.name}\n\n${meta.description}\n`;
}
// ---------------------------------------------------------------------------
// 目录扫描（导入用）
// ---------------------------------------------------------------------------

export async function listMarkdownFiles(sourcePath: string): Promise<string[]> {
  const abs = resolve(sourcePath);
  const entries = await readdir(abs, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(abs, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(full)));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}
/**
 * 技能正文落盘：skill.import / skill.upgrade 携带的新正文写入 skills/<id>/SKILL.md
 * （版本覆盖语义：文件即正文，company.json 只存元数据）。缺失正文时保留现状。
 */
export async function persistSkillBodies(
  workspaceRoot: string,
  mutations: OpcMutation[],
): Promise<void> {
  for (const mutation of mutations) {
    if (mutation.kind !== "skill.import" && mutation.kind !== "skill.upgrade")
      continue;
    const skillId = mutation.skillId;
    if (!skillId) continue;
    const skillDir = join(workspaceRoot, OPC_SKILLS_DIR, skillId);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), mutation.body, "utf8");
  }
}
/** 读取 prompt 构造所需的正文映射（导入角色模板 + 技能正文）。 */
export async function readBodies(
  workspaceRoot: string,
  state: OpcCompanyState,
): Promise<{
  roleTemplateBodies: Record<string, string>;
  skillBodies: Record<string, string>;
}> {
  const roleTemplateBodies: Record<string, string> = {};
  for (const template of state.roleTemplates) {
    try {
      roleTemplateBodies[template.id] = await readFile(
        join(
          workspaceRoot,
          OPC_TEMPLATES_DIR,
          OPC_ROLES_TEMPLATES_SUBDIR,
          `${template.id}.md`,
        ),
        "utf8",
      );
    } catch {
      /* 正文缺失时 UI 回退内置包或描述 */
    }
  }
  const skillBodies: Record<string, string> = {};
  for (const skill of state.skills) {
    try {
      const raw = await readFile(
        join(workspaceRoot, OPC_SKILLS_DIR, skill.id, "SKILL.md"),
        "utf8",
      );
      const parsed = parseOpcSkillMarkdown(raw, { fallbackName: skill.name });
      skillBodies[skill.id] = parsed?.body ?? raw;
    } catch {
      /* 正文缺失时 UI 回退描述 */
    }
  }
  return { roleTemplateBodies, skillBodies };
}

/**
 * 角色模板正文落盘：template.importRole 携带的 markdown 写入
 * templates/roles/<id>.md（公司包导入与目录导入共用；正文即模板事实源）。
 */
export async function persistRoleTemplateBodies(
  workspaceRoot: string,
  mutations: OpcMutation[],
): Promise<void> {
  for (const mutation of mutations) {
    if (mutation.kind !== "template.importRole") continue;
    const parsed = parseOpcRoleTemplate(mutation.markdown);
    if (!parsed) continue;
    const templatesDir = join(workspaceRoot, OPC_TEMPLATES_DIR, OPC_ROLES_TEMPLATES_SUBDIR);
    await mkdir(templatesDir, { recursive: true });
    await writeFile(join(templatesDir, `${parsed.id}.md`), mutation.markdown, "utf8");
  }
}
