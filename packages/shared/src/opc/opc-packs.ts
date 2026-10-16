/**
 * zcode-go OPC 模板包（packs）合并纯函数。
 *
 * packs = dev/打包期从用户 fork（HighCWu/OpenOPC、HighCWu/claude-skills）拉取的
 * 全量模板内容（spec「模板包」节）。合并语义是**幂等填充**：只创建缺失项，
 * 已存在（含用户改过/晋升过的）一律跳过——包更新不覆盖工作区、不递增版本、
 * 不刷 changelog。main 负责读目录/写文件，这里只吃虚拟文件集，可完整单测。
 */
import {
  parseOpcRoleTemplate,
  parseOpcSkillMarkdown,
} from "./opc-template-format.js";
import type { OpcCompanyState, OpcEvolutionEvent } from "./opc-types.js";

export interface OpcPackSourceFile {
  /**
   * 包内相对路径（/ 分隔）。判定顺序：SKILL.md 结尾 → 技能；其余 .md →
   * 角色模板；再其余文件若位于某技能目录内 → 该技能的随包资产（scripts/
   * references/assets 等，SKILL.md 以相对路径引用它们，不随包则技能不可用）。
   */
  relativePath: string;
  content: string;
}

export interface OpcPackManifest {
  /** 包标识（目录名）：openopc / claude-skills。 */
  id: string;
  /** 版本戳（commit sha 短串）：与 company.json.packImports[id] 比对。 */
  version: string;
  repo?: string;
  ref?: string;
}

export interface OpcPackApplyOutcome {
  state: OpcCompanyState;
  events: OpcEvolutionEvent[];
  /** 新建技能的待落盘正文（id → SKILL.md 全文）。 */
  skillBodies: Record<string, string>;
  /** 新建角色模板的待落盘正文（id → 原始 markdown，写 templates/roles/<id>.md）。 */
  roleTemplateFiles: Record<string, string>;
  /**
   * 技能随包资产（`<skillId>/<相对技能目录路径>` → 文本内容）。仅收录新建
   * 技能的资产——已存在技能的资产跳过（幂等，不覆盖用户改动）。
   */
  skillAssets: Record<string, string>;
  importedSkills: number;
  importedRoles: number;
}

