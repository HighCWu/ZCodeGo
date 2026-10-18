/**
 * zcode-go OPC 员工持久记忆（存储绑定与隔离策略，纯函数零依赖）。
 *
 * 设计（spec「员工持久记忆」）：物理数据在
 * `<工作区>/.opc/employees/<employeeId>/`（随公司包/工作区走），CLI 记忆
 * 管线经符号链接按 `~/.zcode` 路径原样工作。本模块只做纯计算（路径、键、
 * 规则、prompt 段），链接创建与校验在 desktop main（fs 副作用）。
 *
 * hash 算法与 apps/zcode-cli/packages/core/src/memory/project-root.ts 保持
 * 一致（sha256(keySource) 前 16 位十六进制，slug 固定 "project"）——CLI
 * 侧不可修改，本文件改动必须双向同步注释。
 */
import { join } from "node:path";

const MEMORY_IDENTITY_PREFIX = "opc-employee/";

/**
 * 员工会话的 Workspace Identity（会话隔离与记忆根同键，AGENTS.md 规则）。
 * 含 workspacePath 维度：员工记忆物理上绑定在该工作区的 .opc 内（跨工作区
 * 的同名员工 id 必须落到不同的 ~/.zcode 链接，否则互相覆盖绑定）。
 *
 * ⚠️ 本文件被 preload 间接打包（shared barrel → zcodeGoEntries）：sandbox
 * preload 禁用 node 内置模块——**禁止在本文件 import 任何 node 模块**
 * （node:crypto 等会让整个 preload 加载失败，window.zcode 全灭）。
 */
export function opcEmployeeMemoryIdentity(
  employeeId: string,
  workspacePath: string,
): string {
  return `${MEMORY_IDENTITY_PREFIX}${workspacePath}::${employeeId}`;
}

/** CLI project-root.ts 同款的目录键名：`project-<hash>`（hash 由调用方计算：
 * sha256(keySource) 前 16 位十六进制，CLI project-root.ts 同款；本文件因
 * preload 打包约束不做 node:crypto 计算）。 */
export function opcEmployeeMemoryProjectDirName(memoryHash: string): string {
  return `project-${memoryHash}`;
}

/**
 * CLI 记忆根的链接源（`~/.zcode/cli/memories/projects/project-<hash>`）。
 * 桌面在此路径创建目录链接（win32 junction / 其余 symlink），指向
 * opcEmployeeCliMemoryDir 的物理目录。
 */
export function opcEmployeeMemoryCliLinkPath(
  home: string,
  employeeId: string,
  workspacePath: string,
  memoryHash: string,
): string {
  return join(
    home,
    ".zcode",
    "cli",
    "memories",
    "projects",
    opcEmployeeMemoryProjectDirName(memoryHash),
  );
}

/** 员工记忆的物理目录（.opc 内，随工作区/公司包走）。 */
export function opcEmployeeMemoryDir(workspacePath: string, employeeId: string): string {
  return join(workspacePath, ".opc", "employees", employeeId, "memory");
}

/** 链接目标目录（CLI 管线的记忆根；CLI 会在其下使用 memory/ 结构）。 */
export function opcEmployeeCliMemoryDir(workspacePath: string, employeeId: string): string {
  return join(workspacePath, ".opc", "employees", employeeId, "cli-memory");
}

/**
 * 员工 toolDenylist 的记忆隔离追加项：其它员工记忆目录的读/写/改拒绝，
 * 以及公司状态文件（company.json）的写保护。规则语法与 CLI toolDenylist
 * 的 Tool(glob) 形态一致。
 */
export function buildOpcEmployeeMemoryDenylist(
  employeeId: string,
  allEmployeeIds: readonly string[],
): string[] {
  const denied: string[] = [];
  for (const other of allEmployeeIds) {
    if (other === employeeId) continue;
    for (const tool of ["Read", "Write", "Edit"] as const) {
      denied.push(`${tool}(.opc/employees/${other}/**)`);
      denied.push(`${tool}(.opc/employees/${other}/**/)`);
    }
  }
  for (const tool of ["Write", "Edit"] as const) {
    denied.push(`${tool}(.opc/company.json)`);
  }
  return denied;
}

/**
 * 委派 prompt 的「持久记忆」段：MEMORY.md 索引全文 + 维护指令。
 * 索引缺失（新员工）时仅声明目录与职责。
 */
export function buildOpcEmployeeMemoryPromptSection(input: {
  memoryDirDisplay: string;
  memoryIndex: string | null;
}): string {
  const indexBlock = input.memoryIndex?.trim()
    ? `【你的 MEMORY.md 索引（当前内容）】\n${input.memoryIndex.trim()}`
    : "【你的 MEMORY.md 索引】当前为空——这是你早期的工作阶段，随着任务积累逐步建立。";
  return [
    "## 持久记忆",
    "",
    `你有自己的持久记忆目录：\`${input.memoryDirDisplay}/\`（跨任务保留，属于你个人）。`,
    "记忆格式：一个事实一个 markdown 文件（frontmatter 含 name/description，",
    "type 取 user/feedback/project/reference），并在 MEMORY.md 中维护一行索引。",
    "",
    indexBlock,
    "",
    "本次任务中值得长期记住的事实（用户偏好、项目约束、反复出现的模式），请在任务",
    "收口时写入记忆目录并同步 MEMORY.md 索引行；已存在但发生变化的记忆要更新而非新建。",
  ].join("\n");
}
