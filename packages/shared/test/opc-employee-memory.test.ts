import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  buildOpcEmployeeMemoryDenylist,
  buildOpcEmployeeMemoryPromptSection,
  opcEmployeeCliMemoryDir,
  opcEmployeeMemoryCliLinkPath,
  opcEmployeeMemoryDir,
  opcEmployeeMemoryHash,
  opcEmployeeMemoryIdentity,
} from "../src/opc/opc-employee-memory.js";

describe("OPC 员工持久记忆（绑定计算与隔离策略）", () => {
  it("identity 含 workspace 维度（跨工作区同名员工隔离）", () => {
    expect(opcEmployeeMemoryIdentity("emp-1", "/ws/a")).toBe(
      "opc-employee//ws/a::emp-1",
    );
    // 不同工作区的同名员工 → 不同 identity → 不同链接（绑定互不覆盖）
    expect(opcEmployeeMemoryIdentity("emp-1", "/ws/b")).not.toBe(
      opcEmployeeMemoryIdentity("emp-1", "/ws/a"),
    );
  });

  it("hash 与 CLI project-root.ts 同算法：sha256(keySource) 前 16 位", () => {
    const expected = createHash("sha256")
      .update("opc-employee//ws/a::emp-1")
      .digest("hex")
      .slice(0, 16);
    expect(opcEmployeeMemoryHash("emp-1", "/ws/a")).toBe(expected);
    expect(opcEmployeeMemoryHash("emp-1", "/ws/a")).toMatch(/^[0-9a-f]{16}$/);
    expect(opcEmployeeMemoryHash("emp-2", "/ws/a")).not.toBe(
      opcEmployeeMemoryHash("emp-1", "/ws/a"),
    );
  });

  it("链接源在 ~/.zcode/cli/memories/projects/ 下且键为 project-<hash>", () => {
    const home = "/home/u";
    const link = opcEmployeeMemoryCliLinkPath(home, "emp-1", "/ws/a");
    const expected = join(
      home,
      ".zcode",
      "cli",
      "memories",
      "projects",
      `project-${opcEmployeeMemoryHash("emp-1", "/ws/a")}`,
    );
    expect(link).toBe(expected);
  });

  it("物理目录落在 .opc/employees/<id>/ 且为绝对路径", () => {
    const ws = resolve("/ws");
    expect(opcEmployeeMemoryDir(ws, "emp-1")).toBe(
      join(ws, ".opc", "employees", "emp-1", "memory"),
    );
    expect(opcEmployeeCliMemoryDir(ws, "emp-1")).toBe(
      join(ws, ".opc", "employees", "emp-1", "cli-memory"),
    );
    expect(isAbsolute(opcEmployeeMemoryDir(ws, "emp-1"))).toBe(true);
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
    const withIndex = buildOpcEmployeeMemoryPromptSection({
      memoryDirDisplay: ".opc/employees/emp-1/memory",
      memoryIndex: "- [供应商延期](vendor-delay.md) — 先冻结需求",
    });
    expect(withIndex).toContain("供应商延期");
    expect(withIndex).toContain(".opc/employees/emp-1/memory");

    const withoutIndex = buildOpcEmployeeMemoryPromptSection({
      memoryDirDisplay: ".opc/employees/emp-1/memory",
      memoryIndex: null,
    });
    expect(withoutIndex).toContain("当前为空");
    expect(withoutIndex).toContain(".opc/employees/emp-1/memory");
    expect(withIndex).toContain("MEMORY.md");
  });
});
