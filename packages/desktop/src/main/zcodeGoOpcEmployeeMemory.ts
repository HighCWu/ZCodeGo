/**
 * zcode-go OPC 员工记忆绑定（desktop main）：员工会话的 agent data 根由
 * services resolveSpawnEnv 按 identity 路由到 <workspace>/.opc/employees/<id>/
 * （ZCODE_DATA_BASE_DIR），CLI 记忆管线因此把记忆根直接落在
 * .opc/employees/<id>/.zcode/cli/memories/projects/project-<hash>/memory。
 * 本模块在该路径上做 ensure（建目录/迁移旧数据）与回读（MEMORY.md 索引、
 * persona 摘要、原则清单），供编排器注入委派 prompt（spec「员工持久记忆」）。
 *
 * 纯 fs 副作用留在 main；纯计算（路径/键/规则/prompt 段）在 shared 的
 * opc-employee-memory.ts（hash 算法与 CLI project-root.ts 双向同步）。
 */
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import {
  opcEmployeeMemoryIdentity,
  opcEmployeeSandboxMemoryRoot,
  resolveOpcEmployeeSandbox,
} from "@zcode/shared";

export interface OpcEmployeeMemoryLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

/** CLI resolveProjectMemoryRoot 同款的记忆根目录名（无 identity 输入分支）：
 * v4 子进程的 runtime 不携带员工 identity（v4 workspaceId 必须为可执行真实
 * 路径，见 adapter createSession），记忆根按「路径键」解析——slug=工作区目录
 * 名（≤48 截断，fallback project）、hash=sha256(绝对路径，win32 小写)[:16]。
 * 员工间隔离由每员工独立 storage root（env 三键路由）物理保证。 */
function opcEmployeeMemoryProjectDir(workspacePath: string): string {
  const normalized = resolve(workspacePath);
  const keySource =
    process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const hash = createHash("sha256")
    .update(keySource)
    .digest("hex")
    .slice(0, 16);
  const slug =
    basename(normalized)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project";
  return `${slug}-${hash}`;
}

/** symlink 时代遗留（identity 键哈希）的记忆根目录名——迁移源之一。 */
function legacyIdentityMemoryProjectDir(employeeId: string, workspacePath: string): string {
  const hash = createHash("sha256")
    .update(opcEmployeeMemoryIdentity(employeeId, resolve(workspacePath)))
    .digest("hex")
    .slice(0, 16);
  return `project-${hash}`;
}

/**
 * 确保单个员工的记忆目录就绪并返回 MEMORY.md 索引（供编排器注入委派 prompt）。
 * 由 ZcodeGoOpcGetState（既有通道）在 main 内批量调用——不新增 IPC 通道、
 * 不改 preload（全部副作用留在 main）。
 */
export interface OpcEmployeeMemoryEnsureResult {
  memoryIndex: string | null;
  /** persona.md 摘要（前 ~500 字，委派 prompt 的人格注入段） */
  personaDigest: string | null;
  /** 原则文件 name 清单（frontmatter type: principle） */
  principles: string[];
  /** 员工记忆根相对 workspace 的显示路径（委派 prompt 的写入指引） */
  memoryDirDisplay: string | null;
  bound: boolean;
}

const FAILED_ENSURE: OpcEmployeeMemoryEnsureResult = {
  memoryIndex: null,
  personaDigest: null,
  principles: [],
  memoryDirDisplay: null,
  bound: false,
};

