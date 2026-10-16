/**
 * zcode-go OPC 记忆压缩（模型特定编码试验，spec「设计思想吸收」节的延伸）。
 *
 * 思想来源：提示词诱导的模型特定编码——让单一基模把自然语言记忆压缩成
 * 只有它自己（同模型同版本）能可靠解码的紧凑表示；模型指纹（本模式「模型
 * 指纹」节）是该方案的安全前提：编码时锁定指纹，指纹变动即「乱码可能
 * 不可解码」的信号，触发重新编码。
 *
 * 纯逻辑零 IO：提示构造、事实核查评分、压缩率计算。模型调用由试验脚本
 * 或员工会话驱动。
 */

/** 事实核查条目：解码后用于逐条验证信息恢复率。 */
export interface OpcMemoryFact {
  /** 事实编号（对应原文中的关键信息点）。 */
  id: string;
  /** 提问（解码验证用）。 */
  question: string;
  /** 期望在答案中出现的关键词（全部命中才算恢复）。 */
  expectKeywords: string[];
}

/** 压缩策略：不同诱导方向的编码提示。 */
export type OpcMemoryCompressStrategy =
  | "self-symbolic" // 自创符号/代号协议（模型内部隐式 codebook，不输出对照表）
  | "telegraphic" // 极限电报体（语法全剥，只留信息素）
  | "mixed-cipher"; // 混合编码（缩写/拼音首字母/数字代号/符号分隔）

const ENCODE_INSTRUCTIONS: Record<OpcMemoryCompressStrategy, string> = {
  "self-symbolic": [
    "把下面的原文压缩成一种只有你自己能可靠理解的紧凑表示：",
    "可以使用你偏好的任意符号、缩写、代号、分隔约定——不需要人类可读，",
    "不需要输出任何对照表或解释。唯一要求：稍后把这段压缩文本单独交还给你时，",
    "你必须能凭它完整还原原文的全部关键事实。目标长度：不超过原文的 40%。",
  ].join("\n"),
  telegraphic: [
    "把下面的原文压缩成极限电报体：剥掉全部语法成分（的/了/地/标点/连接词），",
    "只保留信息素（实体、数量、动作、关系、修饰）。目标长度不超过原文的 35%，",
    "要求稍后能凭它还原原文的全部关键事实。",
  ].join("\n"),
  "mixed-cipher": [
    "把下面的原文编码成混合紧凑形式：可用拼音首字母、数字代号、单字符符号、",
    "自选分隔符，混用任意你觉得对自身解码最稳的表示。目标长度不超过原文的 30%，",
    "要求稍后能凭它还原原文的全部关键事实。",
  ].join("\n"),
};

/** 编码提示：原文 → 模型特定压缩表示。 */
export function buildOpcMemoryEncodePrompt(input: {
  originalText: string;
  strategy: OpcMemoryCompressStrategy;
}): string {
  return [
    ENCODE_INSTRUCTIONS[input.strategy],
    "",
    "【原文】",
    input.originalText,
    "",
    "现在只输出压缩后的表示本身，不要任何解释、前后缀或对照表。",
  ].join("\n");
}

/** 解码提示：压缩表示 → 还原原文全部关键事实。 */
export function buildOpcMemoryDecodePrompt(input: {
  encodedText: string;
  facts: OpcMemoryFact[];
}): string {
  return [
    "下面这段紧凑表示是你此前对一段原文做的压缩（你编码时可以自由使用自己偏好的符号约定）。",
    "请把它解码还原：逐条回答以下问题，答案基于原原文的信息，每条一行，格式「编号. 答案」。",
    "",
    "【压缩表示】",
    input.encodedText,
    "",
    "【问题清单】",
    ...input.facts.map((fact) => `${fact.id}. ${fact.question}`),
    "",
    "只输出问题清单的回答，不要其他内容。若某条确实无法从表示中还原，该条回答「无法还原」。",
  ].join("\n");
}

/** 单条事实的恢复判定：答案包含全部期望关键词（大小写/NFC 不敏感）。 */
export function checkOpcMemoryFact(
  answer: string,
  fact: OpcMemoryFact,
): boolean {
  const normalized = answer.normalize("NFC").toLowerCase();
  return fact.expectKeywords.every((keyword) =>
    normalized.includes(keyword.toLowerCase()),
  );
}

/** 解码回答整体验证：恢复条数 / 恢复率。 */
export function verifyOpcMemoryDecode(
  answersText: string,
  facts: OpcMemoryFact[],
): {
  recovered: number;
  total: number;
  rate: number;
  perFact: Array<{ id: string; recovered: boolean }>;
} {
  const perFact = facts.map((fact) => {
    const answerLine = answersText
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith(`${fact.id}.`));
    return {
      id: fact.id,
      recovered: answerLine ? checkOpcMemoryFact(answerLine, fact) : false,
    };
  });
  const recovered = perFact.filter((item) => item.recovered).length;
  return {
    recovered,
    total: facts.length,
    rate: facts.length > 0 ? recovered / facts.length : 0,
    perFact,
  };
}

/**
 * 压缩率 R（字符代理口径）：编码文本长度 / 原文长度。真实 token 口径应由
 * 调用侧以响应 usage 替换（试验脚本默认字符代理，两者趋势一致）。
 */
export function opcMemoryCompressionRatio(
  encodedText: string,
  originalText: string,
): number {
  if (originalText.length === 0) return 1;
  return encodedText.length / originalText.length;
}

/** 压缩记忆档案：与模型指纹绑定的压缩记录（OPC 记忆的压缩形态）。 */
export interface OpcCompressedMemoryRecord {
  /** 编码时的模型 key（providerId/modelId）——解码必须同模型。 */
  modelKey: string;
  /** 编码时的指纹快照（基线指纹的 capturedAt；指纹变动即重编码信号）。 */
  fingerprintCapturedAt: number;
  strategy: OpcMemoryCompressStrategy;
  /** 压缩表示本身。 */
  encodedText: string;
  /** 压缩率（字符代理）。 */
  ratio: number;
  /** 编码时验证的恢复率（自检）。 */
  decodeRate: number;
  facts: OpcMemoryFact[];
  createdAt: number;
}
