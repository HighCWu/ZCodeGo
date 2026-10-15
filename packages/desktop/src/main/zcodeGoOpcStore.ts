/**
 * zcode-go OPC 公司状态存储（desktop main 进程，唯一事实源）。
 *
 * 职责：<workspace>/.opc/ 目录的读写（JSON 原子写 + JSONL 追加 + SKILL.md 落盘）、
 * 内置模板包的首发初始化、共享 reducer 的执行与广播。渲染进程永远不直接碰文件，
 * 全部经 IPC（channels.ts ZcodeGoOpc*）。spec：specs/opc-mode.md。
 *
 * 并发模型：main 单线程，本模块内以「每 workspacePath 一条串行队列」保证
 * 读写不交错；多窗口写冲突由「后写覆盖整树 + 广播 reload」收敛（UI 无本地写路径）。
 */
import { ipcMain, BrowserWindow } from "electron";
import {
  appendFile,
  existsSync,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  applyOpcMutation,
  createEmptyOpcCompanyState,
  OPC_BUILTIN_SKILL_DRAFTS,
  OPC_COMPANY_FILE,
  OPC_DIR_NAME,
  OPC_EVOLUTION_LOG_FILE,
  OPC_MEMORY_DIR,
  OPC_ROLES_TEMPLATES_SUBDIR,
  OPC_SKILLS_DIR,
  OPC_TEMPLATES_DIR,
  parseOpcRoleTemplate,
  parseOpcSkillMarkdown,
  PlatformChannels,
  renderOpcEmployeeMemory,
  renderOpcSkillFile,
  type OpcCompanyState,
  type OpcEvolutionEvent,
  type OpcMutation,
  type OpcSkillMeta,
} from "@zcode/shared";

interface OpcStoreLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** 每 workspacePath 一条串行队列：同工作区的读写永不交错。 */
const workspaceQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(workspacePath: string, task: () => Promise<T>): Promise<T> {
  const previous = workspaceQueues.get(workspacePath) ?? Promise.resolve();
  const next = previous.then(task, task);
  workspaceQueues.set(workspacePath, next);
  return next;
}

function opcRoot(workspacePath: string): string {
  return join(resolve(workspacePath), OPC_DIR_NAME);
}

/** 原子写 JSON：tmp + rename，避免半写文件被下次启动读到。 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 1), "utf8");
  await rename(tmp, path);
}

async function readCompanyState(
  workspaceRoot: string,
): Promise<OpcCompanyState | null> {
  try {
    const raw = await readFile(join(workspaceRoot, OPC_COMPANY_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as OpcCompanyState;
    if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.employees))
      return null;
    return candidate;
  } catch {
    return null;
  }
}

/** 首发初始化：默认公司（创始人）+ 内置技能落盘（角色模板保留在内置包，不入盘）。 */
async function initializeWorkspace(
  workspaceRoot: string,
): Promise<OpcCompanyState> {
  const now = Date.now();
  const state = createEmptyOpcCompanyState(now);
  for (const skillDraft of OPC_BUILTIN_SKILL_DRAFTS) {
    state.skills.push({
      id: skillDraft.id,
      name: skillDraft.name,
      description: skillDraft.description,
      category: skillDraft.category,
      version: 1,
      origin: "builtin",
      changelog: [],
      updatedAt: now,
    });
  }
  await mkdir(join(workspaceRoot, OPC_MEMORY_DIR), { recursive: true });
  await mkdir(
    join(workspaceRoot, OPC_TEMPLATES_DIR, OPC_ROLES_TEMPLATES_SUBDIR),
    { recursive: true },
  );
  await mkdir(join(workspaceRoot, OPC_SKILLS_DIR), { recursive: true });
  await writeJsonAtomic(join(workspaceRoot, OPC_COMPANY_FILE), state);
  for (const draft of OPC_BUILTIN_SKILL_DRAFTS) {
    await writeFile(
      join(workspaceRoot, OPC_SKILLS_DIR, draft.id, "SKILL.md"),
      renderOpcSkillFile({
        id: draft.id,
        name: draft.name,
        description: draft.description,
        category: draft.category,
        version: 1,
        changelog: [],
        body: draft.body,
      }),
      "utf8",
    );
  }
  return state;
}

