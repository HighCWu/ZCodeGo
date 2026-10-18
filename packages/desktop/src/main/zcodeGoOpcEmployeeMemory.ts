/**
 * zcode-go OPC 员工记忆绑定（desktop main）：把 CLI 记忆管线的工作目录
 * （~/.zcode/cli/memories/projects/project-<hash>）以目录链接绑定到
 * .opc/employees/<id>/ 下的物理存储——CLI 与其抽取/巩固/注入全链零感知，
 * 物理数据随工作区/公司包走（spec「员工持久记忆」）。
 *
 * 链接语义：win32 junction（免特权）/ 其余平台 symlink；路径解析层重定向，
 * 目录内一切读写穿透到 .opc。这里只做纯 fs 副作用，纯计算在 shared 的
 * opc-employee-memory.ts（hash 算法与 CLI project-root.ts 双向同步）。
 */
import { lstat, mkdir, readdir, readlink, readFile, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  opcEmployeeCliMemoryDir,
  opcEmployeeMemoryCliLinkPath,
  opcEmployeeMemoryDir,
  opcEmployeeMemoryIdentity,
} from "@zcode/shared";

export interface OpcEmployeeMemoryLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

/** 创建/校验/修复目录链接（导出供测试：链接语义是该模块的安全关键）。 */
export async function ensureDirLink(linkPath: string, targetDir: string): Promise<void> {
  let existingStat: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existingStat = await lstat(linkPath);
  } catch {
    existingStat = null; // ENOENT → 需要创建
  }
  if (existingStat) {
    if (!existingStat.isSymbolicLink()) {
      throw new Error(`记忆链接路径被非链接实体占用: ${linkPath}`);
    }
    const current = await readlink(linkPath).catch(() => null);
    if (current && resolve(current) === resolve(targetDir)) {
      return; // 已就绪
    }
    // 链接指向漂移（workspace 移动/员工 id 复用）：只删链接本身（rm 对
    // symlink/junction 不跟随），绝不递归删数据。
    await rm(linkPath, { force: true });
  }
  await mkdir(dirname(linkPath), { recursive: true });
  await symlinkDir(targetDir, linkPath);
}

async function symlinkDir(targetDir: string, linkPath: string): Promise<void> {
  // win32 junction 免管理员权限（reparse point）；其余平台原生目录 symlink
  const type = process.platform === "win32" ? "junction" : "dir";
  await mkdir(targetDir, { recursive: true });
  await symlink(targetDir, linkPath, type);
}

/** CLI project-root.ts 同款：sha256(keySource) 前 16 位十六进制。
 * 放在本文件（main）而非 shared：sandbox preload 禁 node 内置模块，
 * shared barrel 被 preload 打包时不能出现 node:crypto。 */
function opcEmployeeMemoryHash(employeeId: string, workspacePath: string): string {
  return createHash("sha256")
    .update(opcEmployeeMemoryIdentity(employeeId, workspacePath))
    .digest("hex")
    .slice(0, 16);
}

/** CLI 数据根：与 buildHostProcessEnv 的 ZCODE_DATA_BASE_DIR 兜底同源——
 * env 重定向（便携/测试形态）时链接源必须跟着走，否则绑定错位。 */
function resolveCliStorageRoot(): string {
  return process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
}

/**
 * 确保单个员工的记忆绑定并返回 MEMORY.md 索引（供编排器注入委派 prompt）。
 * 由 ZcodeGoOpcGetState（既有通道）在 main 内批量调用——不新增 IPC 通道、
 * 不改 preload（bind 全部副作用留在 main）。
 */
export interface OpcEmployeeMemoryEnsureResult {
  memoryIndex: string | null;
  /** persona.md 摘要（前 ~500 字，委派 prompt 的人格注入段） */
  personaDigest: string | null;
  /** 原则文件 name 清单（frontmatter type: principle） */
  principles: string[];
  bound: boolean;
}

export async function ensureOpcEmployeeMemory(
  logger: OpcEmployeeMemoryLogger,
  workspacePath: string,
  employeeId: string,
): Promise<OpcEmployeeMemoryEnsureResult> {
  try {
    const ws = resolve(workspacePath);
    if (!employeeId || /[/\\]/.test(employeeId)) {
      return { memoryIndex: null, bound: false };
    }
    // 链接目标 = 员工目录本体：CLI 记忆根（<link>/memory）穿透后正是
    // .opc/employees/<id>/memory/——注入读取与 CLI 写入同一物理位置。
    const employeeDir = join(ws, ".opc", "employees", employeeId);
    const memoryDir = join(employeeDir, "memory");
    const linkPath = opcEmployeeMemoryCliLinkPath(
      resolveCliStorageRoot(),
      employeeId,
      workspacePath,
      opcEmployeeMemoryHash(employeeId, workspacePath),
    );
    await mkdir(memoryDir, { recursive: true });
    await ensureDirLink(linkPath, employeeDir);
    let memoryIndex: string | null = null;
    try {
      memoryIndex = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    } catch {
      memoryIndex = null; // 新员工无索引，prompt 段走「初期」分支
    }
    let personaDigest: string | null = null;
    try {
      personaDigest = (await readFile(join(memoryDir, "persona.md"), "utf8")).slice(0, 600);
    } catch {
      personaDigest = null; // 无画像文件
    }
    // 原则文件清单：读各 md 的 frontmatter type（principle 为 L2 归纳产物）
    const principles: string[] = [];
    try {
      const files = (await readdir(memoryDir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && f !== "persona.md");
      for (const file of files.slice(0, 200)) {
        try {
          const body = await readFile(join(memoryDir, file), "utf8");
          if (/^---[\s\S]*?type:\s*principle/m.test(body)) {
            const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? file.replace(/\.md$/, "");
            principles.push(name);
          }
        } catch {
          /* 单文件读失败跳过 */
        }
      }
    } catch {
      /* 目录读失败按无原则处理 */
    }
    return { memoryIndex, personaDigest, principles, bound: true };
  } catch (error) {
    logger.warn("[zcode-go] OPC 员工记忆绑定失败", { employeeId, error });
    return { memoryIndex: null, personaDigest: null, principles: [], bound: false };
  }
}

/** 预留：员工记忆目录的明文路径（UI 展示/审计用）。 */
export function opcEmployeeMemoryIndexPath(
  workspacePath: string,
  employeeId: string,
): string {
  return join(opcEmployeeMemoryDir(workspacePath, employeeId), "MEMORY.md");
}
