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

/** 完成标记：agent 验收自查通过后在回复末尾单独一行输出（委派 prompt 注入约定）。 */
export function buildOpcDoneMarker(workItemId: string): string {
  return `<!-- zcode-go:opc-done ${workItemId} -->`;
}

/** 从文本中提取完成标记的工作项 id（重复/多个标记都收集）。 */
export function extractOpcDoneMarkerIds(text: string): string[] {
  const ids: string[] = [];
  const pattern = /<!--\s*zcode-go:opc-done\s+([\w:-]+)\s*-->/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match[1]) ids.push(match[1]);
    match = pattern.exec(text);
  }
  return ids;
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
    sections.push(
      "",
      `注意：本任务依赖以下前置工作项的产出：${workItem.dependsOn.join("、")}。`,
    );
  }
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
    `- 完成判定：仅当上述验收标准全部满足时，在回复的最后一行单独输出标记 ${buildOpcDoneMarker(workItem.id)}；未完全满足则不要输出该标记，改为列出缺口清单。该标记会驱动看板自动把本项转入待验收。`,
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
