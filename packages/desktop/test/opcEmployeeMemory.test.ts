import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ensureOpcEmployeeMemory } from "../src/main/zcodeGoOpcEmployeeMemory.js";
import { opcEmployeeMemoryIdentity } from "@zcode/shared";

const CLEANUP: string[] = [];
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opc-emp-mem-"));
  CLEANUP.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of CLEANUP) await rm(dir, { recursive: true, force: true });
});

const logger = { info: () => {}, warn: () => {} };

/** 员工记忆根（<ws>/.opc/employees/<id>/.zcode/cli/memories/projects/project-<hash>/memory）*/
function memoryRoot(ws: string, employeeId: string): string {
  const identity = opcEmployeeMemoryIdentity(employeeId, ws);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return join(
    ws,
    ".opc",
    "employees",
    employeeId,
    ".zcode",
    "cli",
    "memories",
    "projects",
    `project-${hash}`,
    "memory",
  );
}

describe("员工记忆绑定（data dir 沙箱形态）", () => {
  it("ensure 在员工 data dir 内创建记忆根并回读索引/persona/原则", async () => {
    const ws = await makeTmp();
    const root = memoryRoot(ws, "e1");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "MEMORY.md"),
      "- [供应商延期](vendor-delay.md) — 先冻结需求\n",
      "utf8",
    );
    await writeFile(join(root, "persona.md"), "谨慎、先对齐再动手", "utf8");
    await writeFile(
      join(root, "p-verify.md"),
      "---\ntype: principle\nname: 先验证后提交\n---\n正文",
      "utf8",
    );

    const result = await ensureOpcEmployeeMemory(logger, ws, "e1");
    expect(result.bound).toBe(true);
    expect(result.memoryIndex).toContain("先冻结需求");
    expect(result.personaDigest).toContain("谨慎");
    expect(result.principles).toEqual(["先验证后提交"]);
    // 显示路径为 workspace 相对（委派 prompt 的写入指引与 denylist glob 同一坐标系）
    expect(result.memoryDirDisplay).toBe(root.slice(ws.length + 1));
  });

  it("新员工：目录就地创建，索引/persona 为 null、原则为空", async () => {
    const ws = await makeTmp();
    const result = await ensureOpcEmployeeMemory(logger, ws, "fresh-id");
    expect(result.bound).toBe(true);
    expect(result.memoryIndex).toBeNull();
    expect(result.personaDigest).toBeNull();
    expect(result.principles).toEqual([]);
    // 记忆根目录已在员工 data dir 内就绪
    await expect(readdir(memoryRoot(ws, "fresh-id"))).resolves.toEqual([]);
  });

  it("一次性迁移：symlink 时代的 .opc/<id>/memory 旧数据迁入新记忆根", async () => {
    const ws = await makeTmp();
    const legacy = join(ws, ".opc", "employees", "e2", "memory");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "MEMORY.md"), "- 旧索引行\n", "utf8");
    await writeFile(join(legacy, "old-note.md"), "旧记忆正文", "utf8");

    const result = await ensureOpcEmployeeMemory(logger, ws, "e2");
    expect(result.bound).toBe(true);
    expect(result.memoryIndex).toContain("旧索引行");
    // 迁移后新记忆根持有数据，旧目录保留（废弃现场不删）
    expect(await readFile(join(memoryRoot(ws, "e2"), "old-note.md"), "utf8")).toBe(
      "旧记忆正文",
    );
    await expect(readFile(join(legacy, "MEMORY.md"), "utf8")).resolves.toContain(
      "旧索引行",
    );
  });

  it("新记忆根已有内容时不迁移（绝不覆盖 CLI 已写数据）", async () => {
    const ws = await makeTmp();
    const legacy = join(ws, ".opc", "employees", "e3", "memory");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "MEMORY.md"), "- 旧索引\n", "utf8");
    const root = memoryRoot(ws, "e3");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "MEMORY.md"), "- 新索引（CLI 已写）\n", "utf8");

    const result = await ensureOpcEmployeeMemory(logger, ws, "e3");
    expect(result.memoryIndex).toContain("新索引（CLI 已写）");
    expect(await readdir(root)).toEqual(["MEMORY.md"]);
  });

  it("异形 employeeId（含路径分隔符）拒绝绑定", async () => {
    const ws = await makeTmp();
    const result = await ensureOpcEmployeeMemory(logger, ws, "../escape");
    expect(result.bound).toBe(false);
    expect(result.memoryIndex).toBeNull();
  });
});
