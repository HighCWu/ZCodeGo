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

  it("workspace-write 仅拒绝 shell（Bash）", () => {
    const deny = buildOpcToolDenylist("workspace-write")!;
    expect(deny).toEqual(["Bash"]);
  });

  it("full-access 不拒绝任何工具；缺省视为 workspace-write", () => {
    expect(buildOpcToolDenylist("full-access")).toBeUndefined();
    expect(buildOpcToolDenylist(undefined)).toEqual(["Bash"]);
  });
});
