/**
 * zcode-go OPC 权限策略（会话级硬约束，OpenOPC native 三级对齐）。
 *
 * 编排器无界面派发是我们创建的会话——sendPrompt 的 toolDenylist 参数即
 * 真实约束：按员工 permissionLevel 隐藏写入/执行类工具，agent 侧物理不可调用。
 * 手动 composer 路径的会话归用户控制，仍为 prompt 级（委派 prompt 注入边界章节）。
 *
 * 级别语义（对齐 OpenOPC native_approval_level）：
 * - read-only      只读：拒绝文件写家族 + shell + todo 写（纯分析/建议）
 * - workspace-write 工作区写（缺省）：拒绝 shell（文件写入由 CLI 工作区边界限定）
 * - full-access    完全访问：不拒绝（破坏性动作仍由 prompt 边界约束升级）
 */
import {
  isZCodeToolFamily,
  ZCODE_KNOWN_TOOL_NAMES,
  type OpcPermissionLevel,
} from "../index.js";

const FILE_WRITE_TOOLS = ZCODE_KNOWN_TOOL_NAMES.filter((name) =>
  isZCodeToolFamily(name, "file-write"),
);
const SHELL_TOOLS = ZCODE_KNOWN_TOOL_NAMES.filter((name) =>
  isZCodeToolFamily(name, "shell"),
);
const TODO_WRITE_TOOLS = ZCODE_KNOWN_TOOL_NAMES.filter((name) =>
  isZCodeToolFamily(name, "todo"),
);

export function buildOpcToolDenylist(
  permissionLevel: OpcPermissionLevel | undefined,
): string[] | undefined {
  const level = permissionLevel ?? "workspace-write";
  if (level === "full-access") return undefined;
  if (level === "read-only") {
    return [...FILE_WRITE_TOOLS, ...SHELL_TOOLS, ...TODO_WRITE_TOOLS];
  }
  // workspace-write：shell 是越出工作区边界的主要通道，予以拒绝
  return [...SHELL_TOOLS];
}
