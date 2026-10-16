/**
 * zcode-go OPC prompt 构造（纯函数）。
 *
 * 三类 prompt 都注入足够上下文让一个普通 agent 会话完成任务：
 * - 委派：角色人设 + 挂接技能 + 私人经验 + 工作项验收标准（Self-Run）；
 * - 复盘：要求输出 ```opc-lessons 围栏 JSON（Self-Grown 的蒸馏入口）；
 * - 技能升级：注入当前正文，要求输出 ````opc-skill 围栏新正文（技能自主迭代）。
 */
import {
  OPC_LESSONS_FENCE,
  OPC_SKILL_FENCE,
  type OpcDelegationPromptInput,
} from "./opc-types.js";

const MAX_SKILL_BODIES = 4;

/**
 * 完成标记：agent 验收自查通过后在回复末尾单独一行输出（委派 prompt 注入约定）。
 * round = 返工轮次（reworkNotes.length）：标记携带轮次后缀，done watcher 的
 * 去重键才能在「返工后旧标记仍在扫描窗」时正确等待新一轮的完成——
 * 不带轮次的固定标记会让返工刚发出就被旧标记推回 review（闭环失效）。
 */
export function buildOpcDoneMarker(workItemId: string, round = 0): string {
  return `<!-- zcode-go:opc-done ${workItemId}:r${round} -->`;
}

export interface OpcDoneMarkerHit {
  id: string;
  /** 返工轮次；旧格式（无后缀）为 0。 */
  round: number;
}

/** 从文本中提取完成标记（重复/多个标记都收集，兼容无轮次的旧格式）。 */
export function extractOpcDoneMarkers(text: string): OpcDoneMarkerHit[] {
  const hits: OpcDoneMarkerHit[] = [];
  const pattern = /<!--\s*zcode-go:opc-done\s+([\w-]+?)(?::r(\d+))?\s*-->/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match[1]) {
      hits.push({ id: match[1], round: match[2] ? Number(match[2]) : 0 });
    }
    match = pattern.exec(text);
  }
  return hits;
}

/** 从文本中提取完成标记的工作项 id（重复/多个标记都收集）。 */
export function extractOpcDoneMarkerIds(text: string): string[] {
  return [...new Set(extractOpcDoneMarkers(text).map((hit) => hit.id))];
}

export function buildOpcDelegationPrompt(
  input: OpcDelegationPromptInput,
): string {
  const { employee, workItem } = input;
  const sections: string[] = [];
  sections.push(
    `你是「${input.companyName}」的员工 ${employee.emoji} ${employee.name}（${employee.category}/${employee.seniority}）。`,
  );
  if (employee.vibe) sections.push(`你的人设：${employee.vibe}`);
  if (input.roleBody) {
    sections.push("## 你的角色说明书", "", input.roleBody.trim());
  }
  if (input.skillBodies.length > 0) {
    sections.push("## 你掌握的技能（务必遵循其中的方法论）");
    for (const skill of input.skillBodies.slice(0, MAX_SKILL_BODIES)) {
      sections.push(
        "",
        `### 技能：${skill.name}（${skill.id}）`,
        "",
        skill.body.trim(),
      );
    }
    if (input.skillNamesRemaining.length > 0) {
      sections.push(
        "",
        `另有以下技能可按需使用：${input.skillNamesRemaining.join("、")}。`,
      );
    }
  }
  if (input.recentLessons.length > 0) {
    sections.push(
      "## 你的经验教训（来自过往复盘，必须优先遵循）",
      "",
      ...input.recentLessons.map((lesson) => `- ${lesson}`),
      "",
      `完整经验档案：${input.memoryFilePath}（如可读文件请先读取）。`,
    );
  }
  sections.push(
    "## 本次任务",
    "",
    `**${workItem.title}**（优先级：${workItem.priority}）`,
  );
  if (workItem.detail.trim().length > 0) {
    sections.push("", "### 背景与验收标准", "", workItem.detail.trim());
  }
  if (workItem.dependsOn.length > 0) {
    // 裸 id 对 agent 无意义：带标题映射（allWorkItems 由调用方传入，缺省退化为裸 id）
    const titleById = new Map(
      (input.allWorkItems ?? []).map((item) => [item.id, item.title]),
    );
    const deps = workItem.dependsOn
      .map((id) => (titleById.get(id) ? `${titleById.get(id)}（${id}）` : id))
      .join("、");
    sections.push("", `注意：本任务依赖以下前置工作项的产出：${deps}。`);
  }
  const permission = input.permissionLevel ?? "workspace-write";
  const permissionText =
    permission === "read-only"
      ? "只读：本任务仅允许分析与建议，不得创建、修改或删除任何文件，不得执行任何变更类命令。"
      : permission === "full-access"
        ? "完全访问：可执行必要的系统操作；但删除/重置/外发等破坏性动作仍必须升级所有者确认，不得自行执行。"
        : "工作区写：仅允许读写当前工作区内的文件与执行安全的本地命令，不得触达工作区之外的任何资源。";
  sections.push(
    "",
    "## 权限边界（必须遵守）",
    "",
    `你的权限级别：${permission}。${permissionText}`,
    "超出边界的动作一律不要执行，列入「升级给所有者」的清单并说明原因。",
  );
  if (input.reworkNotes && input.reworkNotes.length > 0) {
    sections.push(
      "",
      "## 返工意见（上一轮验收未通过，必须逐条解决）",
      "",
      ...input.reworkNotes.map((note, index) => `${index + 1}. ${note}`),
    );
  }
  sections.push(
    "",
    "## 执行要求",
    "",
    "- 以角色说明书的方法论完成任务，交付物直接给出（文档/代码/方案等）。",
    "- 结束前自查验收标准逐条是否满足，并在回复末尾给出「完成情况核对清单」。",
    "- 若发现超出你权限的事项，明确列出并升级给所有者决策，不要自行扩大范围。",
    `- 完成判定：仅当上述验收标准全部满足时，在回复的最后一行单独输出标记 ${buildOpcDoneMarker(workItem.id, input.reworkNotes?.length ?? 0)}；未完全满足则不要输出该标记，改为列出缺口清单。该标记会驱动看板自动把本项转入待验收。`,
  );
  return sections.join("\n");
}

