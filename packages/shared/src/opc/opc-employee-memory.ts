/**
 * zcode-go OPC 员工持久记忆（存储隔离与 prompt 策略，纯函数零依赖）。
 *
 * 设计（spec「员工持久记忆」）：员工会话的 agent data 根由 host
 * resolveSpawnEnv 注入 ZCODE_DATA_BASE_DIR 路由到
 * `<工作区>/.opc/employees/<employeeId>/`（随公司包/工作区走）——会话库、
 * 记忆、任务索引全部物理隔离在 .opc 内，官版与主实例零可见；CLI 记忆管线
 * 按该 data 根原样工作。本模块只做纯计算（沙箱解析、路径、键、规则、
 * prompt 段），fs 副作用在 services spawn env 与 desktop main。
 *
 * hash 算法与 apps/zcode-cli/packages/core/src/memory/project-root.ts 保持
 * 一致（sha256(keySource) 前 16 位十六进制，slug 固定 "project"）——CLI
 * 侧不可修改，本文件改动必须双向同步注释。
 */
// 无任何 import：本文件经 shared barrel 被 sandbox preload 打包，node 内置
// 模块（path/crypto/...）一律不可用——路径拼接用手写 POSIX 风格（node fs 在
// Windows 同样接受 / 分隔符）。

const MEMORY_IDENTITY_PREFIX = "opc-employee/";
export const OPC_EMPLOYEE_IDENTITY_PREFIX = MEMORY_IDENTITY_PREFIX;

/**
 * 员工沙箱解析（纯字符串，供 host spawn env 注入与桌面回读共用）。
 * identity 形如 `opc-employee/<workspacePath>::<employeeId>`——内嵌的
 * workspacePath 必须与传入的一致（防跨工作区误路由），不一致返回 null。
 * 返回的 dataBaseDir 即员工 agent 的 ZCODE_DATA_BASE_DIR：其下 .zcode/
 * 子树（会话库/记忆/任务索引）物理隔离在工作区 .opc 内。
 */
export function resolveOpcEmployeeSandbox(
  workspacePath: string,
  identity: string | undefined,
): { employeeId: string; employeeDir: string; identityKey: string } | null {
  if (!identity || !identity.startsWith(OPC_EMPLOYEE_IDENTITY_PREFIX)) return null;
  const rest = identity.slice(OPC_EMPLOYEE_IDENTITY_PREFIX.length);
  const sepIdx = rest.indexOf("::");
  if (sepIdx <= 0) return null;
  const ws = rest.slice(0, sepIdx);
  const employeeId = rest.slice(sepIdx + 2);
  if (!ws || !employeeId || ws !== workspacePath) return null;
  const employeeDir = `${workspacePath}/.opc/employees/${employeeId}`;
  return {
    employeeId,
    employeeDir,
    identityKey: identity,
  };
}

/** 员工记忆根（CLI project-root 同款布局：dataBaseDir 下 .zcode/cli/memories）。 */
export function opcEmployeeSandboxMemoryRoot(
  employeeDir: string,
  memoryHash: string,
): string {
  return `${employeeDir}/.zcode/cli/memories/projects/project-${memoryHash}/memory`;
}

/**
 * 员工会话的 Workspace Identity（会话隔离与记忆根同键，AGENTS.md 规则）。
 * 含 workspacePath 维度：员工 data dir 物理上落在该工作区的 .opc 内（跨工作区
 * 的同名员工 id 必须路由到不同的 data 根，否则互相覆盖）。
 *
 * ⚠️ 本文件被 preload 间接打包（shared barrel → zcodeGoEntries）：sandbox
 * preload 禁用 node 内置模块——**禁止在本文件 import 任何 node 模块**
 * （node:crypto 等会让整个 preload 加载失败，window.zcode 全灭）。
 */
export function opcEmployeeMemoryIdentity(
  employeeId: string,
  workspacePath: string,
): string {
  return `${MEMORY_IDENTITY_PREFIX}${workspacePath}::${employeeId}`;
}

/**
 * 员工 toolDenylist 的记忆隔离追加项：其它员工记忆目录的读/写/改拒绝，
 * 以及公司状态文件（company.json）的写保护。规则语法与 CLI toolDenylist
 * 的 Tool(glob) 形态一致。
 */
export function buildOpcEmployeeMemoryDenylist(
  employeeId: string,
  allEmployeeIds: readonly string[],
): string[] {
  const denied: string[] = [];
  for (const other of allEmployeeIds) {
    if (other === employeeId) continue;
    for (const tool of ["Read", "Write", "Edit"] as const) {
      denied.push(`${tool}(.opc/employees/${other}/**)`);
      denied.push(`${tool}(.opc/employees/${other}/**/)`);
    }
  }
  for (const tool of ["Write", "Edit"] as const) {
    denied.push(`${tool}(.opc/company.json)`);
  }
  return denied;
}

/** 反思轮的节流窗（同一员工 6h 内只跑一次）。 */
export const OPC_REFLECTION_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** 节流判定（纯函数）：距上次反思不足节流窗则跳过。 */
export function shouldRunOpcReflection(input: {
  lastReflectAtMs: number;
  nowMs: number;
  throttleMs?: number;
}): boolean {
  const throttle = input.throttleMs ?? OPC_REFLECTION_THROTTLE_MS;
  return input.nowMs - input.lastReflectAtMs >= throttle;
}