export async function ensureOpcEmployeeMemory(
  logger: OpcEmployeeMemoryLogger,
  workspacePath: string,
  employeeId: string,
): Promise<OpcEmployeeMemoryEnsureResult> {
  try {
    // 用与 services/ui 完全同一份原始字符串（identity 内嵌 ws 的三方一致性
    // 优先于本地规整化：resolve() 在非规整输入上会算出不同的记忆 hash，
    // 造成 main 回读与 CLI 写入落到两个 project 目录）。仅要求绝对路径。
    const ws = workspacePath;
    if (!employeeId || /[/\\]/.test(employeeId) || !isAbsolute(ws)) {
      return FAILED_ENSURE;
    }
    // 员工 data dir 沙箱（与 services resolveSpawnEnv 同一解析，路径单一来源）：
    // CLI 记忆根直接在员工 .zcode 内，无需 ~/.zcode 侧链接。
    const sandbox = resolveOpcEmployeeSandbox(ws, opcEmployeeMemoryIdentity(employeeId, ws));
    if (!sandbox) {
      return FAILED_ENSURE;
    }
    const projectsDir = join(sandbox.employeeDir, ".zcode", "cli", "memories", "projects");
    const memoryDir = opcEmployeeSandboxMemoryRoot(
      sandbox.employeeDir,
      opcEmployeeMemoryProjectDir(ws),
    );
    await mkdir(memoryDir, { recursive: true });
    await migrateLegacyMemoryDir(join(ws, ".opc", "employees", employeeId, "memory"), memoryDir);
    // symlink 时代 identity 键哈希根（project-<sha256(identity)>）一并迁移。
    await migrateLegacyMemoryDir(
      join(projectsDir, legacyIdentityMemoryProjectDir(employeeId, ws)),
      memoryDir,
    );
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
      const files = (await readdir(memoryDir)).filter(
        (f) => f.endsWith(".md") && f !== "MEMORY.md" && f !== "persona.md",
      );
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
    return {
      memoryIndex,
      personaDigest,
      principles,
      memoryDirDisplay: memoryDir.startsWith(`${ws}/`) ? memoryDir.slice(ws.length + 1) : memoryDir,
      bound: true,
    };
  } catch (error) {
    logger.warn("[zcode-go] OPC 员工记忆绑定失败", { employeeId, error });
    return FAILED_ENSURE;
  }
}

/**
 * 一次性迁移：symlink 绑定时代的 .opc/employees/<id>/memory 旧数据 →
 * data dir 内的 CLI 记忆根。仅在新记忆根为空时执行（CLI 已写过内容则绝不
 * 覆盖）；旧目录保留不删（废弃现场可人工处置），失败不阻塞绑定。
 */
async function migrateLegacyMemoryDir(legacyDir: string, memoryDir: string): Promise<void> {
  try {
    const legacyFiles = await readdir(legacyDir).catch(() => null);
    if (!legacyFiles || legacyFiles.length === 0) return;
    const existing = await readdir(memoryDir);
    if (existing.length > 0) return;
    await cp(legacyDir, memoryDir, { recursive: true });
  } catch {
    /* 迁移失败不阻塞：记忆内容可由后续任务重建 */
  }
}

/**
 * 管理者重置员工人格画像（spec「人格画像」）：删除记忆根下的 persona.md
 * （记忆事实文件保留）。persona 缺失本就是合法态（新员工无画像），删除
 * 后 GetState 回读 personaDigest 自然回到 null，委派 prompt 不再注入画像。
 */
export async function resetOpcEmployeePersona(
  workspacePath: string,
  employeeId: string,
): Promise<boolean> {
  try {
    const ws = workspacePath;
    if (!employeeId || /[/\\]/.test(employeeId) || !isAbsolute(ws)) {
      return false;
    }
    const sandbox = resolveOpcEmployeeSandbox(ws, opcEmployeeMemoryIdentity(employeeId, ws));
    if (!sandbox) return false;
    const personaPath = join(
      opcEmployeeSandboxMemoryRoot(sandbox.employeeDir, opcEmployeeMemoryProjectDir(ws)),
      "persona.md",
    );
    await rm(personaPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 员工记忆索引文件的明文路径（UI 展示/审计用）。 */
export function opcEmployeeMemoryIndexPath(
  workspacePath: string,
  employeeId: string,
): string {
  const ws = workspacePath;
  const sandbox = resolveOpcEmployeeSandbox(ws, opcEmployeeMemoryIdentity(employeeId, ws));
  if (!sandbox || !isAbsolute(ws)) {
    return join(ws, ".opc", "employees", employeeId, "memory", "MEMORY.md");
  }
  return join(
    opcEmployeeSandboxMemoryRoot(sandbox.employeeDir, opcEmployeeMemoryProjectDir(ws)),
    "MEMORY.md",
  );
}
