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
// zcode-go：必须直连源模块——从 ../index.js 导入会形成 shared/index →
// opc/index → 本文件 → shared/index 的 ESM 循环，顶层求值时
// ZCODE_KNOWN_TOOL_NAMES 尚未初始化（subagentRuntimeConfig 测试实证
// undefined.filter 崩溃；bundle 打包内联掩盖了该顺序问题）。
import { isZCodeToolFamily, ZCODE_KNOWN_TOOL_NAMES } from "../tool-identity.js";
import type { OpcPermissionLevel } from "./opc-types.js";

const FILE_WRITE_TOOLS = ZCODE_KNOWN_TOOL_NAMES.filter((name) =>
  isZCodeToolFamily(name, "file-write"),
);
const SHELL_TOOLS = ZCODE_KNOWN_TOOL_NAMES.filter((name) =>
  isZCodeToolFamily(name, "shell"),
);
// node_repl 可任意 eval + 文件/网络 IO，是与 shell 等同的越界执行通道
const NODE_REPL_TOOLS = ZCODE_KNOWN_TOOL_NAMES.filter((name) =>
  isZCodeToolFamily(name, "node-repl"),
);
// spec 只说「todo 写」：TodoRead 是只读操作，read-only 员工需要读 todo 了解上下文
const TODO_WRITE_TOOLS = ZCODE_KNOWN_TOOL_NAMES.filter(
  (name) => isZCodeToolFamily(name, "todo") && name !== "TodoRead",
);

export function buildOpcToolDenylist(
  permissionLevel: OpcPermissionLevel | undefined,
): string[] | undefined {
  const level = permissionLevel ?? "workspace-write";
  if (level === "full-access") return undefined;
  if (level === "read-only") {
    return [...FILE_WRITE_TOOLS, ...SHELL_TOOLS, ...TODO_WRITE_TOOLS];
  }
  // workspace-write：shell 与 node_repl 是越出工作区边界的任意执行通道，均拒绝
  return [...SHELL_TOOLS, ...NODE_REPL_TOOLS];
}
