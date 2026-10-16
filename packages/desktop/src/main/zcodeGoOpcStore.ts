/* oxlint-disable eslint(max-lines) -- 公司状态持久化 + IPC 收口：inbox 是该收口的自然延伸（同插件宿主单文件惯例），拆散会破坏事实源内聚。 */
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
// zcode-go：existsSync 只在 node:fs（fs/promises 无此导出）——错误来源会让
// ESM 顶层命名导入在 main 启动时整模块崩溃（E2E 首跑实证）。
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  applyOpcMutation,
  createEmptyOpcCompanyState,
  OPC_BUILTIN_SKILL_DRAFTS,
  OPC_COMPANY_FILE,
  OPC_DIR_NAME,
  OPC_INBOX_DIR,
  OPC_EVOLUTION_LOG_FILE,
  OPC_MEMORY_DIR,
  OPC_ROLES_TEMPLATES_SUBDIR,
  OPC_SKILLS_DIR,
  OPC_TEMPLATES_DIR,
  parseOpcInboxFile,
  parseOpcRoleTemplate,
  PlatformChannels,
  renderOpcEmployeeMemory,
  renderOpcSkillFile,
  type OpcCompanyState,
  type OpcEvolutionEvent,
  type OpcInboxItem,
  type OpcMutation,
} from "@zcode/shared";
// zcode-go：OPC 文件助手与模板包同步（本文件超行后拆出）
import {
  listMarkdownFiles,
  persistRoleTemplateBodies,
  persistSkillBodies,
  readBodies,
  resolveSkillBodySource,
  writeTextAtomic,
} from "./zcodeGoOpcFiles.js";
import { syncOpcPacks } from "./zcodeGoOpcPacks.js";

interface OpcStoreLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** init 时注入的模块级 logger（packs 同步在 withState 内部深处要用）。 */
let opcLogger: OpcStoreLogger | null = null;
const silentOpcLogger: OpcStoreLogger = {
  info: () => undefined,
  warn: () => undefined,
};

/** 模块级 warn 便捷入口（scanInbox 等无 logger 参数的路径）。 */
function opcLoggerWarn(message: string, error: unknown): void {
  (opcLogger ?? silentOpcLogger).warn(message, error);
}

