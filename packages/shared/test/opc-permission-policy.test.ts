import { describe, expect, it } from "vitest";
import { buildOpcToolDenylist } from "../src/opc/opc-permission-policy.js";

describe("buildOpcToolDenylist（会话级硬约束）", () => {
  it("read-only 拒绝文件写家族 + shell + todo 写", () => {
    const deny = buildOpcToolDenylist("read-only")!;
    expect(deny).toContain("Write");
    expect(deny).toContain("Edit");
    expect(deny).toContain("ApplyPatch");
    expect(deny).toContain("Bash");
    expect(deny).toContain("TodoWrite");
    expect(deny).not.toContain("Read");
    expect(deny).not.toContain("Grep");
  });

  it("workspace-write 拒 shell 与 node-repl（任意执行通道）", () => {
    const deny = buildOpcToolDenylist("workspace-write")!;
    expect(deny).toContain("Bash");
    expect(deny).toContain("js");
    expect(deny).not.toContain("TodoRead");
  });

  it("full-access 不拒绝任何工具；缺省视为 workspace-write", () => {
    expect(buildOpcToolDenylist("full-access")).toBeUndefined();
    expect(buildOpcToolDenylist(undefined)).toContain("Bash");
  });
});

describe("权限边界修正（复核修复回归）", () => {
  it("read-only 豁免 TodoRead（只读操作不越权）", () => {
    const deny = buildOpcToolDenylist("read-only")!;
    expect(deny).toContain("TodoWrite");
    expect(deny).not.toContain("TodoRead");
  });

  it("workspace-write 补拒 node-repl 家族（任意 eval 等同 shell 通道）", () => {
    const deny = buildOpcToolDenylist("workspace-write")!;
    expect(deny).toContain("js");
    expect(deny).toContain("mcp__node_repl__js");
    expect(deny).toContain("Bash");
  });
});