/** 技能正文来源：晋升技能按指纹渲染 playbook 正文；其余用内置包或占位。 */
function resolveSkillBodySource(meta: OpcSkillMeta): string {
  if (meta.origin === "promoted") {
    const statement = meta.name.replace(/^Playbook：/, "");
    return [
      `# ${meta.name}`,
      "",
      "> 本 playbook 由复盘经验自动晋升生成（来源员工档案见 .opc/memory/）。",
      "",
      "## 适用场景",
      "",
      `- ${meta.description}`,
      "",
      "## 核心经验",
      "",
      `- ${statement}`,
      "",
      "## 执行约定",
      "",
      "- 在同类任务开始前主动应用本经验；",
      "- 若经验与新环境冲突，以当前任务验收标准优先，并在复盘时提出修订。",
      "",
    ].join("\n");
  }
  const builtin = OPC_BUILTIN_SKILL_DRAFTS.find(
    (draft) => draft.id === meta.id,
  );
  return builtin?.body ?? `# ${meta.name}\n\n${meta.description}\n`;
}

/** 把状态派生的文件补写全（新建技能的 SKILL.md / 员工记忆 / 进化日志），company.json 最后写。 */
async function persistDerivedFiles(
  workspaceRoot: string,
  previous: OpcCompanyState | null,
  state: OpcCompanyState,
): Promise<void> {
  await mkdir(join(workspaceRoot, OPC_SKILLS_DIR), { recursive: true });
  await mkdir(join(workspaceRoot, OPC_MEMORY_DIR), { recursive: true });
  for (const meta of state.skills) {
    const skillFile = join(workspaceRoot, OPC_SKILLS_DIR, meta.id, "SKILL.md");
    if (existsSync(skillFile)) continue;
    await mkdir(join(workspaceRoot, OPC_SKILLS_DIR, meta.id), {
      recursive: true,
    });
    await writeFile(
      skillFile,
      renderOpcSkillFile({
        id: meta.id,
        name: meta.name,
        description: meta.description,
        category: meta.category,
        version: meta.version,
        changelog: meta.changelog,
        body: resolveSkillBodySource(meta),
      }),
      "utf8",
    );
  }
  for (const employee of state.employees) {
    const lessons = state.lessons.filter(
      (lesson) => lesson.employeeId === employee.id,
    );
    const previousCount =
      previous?.lessons.filter((lesson) => lesson.employeeId === employee.id)
        .length ?? 0;
    if (lessons.length === previousCount) continue;
    await writeFile(
      join(workspaceRoot, OPC_MEMORY_DIR, `${employee.id}.md`),
      renderOpcEmployeeMemory(employee, lessons, Date.now()),
      "utf8",
    );
  }
  const previousEventIds = new Set(
    (previous?.evolution ?? []).map((event) => event.id),
  );
  const newEvents: OpcEvolutionEvent[] = state.evolution.filter(
    (event) => !previousEventIds.has(event.id),
  );
  if (newEvents.length > 0) {
    await appendFile(
      join(workspaceRoot, OPC_EVOLUTION_LOG_FILE),
      newEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );
  }
}

