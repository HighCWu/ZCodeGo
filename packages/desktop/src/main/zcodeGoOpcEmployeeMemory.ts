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
import { ipcMain } from "electron";
import { lstat, mkdir, readlink, readFile, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  PlatformChannels,
  opcEmployeeCliMemoryDir,
  opcEmployeeMemoryCliLinkPath,
  opcEmployeeMemoryDir,
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

/** CLI 数据根：与 buildHostProcessEnv 的 ZCODE_DATA_BASE_DIR 兜底同源——
 * env 重定向（便携/测试形态）时链接源必须跟着走，否则绑定错位。 */
function resolveCliStorageRoot(): string {
  return process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
}

export function registerZcodeGoOpcEmployeeMemoryIpc(logger: OpcEmployeeMemoryLogger): void {
  ipcMain.removeHandler(PlatformChannels.ZcodeGoOpcEnsureEmployeeMemory);
  ipcMain.handle(
    PlatformChannels.ZcodeGoOpcEnsureEmployeeMemory,
    async (
      _event,
      payload: { workspacePath: string; employeeId: string },
    ): Promise<{ ok: boolean; memoryIndex: string | null; linked: boolean; error?: string }> => {
      try {
        const workspacePath = resolve(payload.workspacePath);
        if (!payload.employeeId || /[/\\]/.test(payload.employeeId)) {
          return { ok: false, memoryIndex: null, linked: false, error: "bad employeeId" };
        }
        const memoryDir = opcEmployeeMemoryDir(workspacePath, payload.employeeId);
        const cliMemoryDir = opcEmployeeCliMemoryDir(workspacePath, payload.employeeId);
        const linkPath = opcEmployeeMemoryCliLinkPath(resolveCliStorageRoot(), payload.employeeId, workspacePath);
        await mkdir(memoryDir, { recursive: true });
        await ensureDirLink(linkPath, cliMemoryDir);
        let memoryIndex: string | null = null;
        try {
          memoryIndex = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
        } catch {
          memoryIndex = null; // 新员工无索引，prompt 段走「初期」分支
        }
        logger.info("[zcode-go] OPC 员工记忆绑定就绪", {
          employeeId: payload.employeeId,
          linkPath,
        });
        return { ok: true, memoryIndex, linked: true };
      } catch (error) {
        logger.warn("[zcode-go] OPC 员工记忆绑定失败", error);
        return {
          ok: false,
          memoryIndex: null,
          linked: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

/** 预留：员工记忆目录的明文路径（UI 展示/审计用）。 */
export function opcEmployeeMemoryIndexPath(
  workspacePath: string,
  employeeId: string,
): string {
  return join(opcEmployeeMemoryDir(workspacePath, employeeId), "MEMORY.md");
}
