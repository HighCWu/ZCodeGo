import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ensureDirLink } from "../src/main/zcodeGoOpcEmployeeMemory.js";
import { opcEmployeeMemoryCliLinkPath } from "@zcode/shared";

const CLEANUP: string[] = [];
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opc-emp-mem-"));
  CLEANUP.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of CLEANUP) await rm(dir, { recursive: true, force: true });
});

describe("员工记忆目录链接（symlink/junction 语义）", () => {
  it("hash 与 CLI project-root.ts 同算法（sha256(keySource) 前 16 位）", () => {
    // 与 apps/zcode-cli/packages/core/src/memory/project-root.ts 对齐：
    // keySource = workspaceIdentity（trim 后），sha256 前 16 位十六进制
    const ws = "/ws/a";
    const identity = `opc-employee/${ws}::emp-1`;
    const expected = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    const link = opcEmployeeMemoryCliLinkPath("/home/u", "emp-1", ws, expected);
    expect(link).toContain(`project-${expected}`);
    expect(expected).toMatch(/^[0-9a-f]{16}$/);
  });

  it("创建后读写穿透到 .opc 物理目录；重复创建幂等", async () => {
    const ws = await makeTmp();
    const link = join(ws, "link-root");
    const target = join(ws, ".opc", "employees", "e1", "cli-memory");
    await ensureDirLink(link, target);
    // 穿透写：经链接路径写，物理路径可读
    await writeFile(join(link, "MEMORY.md"), "- hook\n", "utf8");
    expect(await readFile(join(target, "MEMORY.md"), "utf8")).toBe("- hook\n");
    // 幂等：重复 ensure 不破坏数据
    await ensureDirLink(link, target);
    expect(await readFile(join(link, "MEMORY.md"), "utf8")).toBe("- hook\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("指向漂移时重建链接且不删除旧目标数据", async () => {
    const ws = await makeTmp();
    const oldTarget = join(ws, "old-target");
    await mkdir(oldTarget, { recursive: true });
    const link = join(ws, "link-root");
    await ensureDirLink(link, oldTarget);
    await writeFile(join(link, "keep.md"), "数据本体", "utf8");

    const newTarget = join(ws, ".opc", "employees", "e1", "cli-memory");
    await ensureDirLink(link, newTarget);
    // 链接已改指新目标（对旧目标的物理数据未删除）
    expect(await readFile(join(oldTarget, "keep.md"), "utf8")).toBe("数据本体");
    // 新目标可穿透读写
    await writeFile(join(link, "new.md"), "新", "utf8");
    expect(await readFile(join(newTarget, "new.md"), "utf8")).toBe("新");
  });

  it("非链接实体占用链接路径时拒绝并抛错（不破坏数据）", async () => {
    const ws = await makeTmp();
    const link = join(ws, "occupied");
    await mkdir(link, { recursive: true });
    await writeFile(join(link, "precious.txt"), "勿删", "utf8");
    const target = join(ws, "elsewhere");
    await expect(ensureDirLink(link, target)).rejects.toThrow(/被非链接实体占用/);
    // 占位数据完好
    expect(await readFile(join(link, "precious.txt"), "utf8")).toBe("勿删");
    // 目标未被创建占用
    await expect(readFile(join(target, "x"))).rejects.toThrow();
  });

  it("链接类型符合平台（win32 junction / 其余 symlink）", async () => {
    const ws = await makeTmp();
    const link = join(ws, "typed-link");
    const target = join(ws, "t");
    await ensureDirLink(link, target);
    const st = await lstat(link);
    expect(st.isSymbolicLink()).toBe(true);
  });
});