async function withState(
  workspacePath: string,
  mutate: (
    state: OpcCompanyState,
    workspaceRoot: string,
  ) => Promise<OpcCompanyState>,
): Promise<{ ok: boolean; state: OpcCompanyState | null; error?: string }> {
  const workspaceRoot = opcRoot(workspacePath);
  return enqueue(workspacePath, async () => {
    try {
      const previous = await readCompanyState(workspaceRoot);
      const current = previous ?? (await initializeWorkspace(workspaceRoot));
      const next = await mutate(current, workspaceRoot);
      await persistDerivedFiles(workspaceRoot, previous, next);
      await writeJsonAtomic(join(workspaceRoot, OPC_COMPANY_FILE), next);
      return { ok: true, state: next };
    } catch (error) {
      return {
        ok: false,
        state: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// 目录扫描（导入用）
// ---------------------------------------------------------------------------

async function listMarkdownFiles(sourcePath: string): Promise<string[]> {
  const abs = resolve(sourcePath);
  const entries = await readdir(abs, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(abs, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(full)));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 技能正文落盘：skill.import / skill.upgrade 携带的新正文写入 skills/<id>/SKILL.md
 * （版本覆盖语义：文件即正文，company.json 只存元数据）。缺失正文时保留现状。
 */
async function persistSkillBodies(
  workspaceRoot: string,
  mutations: OpcMutation[],
): Promise<void> {
  for (const mutation of mutations) {
    if (mutation.kind !== "skill.import" && mutation.kind !== "skill.upgrade")
      continue;
    const skillId = mutation.skillId;
    if (!skillId) continue;
    const skillDir = join(workspaceRoot, OPC_SKILLS_DIR, skillId);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), mutation.body, "utf8");
  }
}

function broadcastStateChanged(
  logger: OpcStoreLogger,
  workspacePath: string,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(PlatformChannels.ZcodeGoOpcStateChanged, {
        workspacePath,
      });
    } catch (error) {
      logger.warn("[zcode-go] OPC 状态广播失败", error);
    }
  }
}

// ---------------------------------------------------------------------------
// IPC 注册（index.ts 门控点 = import + initZcodeGoOpcStore 一行调用）
// ---------------------------------------------------------------------------

/** 读取 prompt 构造所需的正文映射（导入角色模板 + 技能正文）。 */
async function readBodies(
  workspaceRoot: string,
  state: OpcCompanyState,
): Promise<{
  roleTemplateBodies: Record<string, string>;
  skillBodies: Record<string, string>;
}> {
  const roleTemplateBodies: Record<string, string> = {};
  for (const template of state.roleTemplates) {
    try {
      roleTemplateBodies[template.id] = await readFile(
        join(
          workspaceRoot,
          OPC_TEMPLATES_DIR,
          OPC_ROLES_TEMPLATES_SUBDIR,
          `${template.id}.md`,
        ),
        "utf8",
      );
    } catch {
      /* 正文缺失时 UI 回退内置包或描述 */
    }
  }
  const skillBodies: Record<string, string> = {};
  for (const skill of state.skills) {
    try {
      const raw = await readFile(
        join(workspaceRoot, OPC_SKILLS_DIR, skill.id, "SKILL.md"),
        "utf8",
      );
      const parsed = parseOpcSkillMarkdown(raw, { fallbackName: skill.name });
      skillBodies[skill.id] = parsed?.body ?? raw;
    } catch {
      /* 正文缺失时 UI 回退描述 */
    }
  }
  return { roleTemplateBodies, skillBodies };
}

export function initZcodeGoOpcStore(logger: OpcStoreLogger): void {
  ipcMain.handle(
    PlatformChannels.ZcodeGoOpcGetState,
    async (_event, payload: { workspacePath: string }) =>
      enqueue(payload.workspacePath, async () => {
        const workspaceRoot = opcRoot(payload.workspacePath);
        try {
          const existing = await readCompanyState(workspaceRoot);
          const state = existing ?? (await initializeWorkspace(workspaceRoot));
          return {
            ok: true as const,
            state,
            ...(await readBodies(workspaceRoot, state)),
          };
        } catch (error) {
          logger.warn("[zcode-go] OPC 状态读取失败", error);
          return {
            ok: false as const,
            state: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
  );

  ipcMain.handle(
    PlatformChannels.ZcodeGoOpcApply,
    async (
      _event,
      payload: { workspacePath: string; mutations: OpcMutation[] },
    ) => {
      const events: OpcEvolutionEvent[] = [];
      const promotedSkillIds: string[] = [];
      const result = await withState(
        payload.workspacePath,
        async (state, workspaceRoot) => {
          let current = state;
          for (const mutation of payload.mutations) {
            const applied = applyOpcMutation(current, mutation, Date.now());
            current = applied.state;
            events.push(...applied.events);
            promotedSkillIds.push(...applied.promotedSkillIds);
          }
          await persistSkillBodies(workspaceRoot, payload.mutations);
          return current;
        },
      );
      if (result.ok && result.state) {
        broadcastStateChanged(logger, payload.workspacePath);
      }
      return {
        ok: result.ok,
        state: result.state,
        ...(result.state && result.ok
          ? await readBodies(opcRoot(payload.workspacePath), result.state)
          : {}),
        events,
        promotedSkillIds,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  );

  ipcMain.handle(
    PlatformChannels.ZcodeGoOpcImportRoleTemplates,
    async (_event, payload: { workspacePath: string; sourcePath: string }) => {
      let imported = 0;
      const result = await withState(
        payload.workspacePath,
        async (state, workspaceRoot) => {
          let current = state;
          const files = await listMarkdownFiles(payload.sourcePath);
          const templatesDir = join(
            workspaceRoot,
            OPC_TEMPLATES_DIR,
            OPC_ROLES_TEMPLATES_SUBDIR,
          );
          await mkdir(templatesDir, { recursive: true });
          for (const file of files) {
            try {
              const markdown = await readFile(file, "utf8");
              const draft = parseOpcRoleTemplate(markdown);
              // OpenOPC talent 判据：五字段 frontmatter 至少 name + description；
              // 目录里的 README 等普通文档跳过，避免误收。
              if (!draft || !draft.description) continue;
              const applied = applyOpcMutation(
                current,
                { kind: "template.importRole", markdown },
                Date.now(),
              );
              current = applied.state;
              await writeFile(
                join(templatesDir, `${draft.id}.md`),
                markdown,
                "utf8",
              );
              imported += 1;
            } catch {
              /* 单文件损坏不中断批量导入 */
            }
          }
          return current;
        },
      );
      if (result.ok && result.state) {
        broadcastStateChanged(logger, payload.workspacePath);
      }
      return {
        ok: result.ok,
        imported,
        state: result.state,
        ...(result.state && result.ok
          ? await readBodies(opcRoot(payload.workspacePath), result.state)
          : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    },
  );

  ipcMain.handle(
    PlatformChannels.ZcodeGoOpcImportSkillFolder,
    async (_event, payload: { workspacePath: string; sourcePath: string }) => {
      let imported = 0;
      const result = await withState(payload.workspacePath, async (state) => {
        let current = state;
        const files = await listMarkdownFiles(payload.sourcePath);
        for (const file of files) {
          if (!/SKILL\.md$/i.test(file)) continue;
          try {
            const markdown = await readFile(file, "utf8");
            const draft = parseOpcSkillMarkdown(markdown, {
              fallbackName: file.split(/[\\/]/).slice(-2)[0],
            });
            if (!draft) continue;
            const mutation: OpcMutation = {
              kind: "skill.import",
              skillId: draft.id,
              name: draft.name,
              description: draft.description,
              category: draft.category,
              body: markdown,
            };
            const applied = applyOpcMutation(current, mutation, Date.now());
            current = applied.state;
            await persistSkillBodies(opcRoot(payload.workspacePath), [
              mutation,
            ]);
            imported += 1;
          } catch {
            /* 单文件损坏不中断批量导入 */
          }
        }
        return current;
      });
      if (result.ok && result.state) {
        broadcastStateChanged(logger, payload.workspacePath);
      }
      return {
        ok: result.ok,
        imported,
        state: result.state,
        ...(result.state && result.ok
          ? await readBodies(opcRoot(payload.workspacePath), result.state)
          : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    },
  );

  logger.info("[zcode-go] OPC 公司状态存储就绪（IPC 已注册）");
}