/** 每 workspacePath 一条串行队列：同工作区的读写永不交错。 */
const workspaceQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(workspacePath: string, task: () => Promise<T>): Promise<T> {
  // 键必须 resolve：同一目录以不同字符串形式（尾斜杠/相对路径）到达时，
  // 未归一会分出两条并行队列，读改写并发丢 company.json 更新
  const key = resolve(workspacePath);
  const previous = workspaceQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  workspaceQueues.set(key, next);
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

/** 损坏现场备份：重建默认公司前把坏文件挪开，用户数据永不静默销毁。 */
async function backupCorruptState(workspaceRoot: string): Promise<void> {
  const corrupt = join(workspaceRoot, OPC_COMPANY_FILE);
  try {
    await rename(corrupt, `${corrupt}.corrupt-${Date.now()}`);
    // 用户必须知道「默认公司重建」发生了：数据在备份里，但视图被重置
    opcLoggerWarn(
      `[zcode-go] OPC company.json 无法解析，已备份并重建默认公司: ${corrupt}`,
    );
  } catch {
    /* 已不存在或已备份 */
  }
}

/** 首发初始化：默认公司（创始人）+ 内置技能落盘（角色模板保留在内置包，不入盘）。 */
async function initializeWorkspace(
  workspaceRoot: string,
): Promise<OpcCompanyState> {
  // 损坏现场先备份再重建（首次初始化时文件不存在，rename 静默无操作）
  await backupCorruptState(workspaceRoot);
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
    // 每个技能的子目录必须显式创建：writeFile 不会建父目录（E2E 首跑实证
    // ENOENT——skills 根目录存在不代表 <id>/ 子目录存在）
    await mkdir(join(workspaceRoot, OPC_SKILLS_DIR, draft.id), {
      recursive: true,
    });
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
    // memory 是覆盖写路径：半写会把员工私人记忆截断且无自愈（其余正文路径
    // 均 existsSync 幂等重建，裸写可接受）
    await writeTextAtomic(
      join(workspaceRoot, OPC_MEMORY_DIR, `${employee.id}.md`),
      renderOpcEmployeeMemory(employee, lessons, Date.now()),
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

// ---------------------------------------------------------------------------
// 入站队列（渠道中立 ingest；spec「入站队列」节）
// ---------------------------------------------------------------------------

async function scanInbox(workspaceRoot: string): Promise<OpcInboxItem[]> {
  const inboxDir = join(workspaceRoot, OPC_INBOX_DIR);
  let entries;
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch (error) {
    // 目录不存在是常态（无入站渠道）；其他错误（权限等）必须留痕——
    // 静默吞掉会让「入站队列永远为空」无从排查（E2E CI 实证场景）。
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      opcLoggerWarn(`[zcode-go] OPC 入站目录扫描失败 dir=${inboxDir}`, error);
    }
    return [];
  }
  const items: OpcInboxItem[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    // d_type 兼容：DT_UNKNOWN 的文件系统上 isFile() 为 false，按扩展名兜底
    const looksLikeJsonFile =
      entry.isFile() || (!entry.isDirectory() && entry.name.endsWith(".json"));
    if (!looksLikeJsonFile) {
      skipped.push(`${entry.name}(非文件项)`);
      continue;
    }
    try {
      const item = parseOpcInboxFile(
        entry.name,
        await readFile(join(inboxDir, entry.name), "utf8"),
      );
      if (item) items.push(item);
      else skipped.push(`${entry.name}(解析不通过)`);
    } catch (error) {
      // 单文件损坏不中断扫描，但必须留痕——静默会让「入站永远为空」无从排查
      skipped.push(`${entry.name}(${(error as Error).message})`);
    }
  }
  if (skipped.length > 0) {
    opcLoggerWarn(
      `[zcode-go] OPC 入站扫描跳过 ${skipped.length}/${entries.length} 项: ${skipped.join("; ")}`,
    );
  }
  return items.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/** 消费入站条目：纯 basename 校验（拒绝路径穿越）；convert 时走正规建项路径。 */
async function consumeInbox(
  workspacePath: string,
  fileName: string,
  convert: {
    title: string;
    detail?: string;
    priority?: "low" | "medium" | "high" | "urgent";
    assigneeId?: string | null;
  } | null,
): Promise<{
  ok: boolean;
  state: OpcCompanyState | null;
  inbox: OpcInboxItem[];
  error?: string;
}> {
  if (
    !fileName ||
    fileName !== basename(fileName) ||
    !fileName.endsWith(".json")
  ) {
    return {
      ok: false,
      state: null,
      inbox: [],
      error: "invalid inbox fileName",
    };
  }
  const inboxFile = join(opcRoot(workspacePath), OPC_INBOX_DIR, fileName);
  // inbox 文件不是状态事实，删除无需队列保护（避免嵌套 enqueue 死锁——
  // consumeInbox 曾在队列任务内再次调用 withState，串行链自等永久挂起）。
  // dismiss 分支直接删；convert 分支必须在建项成功后才删——先删后建在
  // reducer 失败时入站消息永久丢失。
  if (!convert) {
    try {
      await rm(inboxFile, { force: true });
    } catch {
      /* 文件不存在即已被消费 */
    }
    const workspaceRoot = opcRoot(workspacePath);
    return {
      ok: true,
      state: await readCompanyState(workspaceRoot),
      inbox: await scanInbox(workspaceRoot),
    };
  }
  const result = await withState(workspacePath, async (state) => {
    const applied = applyOpcMutation(
      state,
      {
        kind: "workitem.create",
        title: convert.title,
        detail: convert.detail,
        priority: convert.priority,
        assigneeId: convert.assigneeId ?? null,
      },
      Date.now(),
    );
    return applied.state;
  });
  // 建项成功才删文件（失败保留现场供重试/人工处理）
  if (result.ok && result.state) {
    try {
      await rm(inboxFile, { force: true });
    } catch {
      /* 已不存在 */
    }
    broadcastStateChanged(opcLogger ?? silentOpcLogger, workspacePath);
  }
  const inbox = await scanInbox(opcRoot(workspacePath));
  return {
    ok: result.ok,
    state: result.state,
    inbox,
    ...(result.error ? { error: result.error } : {}),
  };
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
      let current = previous ?? (await initializeWorkspace(workspaceRoot));
      // 模板包幂等填充（spec「模板包」节）：戳未变时是两次小 JSON 读，零成本。
      current = await syncOpcPacks(
        workspaceRoot,
        current,
        opcLogger ?? silentOpcLogger,
      );
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

export function initZcodeGoOpcStore(logger: OpcStoreLogger): void {
  opcLogger = logger;
  ipcMain.handle(
    PlatformChannels.ZcodeGoOpcGetState,
    async (_event, payload: { workspacePath: string }) =>
      enqueue(payload.workspacePath, async () => {
        const workspaceRoot = opcRoot(payload.workspacePath);
        try {
          const existing = await readCompanyState(workspaceRoot);
          let state = existing ?? (await initializeWorkspace(workspaceRoot));
          // GetState 也做模板包幂等同步（首次打开 OPC 面板即填充，无需先有写操作）
          const synced = await syncOpcPacks(workspaceRoot, state, logger);
          if (synced !== state) {
            await persistDerivedFiles(workspaceRoot, state, synced);
            await writeJsonAtomic(
              join(workspaceRoot, OPC_COMPANY_FILE),
              synced,
            );
            state = synced;
          }
          const inbox = await scanInbox(workspaceRoot);
          return {
            ok: true as const,
            state,
            inbox,
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
          await persistRoleTemplateBodies(workspaceRoot, payload.mutations);
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

  ipcMain.handle(
    PlatformChannels.ZcodeGoOpcConsumeInbox,
    async (
      _event,
      payload: {
        workspacePath: string;
        fileName: string;
        convert?: {
          title: string;
          detail?: string;
          priority?: "low" | "medium" | "high" | "urgent";
          assigneeId?: string | null;
        } | null;
      },
    ) =>
      consumeInbox(
        payload.workspacePath,
        payload.fileName,
        payload.convert ?? null,
      ),
  );

  logger.info("[zcode-go] OPC 公司状态存储就绪（IPC 已注册）");
}
