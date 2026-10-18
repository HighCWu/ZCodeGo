import { describe, expect, it } from "vitest";
import {
  buildOpcEmployeeMemoryDenylist,
  buildOpcEmployeeMemoryPromptSection,
  opcEmployeeMemoryIdentity,
  opcEmployeeSandboxMemoryRoot,
  resolveOpcEmployeeSandbox,
} from "../src/opc/opc-employee-memory.js";

describe("OPC 员工持久记忆（沙箱解析与隔离策略）", () => {
  it("identity 含 workspace 维度（跨工作区同名员工隔离）", () => {
    expect(opcEmployeeMemoryIdentity("emp-1", "/ws/a")).toBe(
      "opc-employee//ws/a::emp-1",
    );
    // 不同工作区的同名员工 → 不同 identity → 不同 data 根（互不覆盖）
    expect(opcEmployeeMemoryIdentity("emp-1", "/ws/b")).not.toBe(
      opcEmployeeMemoryIdentity("emp-1", "/ws/a"),
    );
  });

  it("沙箱解析：identity 内嵌 ws 与传入一致时返回员工 data 根", () => {
    const ws = "/ws/a";
    const sandbox = resolveOpcEmployeeSandbox(
      ws,
      opcEmployeeMemoryIdentity("emp-1", ws),
    );
    expect(sandbox).not.toBeNull();
    expect(sandbox!.employeeId).toBe("emp-1");
    expect(sandbox!.employeeDir).toBe(`${ws}/.opc/employees/emp-1`);
    expect(sandbox!.identityKey).toBe(`opc-employee/${ws}::emp-1`);
  });

  it("沙箱解析拒绝跨工作区/异形 identity（防误路由）", () => {
    // identity 内嵌的 workspacePath 与传入不一致 → null（绝不跨区路由）
    expect(
      resolveOpcEmployeeSandbox("/ws/b", opcEmployeeMemoryIdentity("emp-1", "/ws/a")),
    ).toBeNull();
    // 非 opc-employee 前缀（普通会话）→ null
    expect(resolveOpcEmployeeSandbox("/ws/a", "sess_abc")).toBeNull();
    expect(resolveOpcEmployeeSandbox("/ws/a", undefined)).toBeNull();
    // 缺 :: 分隔 → null
    expect(resolveOpcEmployeeSandbox("/ws/a", "opc-employee/noid")).toBeNull();
    // "." / ".." 员工 id 会让 data 根逃出 employees/ 一层 → null（防构造性穿越）
    expect(resolveOpcEmployeeSandbox("/ws/a", "opc-employee//ws/a::.")).toBeNull();
    expect(resolveOpcEmployeeSandbox("/ws/a", "opc-employee//ws/a::..")).toBeNull();
  });

  it("记忆根在员工 data dir 的 CLI 布局下（data dir 沙箱形态）", () => {
    const employeeDir = "/ws/a/.opc/employees/emp-1";
    expect(opcEmployeeSandboxMemoryRoot(employeeDir, "abc123")).toBe(
      `${employeeDir}/.zcode/cli/memories/projects/project-abc123/memory`,
    );
  });

  it("denylist：拒绝其它员工记忆目录的读/写/改，豁免自己；公司状态只拒写", () => {
    const rules = buildOpcEmployeeMemoryDenylist("emp-1", ["emp-1", "emp-2", "emp-3"]);
    // 自己被豁免
    expect(rules.some((r) => r.includes("employees/emp-1/"))).toBe(false);
    // 其它员工三工具全拒
    for (const other of ["emp-2", "emp-3"]) {
      for (const tool of ["Read", "Write", "Edit"]) {
        expect(rules).toContain(`${tool}(.opc/employees/${other}/**)`);
      }
    }
    // 公司状态仅写保护（读放开）
    expect(rules).toContain("Write(.opc/company.json)");
    expect(rules).toContain("Edit(.opc/company.json)");
    expect(rules.some((r) => r.startsWith("Read(.opc/company.json"))).toBe(false);
  });

  it("prompt 段：有索引带全文，无索引进初期分支；两者都声明目录与维护职责", () => {
    const display = ".opc/employees/emp-1/.zcode/cli/memories/projects/project-abc123/memory";
    const withIndex = buildOpcEmployeeMemoryPromptSection({
      memoryDirDisplay: display,
      memoryIndex: "- [供应商延期](vendor-delay.md) — 先冻结需求",
    });
    expect(withIndex).toContain("供应商延期");
    expect(withIndex).toContain(display);

    const withoutIndex = buildOpcEmployeeMemoryPromptSection({
      memoryDirDisplay: display,
      memoryIndex: null,
    });
    expect(withoutIndex).toContain("当前为空");
    expect(withoutIndex).toContain(display);
    expect(withIndex).toContain("MEMORY.md");
  });
});
