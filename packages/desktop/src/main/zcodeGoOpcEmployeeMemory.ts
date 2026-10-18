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
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

/** CLI project-root.ts 同款：sha256(keySource) 前 16 位十六进制。
 * 放在本文件（main）而非 shared：sandbox preload 禁 node 内置模块，
 * shared barrel 被 preload 打包时不能出现 node:crypto。 */
function opcEmployeeMemoryHash(employeeId: string, workspacePath: string): string {
  return createHash("sha256")
    .update(opcEmployeeMemoryIdentity(employeeId, workspacePath))
    .digest("hex")
    .slice(0, 16);
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
    const ws = resolve(workspacePath);
    if (!employeeId || /[/\\]/.test(employeeId)) {
      return FAILED_ENSURE;
    }
    // 员工 data dir 沙箱（与 services resolveSpawnEnv 同一解析，路径单一来源）：
    // CLI 记忆根直接在员工 .zcode 内，无需 ~/.zcode 侧链接。
    const sandbox = resolveOpcEmployeeSandbox(ws, opcEmployeeMemoryIdentity(employeeId, ws));
    if (!sandbox) {
      return FAILED_ENSURE;
    }
    const memoryDir = opcEmployeeSandboxMemoryRoot(
      sandbox.employeeDir,
      opcEmployeeMemoryHash(employeeId, ws),
    );
    await mkdir(memoryDir, { recursive: true });
    await migrateLegacyMemoryDir(join(ws, ".opc", "employees", employeeId, "memory"), memoryDir);
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

/** 员工记忆索引文件的明文路径（UI 展示/审计用）。 */
export function opcEmployeeMemoryIndexPath(
  workspacePath: string,
  employeeId: string,
): string {
  const ws = resolve(workspacePath);
  const sandbox = resolveOpcEmployeeSandbox(ws, opcEmployeeMemoryIdentity(employeeId, ws));
  if (!sandbox) return join(ws, ".opc", "employees", employeeId, "memory", "MEMORY.md");
  return join(
    opcEmployeeSandboxMemoryRoot(sandbox.employeeDir, opcEmployeeMemoryHash(employeeId, ws)),
    "MEMORY.md",
  );
}