export function applyOpcPackFiles(
  state: OpcCompanyState,
  manifest: OpcPackManifest,
  files: OpcPackSourceFile[],
  now: number,
): OpcPackApplyOutcome {
  const knownSkillIds = new Set(state.skills.map((skill) => skill.id));
  // 包同步前的技能快照：资产排除判定用它——主循环里 knownSkillIds 会把
  // 本包新建的技能也加进去，若用它会误跳新技能自己的随包资产
  const preExistingSkillIds = new Set(state.skills.map((skill) => skill.id));
  const knownRoleIds = new Set(
    state.roleTemplates.map((template) => template.id),
  );
  const skills = [...state.skills];
  const roleTemplates = [...state.roleTemplates];
  const skillBodies: Record<string, string> = {};
  const skillAssets: Record<string, string> = {};
  const roleTemplateFiles: Record<string, string> = {};
  const events: OpcEvolutionEvent[] = [];
  let importedSkills = 0;
  let importedRoles = 0;

  // 预扫描：SKILL.md 所在目录 → 技能 id（随包资产按最长祖先目录归属）。
  // slug 净化与主循环一致（parseOpcSkillMarkdown 内部用 opcStableId）。
  const skillDirToId = new Map<string, string>();
  for (const file of files) {
    const normalizedPath = file.relativePath.split("\\").join("/");
    if (!/SKILL\.md$/i.test(normalizedPath)) continue;
    const draft = parseOpcSkillMarkdown(file.content, {
      fallbackName: normalizedPath.split("/").slice(-2)[0],
    });
    if (!draft) continue;
    skillDirToId.set(
      normalizedPath.split("/").slice(0, -1).join("/"),
      draft.id,
    );
  }
  for (const file of files) {
    const normalizedPath = file.relativePath.split("\\").join("/");
    // 技能随包资产判定先行于 .md 模板分支：技能目录内的 references/*.md
    // 是资产而非角色模板（parseOpcRoleTemplate 解析失败也不该被静默吞掉）
    const assetOwnerDir = (() => {
      const dir = normalizedPath.split("/").slice(0, -1).join("/");
      if (/SKILL\.md$/i.test(normalizedPath)) return null;
      const parts = dir.split("/");
      for (let i = parts.length; i >= 1; i -= 1) {
        if (skillDirToId.has(parts.slice(0, i).join("/"))) {
          return {
            dir,
            skillDir: parts.slice(0, i).join("/"),
            id: skillDirToId.get(parts.slice(0, i).join("/"))!,
          };
        }
      }
      return null;
    })();
    try {
      if (/SKILL\.md$/i.test(normalizedPath)) {
        const draft = parseOpcSkillMarkdown(file.content, {
          fallbackName: normalizedPath.split("/").slice(-2)[0],
        });
        // 无名/无描述的 SKILL.md 跳过（claude-skills 里偶有占位文件）
        if (!draft || knownSkillIds.has(draft.id)) continue;
        knownSkillIds.add(draft.id);
        skills.push({
          id: draft.id,
          name: draft.name,
          description: draft.description,
          category: draft.category,
          version: 1,
          origin: "imported",
          changelog: [
            `v1：来自模板包 ${manifest.id}@${manifest.version.slice(0, 8)}`,
          ],
          updatedAt: now,
        });
        skillBodies[draft.id] = file.content;
        importedSkills += 1;
      } else if (!assetOwnerDir && /\.md$/i.test(normalizedPath)) {
        // 非 SKILL.md、非技能资产的 .md → 角色模板（README 等散文件解析不
        // 出五字段模板自然跳过）
        const draft = parseOpcRoleTemplate(file.content);
        // OpenOPC talent 判据：五字段 frontmatter 至少 name + description；README 等跳过
        if (!draft || !draft.description || knownRoleIds.has(draft.id))
          continue;
        knownRoleIds.add(draft.id);
        roleTemplates.push({
          id: draft.id,
          name: draft.name,
          description: draft.description,
          color: draft.color,
          emoji: draft.emoji,
          vibe: draft.vibe,
          category: draft.category,
          origin: "imported",
          importedAt: now,
        });
        roleTemplateFiles[draft.id] = file.content;
        importedRoles += 1;
      } else if (assetOwnerDir) {
        // 技能随包资产：scripts/references/assets 等 SKILL.md 相对引用的文本
        // 文件。已存在技能（preExistingSkillIds）不收——幂等语义与正文一致。
        if (preExistingSkillIds.has(assetOwnerDir.id)) continue;
        const rest = normalizedPath.slice(assetOwnerDir.skillDir.length + 1);
        skillAssets[`${assetOwnerDir.id}/${rest}`] = file.content;
      }
    } catch {
      /* 单文件损坏不中断整包同步 */
    }
  }

  if (importedSkills === 0 && importedRoles === 0) {
    // 没有新内容也盖戳：避免每次读写都重扫整包
    const packImports = {
      ...state.packImports,
      [manifest.id]: manifest.version,
    };
    return {
      state: { ...state, packImports },
      events: [],
      skillBodies,
      skillAssets,
      roleTemplateFiles,
      importedSkills: 0,
      importedRoles: 0,
    };
  }

  events.push({
    id: `ev_pack_${manifest.id}_${now.toString(36)}`,
    at: now,
    kind: "template-import",
    summary: `模板包 ${manifest.id}@${manifest.version.slice(0, 8)} 同步：+${importedRoles} 角色 / +${importedSkills} 技能`,
  });

  return {
    state: {
      ...state,
      skills,
      roleTemplates,
      packImports: {
        ...state.packImports,
        [manifest.id]: manifest.version,
      },
      evolution: [...state.evolution, ...events],
    },
    events,
    skillBodies,
    skillAssets,
    roleTemplateFiles,
    importedSkills,
    importedRoles,
  };
}