/** persona 注入摘要上限（字符）。 */
export const OPC_PERSONA_DIGEST_LIMIT = 500;

/**
 * 委派 prompt 的「人格画像」段（金字塔 L4 注入：风格先于事实）。
 * persona 摘要缺失（新员工）时不注入——人格由经历长周期沉淀，不预设。
 */
export function buildOpcPersonaPromptSection(personaDigest: string | null): string | null {
  const digest = personaDigest?.trim();
  if (!digest) return null;
  const clipped =
    digest.length > OPC_PERSONA_DIGEST_LIMIT
      ? digest.slice(0, OPC_PERSONA_DIGEST_LIMIT) + "…"
      : digest;
  return [
    "## 你的行事风格画像（来自长期工作的沉淀）",
    "",
    clipped,
    "",
    "（以上画像由你的历史工作沉淀而来，供参考而非硬约束；发现与当前任务不符时以任务为准。）",
  ].join("\n");
}

/**
 * 委派 prompt 的「持久记忆」段：MEMORY.md 索引全文 + 维护指令。
 * 索引缺失（新员工）时仅声明目录与职责。
 */
export function buildOpcEmployeeMemoryPromptSection(input: {
  memoryDirDisplay: string;
  memoryIndex: string | null;
}): string {
  const indexBlock = input.memoryIndex?.trim()
    ? `【你的 MEMORY.md 索引（当前内容）】\n${input.memoryIndex.trim()}`
    : "【你的 MEMORY.md 索引】当前为空——这是你早期的工作阶段，随着任务积累逐步建立。";
  return [
    "## 持久记忆",
    "",
    `你有自己的持久记忆目录：\`${input.memoryDirDisplay}/\`（跨任务保留，属于你个人）。`,
    "记忆格式：一个事实一个 markdown 文件（frontmatter 含 name/description，",
    "type 取 user/feedback/project/reference），并在 MEMORY.md 中维护一行索引。",
    "",
    indexBlock,
    "",
    "本次任务中值得长期记住的事实（用户偏好、项目约束、反复出现的模式），请在任务",
    "收口时写入记忆目录并同步 MEMORY.md 索引行；已存在但发生变化的记忆要更新而非新建。",
  ].join("\n");
}


/** 反思轮的输入：记忆清单与返工信号（由触发方从 state 组装）。 */
export interface OpcReflectionInput {
  employeeName: string;
  /** MEMORY.md 索引全文（可能为空=早期阶段） */
  memoryIndex: string | null;
  /** 记忆目录里的原则文件名清单（*.md 中 type: principle 的 name 集合） */
  existingPrinciples: readonly string[];
  /** 本轮收口工作项的返工次数合计（负反馈信号；0 表示无返工） */
  reworkCount: number;
  /** 触发本轮反思的工作项主题（一条一行） */
  finishedTopics: readonly string[];
}

/**
 * 反思会话的委派 prompt（金字塔 L2 归纳 + L4 人格更新，员工自己执行）：
 * 通读记忆目录 → 重复模式归纳为原则（≥2 条证据）→ 更新被证实/证伪的原则 →
 * 更新 persona 行为倾向 → 同步 MEMORY.md。产出全部经 Write/Edit 落盘。
 */
export function buildOpcReflectionPrompt(input: OpcReflectionInput): string {
  const principles = input.existingPrinciples.length
    ? input.existingPrinciples.map((p) => "- " + p).join("\n")
    : "（尚无原则文件——出现重复模式时建立第一批）";
  const reworkNote =
    input.reworkCount > 0
      ? "\n本轮收口的工作项中有 " + input.reworkCount + " 次返工记录——请重点检查相关记忆/原则是否存在误导，需要修正就修正。"
      : "";
  return [
    "（" + input.employeeName + "的记忆整理时间）这是你自己的记忆反思轮：通读你的记忆目录，",
    "把重复出现的模式归纳为原则，并更新你的行事风格画像。这是你的长期记忆维护，放心写。",
    "",
    "【你的 MEMORY.md 索引（当前内容）】",
    input.memoryIndex?.trim() || "（空——尚无记忆文件）",
    "",
    "【已有原则文件】",
    principles,
    "",
    "【本轮收口的工作项】",
    ...input.finishedTopics.map((t) => "- " + t),
    reworkNote,
    "",
    "任务：",
    "1. 通读记忆目录全部文件（含 frontmatter type: principle 的原则文件）。",
    "2. 归纳：同一条经验/模式在 ≥2 处出现时，写成一条原则文件（type: principle，",
    "   正文用 [[双链]] 引用支持它的证据记忆；不足两条证据不要造原则）。",
    "3. 修订：已有原则被新经历证实（补证据链接）或证伪（改写/删除）时就地更新。",
    "4. 画像：persona.md 的行为倾向小节按最新经历更新（每条倾向后注明依据；",
    "   新倾向标「暂定」，被再次证实后升「确认」）。",
    "5. 同步 MEMORY.md 索引（新增/变更的行）。",
    "6. 节制：没有真正的模式就不要制造原则；这是整理，不是创作。",
    "",
    "全部产出用 Write/Edit 写入你的记忆目录（这是你唯一允许写的位置），",
    "完成后回复 done 与一句话变更摘要。",
  ].join("\n");
}