export function buildOpcRetroPrompt(input: {
  employeeName: string;
  workItemTitle: string | null;
}): string {
  const scope = input.workItemTitle
    ? `工作项「${input.workItemTitle}」`
    : "近期工作";
  return [
    `请以 ${input.employeeName} 的身份，对${scope}做一次简短复盘。`,
    "",
    "复盘要求：",
    "- 只提炼「可复用、可执行」的经验教训（方法论、避坑清单、偏好约定），不写流水账；",
    "- 每条经验一句话，并打 1-3 个主题标签（如 testing、communication、deploy）；",
    "- 严格只输出以下 JSON 围栏块，不要输出其他内容：",
    "",
    "```" + OPC_LESSONS_FENCE,
    '{ "lessons": [ { "statement": "一句话经验", "tags": ["标签"] } ], "summary": "一段话总结" }',
    "```",
  ].join("\n");
}

export function buildOpcSkillUpgradePrompt(input: {
  skillName: string;
  currentBody: string;
  goal?: string;
}): string {
  return [
    `请迭代升级技能「${input.skillName}」。当前版本正文如下：`,
    "",
    "````" + "markdown",
    input.currentBody.trim(),
    "````",
    "",
    "升级要求：",
    input.goal
      ? `- 升级目标：${input.goal}`
      : "- 根据你积累的最新经验，增强该技能的方法论（补充工作流、边界、反模式）；",
    "- 保持 SKILL.md 结构（frontmatter 之外的正文），只增不改既有正确内容；",
    "- 必须用四反引号围栏输出完整的新正文（因为正文里可能包含三反引号代码块）：",
    "",
    "````" + OPC_SKILL_FENCE,
    "<完整的 SKILL.md 新正文>",
    "````" + OPC_SKILL_FENCE,
  ].join("\n");
}

export function buildOpcIntegrationPrompt(input: {
  completedTitle: string;
  completedDetail: string;
  /** 下游被依赖项（标题 + 负责人名）。 */
  dependents: Array<{ title: string; assigneeName: string | null }>;
}): string {
  const sections: string[] = [
    "以下是刚完成的工作项产出，请把它的成果整合进后续工作：",
    "",
    `## 已完成：${input.completedTitle}`,
  ];
  if (input.completedDetail.trim().length > 0) {
    sections.push("", input.completedDetail.trim());
  }
  if (input.dependents.length > 0) {
    sections.push(
      "",
      "## 依赖本项产出的后续工作项",
      "",
      ...input.dependents.map((dependent) => {
        const assignee = dependent.assigneeName
          ? `（负责人：${dependent.assigneeName}）`
          : "";
        return `- ${dependent.title}${assignee}`;
      }),
      "",
      "整合要求：梳理已完成产出中对上述后续项可直接复用的部分（结论/文档/代码/数据），",
      "指出各项应从哪里接续、需要注意的前置假设，并明确下一步动作建议。",
    );
  } else {
    sections.push(
      "",
      "当前没有登记的下游依赖项；请把可复用的产出整理成一段可直接归档引用的摘要。",
    );
  }
  return sections.join("\n");
}

/** 项目级复盘 prompt：全员维度，经验逐条归属到员工（opc-lessons 扩展 employee 字段）。 */
export function buildOpcProjectRetroPrompt(input: {
  companyName: string;
  employees: Array<{ name: string; category: string }>;
  recentWorkItems: Array<{ title: string; status: string }>;
}): string {
  const employeeNames = input.employees
    .map((employee) => employee.name)
    .join("、");
  const lines = [
    `请对「${input.companyName}」做一次项目级复盘：回顾近期全部工作项，按以下在职员工逐人提炼经验教训。`,
    "",
    `在职员工：${employeeNames}`,
  ];
  if (input.recentWorkItems.length > 0) {
    lines.push(
      "",
      "近期工作项：",
      ...input.recentWorkItems
        .slice(-12)
        .map((item) => `- ${item.title}（${item.status}）`),
    );
  }
  lines.push(
    "",
    "复盘要求：",
    "- 每条经验标注归属员工（employee 字段，必须是上述在职员工之一；公司级流程经验归属创始人）；",
    "- 只提炼可复用、可执行的经验，不写流水账；",
    "- 严格只输出以下 JSON 围栏块：",
    "",
    "```" + OPC_LESSONS_FENCE,
    '{ "lessons": [ { "statement": "一句话经验", "tags": ["标签"], "employee": "员工姓名" } ] }',
    "```",
  );
  return lines.join("\n");
}
