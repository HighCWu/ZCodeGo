/**
 * zcode-go OPC 模板包同步（dev/打包期从用户 fork 注入的全量模板内容）。
 * 从 zcodeGoOpcStore.ts 拆出以控制文件行数；合并语义（幂等填充）在 shared
 * applyOpcPackFiles，本文件只做目录解析链与落盘。spec「模板包」节。
 */
import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  applyOpcPackFiles,
  OPC_ROLES_TEMPLATES_SUBDIR,
  OPC_SKILLS_DIR,
  OPC_TEMPLATES_DIR,
  type OpcCompanyState,
  type OpcPackManifest,
  type OpcPackSourceFile,
} from "@zcode/shared";

// ---------------------------------------------------------------------------
// 模板包（packs）：dev/打包期注入的全量模板内容，运行时幂等填充
// ---------------------------------------------------------------------------

/**
 * 包目录解析链（spec 第 4 条）：打包 resources/opc-packs → env 覆盖 →
 * dev 的 packages/desktop/build/opc-packs → 用户级缓存 ~/.zcode-go/opc-packs。
 * 取第一个存在的根。
 */
function resolveOpcPacksRoot(): string | null {
  const candidates: string[] = [];
  if (app.isPackaged && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "opc-packs"));
  }
  const envDir = process.env.ZCODE_GO_OPC_PACKS_DIR;
  if (envDir) candidates.push(resolve(envDir));
  try {
    candidates.push(join(app.getAppPath(), "build", "opc-packs"));
  } catch {
    /* app 未就绪等极端场景 */
  }
  candidates.push(join(homedir(), ".zcode-go", "opc-packs"));
  return candidates.find((dir) => dir.length > 0 && existsSync(dir)) ?? null;
}

async function collectPackFiles(
  dir: string,
  prefix: string,
  files: OpcPackSourceFile[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectPackFiles(full, relative, files);
    } else if (
      entry.isFile() &&
      /\.md$/i.test(entry.name) &&
      entry.name !== "pack.json"
    ) {
      files.push({
        relativePath: relative,
        content: await readFile(full, "utf8"),
      });
    }
  }
}

/** 按版本戳幂等同步全部模板包；只创建缺失项（用户改动/晋升产物永不被包覆盖）。 */
export async function syncOpcPacks(
  workspaceRoot: string,
  state: OpcCompanyState,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
): Promise<OpcCompanyState> {
  const packsRoot = resolveOpcPacksRoot();
  if (!packsRoot) return state;
  let current = state;
  let entries;
  try {
    entries = await readdir(packsRoot, { withFileTypes: true });
  } catch {
    return state;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packDir = join(packsRoot, entry.name);
    let manifest: OpcPackManifest;
    try {
      const parsed = JSON.parse(
        await readFile(join(packDir, "pack.json"), "utf8"),
      ) as OpcPackManifest;
      if (
        !parsed?.id ||
        typeof parsed.version !== "string" ||
        parsed.version.length === 0
      ) {
        continue;
      }
      manifest = parsed;
    } catch {
      continue; // 无 pack.json / 戳损坏：不是合法模板包
    }
    if (current.packImports?.[manifest.id] === manifest.version) continue;
    try {
      const files: OpcPackSourceFile[] = [];
      await collectPackFiles(packDir, "", files);
      const outcome = applyOpcPackFiles(current, manifest, files, Date.now());
      current = outcome.state;
      // 待落盘正文：只写缺失文件（与幂等填充语义一致，绝不覆盖已存在内容）
      const templatesDir = join(
        workspaceRoot,
        OPC_TEMPLATES_DIR,
        OPC_ROLES_TEMPLATES_SUBDIR,
      );
      for (const [templateId, markdown] of Object.entries(
        outcome.roleTemplateFiles,
      )) {
        const target = join(templatesDir, `${templateId}.md`);
        if (existsSync(target)) continue;
        await mkdir(templatesDir, { recursive: true });
        await writeFile(target, markdown, "utf8");
      }
      for (const [skillId, body] of Object.entries(outcome.skillBodies)) {
        const target = join(workspaceRoot, OPC_SKILLS_DIR, skillId, "SKILL.md");
        if (existsSync(target)) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body, "utf8");
      }
      logger.info(
        `[zcode-go] OPC 模板包 ${manifest.id}@${manifest.version.slice(0, 8)} 同步：+${outcome.importedRoles} 角色 / +${outcome.importedSkills} 技能`,
      );
    } catch (error) {
      logger.warn(`[zcode-go] OPC 模板包 ${manifest.id} 同步失败`, error);
    }
  }
  return current;
}
