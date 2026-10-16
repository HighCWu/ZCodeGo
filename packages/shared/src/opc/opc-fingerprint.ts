/**
 * zcode-go OPC 模型指纹（同 ID 模型变动检测，spec「模型指纹」节）。
 *
 * 方法吸收 ToseaAI/llm-fingerprint-detector（一词回答行为分布 + JSD 三带
 * 判定）与 xqy2006/ModelTrace（挑战式探测思路）。纯逻辑零 IO：探测电池、
 * 答案归一化、分布、JSD、比对 verdict——采集编排（无界面会话驱动）在
 * desktop main，展示与处置在 UI。
 *
 * 判定前提：基线与复测必须同配置采集（zcode 会话自带 system 前缀不影响
 * 自比对——两侧前缀一致；跨端点对照不在本设计内）。
 */
import { opcSlugify } from "./opc-template-format.js";
import type {
  OpcFingerprintVerdict,
  OpcModelFingerprint,
  OpcProbeCellStats,
  OpcProbeDomain,
} from "./opc-types.js";

export interface OpcProbeCell {
  /** 格键（进指纹与比对；任务×语言）。 */
  key: string;
  domain: OpcProbeDomain;
  /** 指令要求（进探测 prompt 的领域提示）。 */
  ask: { en: string; zh: string };
  /** 改写池：轮换使用，防网关对固定字符串特判。 */
  variants: string[];
}

/** 8 核心格（llm-fingerprint-detector 的可选 8 格核心电池；spec「模型指纹」节）。
 * 每格 10 个改写变体 = 会话样本数：同会话内无重复提问——重复同题会诱发
 * 模型刻意换答案，破坏独立采样假设。 */
export const OPC_PROBE_CELLS: OpcProbeCell[] = [
  {
    key: "random-number-1-100:en",
    domain: "number100",
    ask: { en: "Name a random number between 1 and 100", zh: "" },
    variants: [
      "Pick a random number from 1 to 100. Reply with the number only.",
      "Give me one random integer in the range 1..100. Number only, no words.",
      "Random number between 1 and 100? Answer with just the number.",
      "Say one random whole number from 1 through 100. Only the number.",
      "Choose a random number in [1, 100]. Output the bare number.",
      "Think of a random number from 1 to 100. Reply with just that number.",
      "Give a uniformly random integer between 1 and 100. Only digits.",
      "Name any number from 1-100 at random. Just the number, nothing else.",
      "What random number between 1 and 100 do you pick? Bare number.",
      "Random int in 1..100: respond with the number alone.",
    ],
  },
  {
    key: "random-number-1-100:zh",
    domain: "number100",
    ask: { en: "", zh: "在 1 到 100 之间随机说一个数" },
    variants: [
      "从 1 到 100 随机选一个数。只回答数字本身。",
      "随机给我一个 1～100 的整数。只写数字，不要任何解释。",
      "1 到 100 之间随便说个数。只输出这个数。",
      "请在 1-100 内随机报一个整数。只回数字。",
      "随机想一个 1～100 的数字，只把数字发给我。",
      "在区间 [1,100] 内随机挑一个整数。只写数字。",
      "随便说一个介于 1 和 100 之间的数。只回数字本身。",
      "给我一个 1 到 100 的随机整数，不要单位不要解释。",
      "1～100 中随机取一个数。答案只包含数字。",
      "从 1、2、…、100 里随机报一个。只输出数字。",
    ],
  },
  {
    key: "favorite-number:en",
    domain: "favoriteNumber",
    ask: { en: "What is your favorite number?", zh: "" },
    variants: [
      "What's your favorite number? Reply with the number only.",
      "Tell me your favourite single number. Number only.",
      "Which number do you like most? Just the number.",
      "Pick the number you like best. Output the bare number.",
      "Name the number you like the most. Digits only.",
      "What number do you consider your lucky number? Just digits.",
      "Your preferred number, please. Reply with the number alone.",
      "State your go-to number. Only the number, no words.",
      "Which single number is your favorite? Bare digits.",
      "Answer with the number you'd choose as favorite. Number only.",
    ],
  },
  {
    key: "color:en",
    domain: "color",
    ask: { en: "Name a random color", zh: "" },
    variants: [
      "Name a random color. One word only.",
      "Say a color at random. Just the color name.",
      "Give me one color word, chosen randomly.",
      "Pick any color. Reply with the color name only.",
      "Think of a random color and say it. One word.",
      "A random color, please — just the word.",
      "Which color comes to mind first? Only the color name.",
      "Name one color at random. Bare word.",
      "Choose a random color and output its name only.",
      "Random color word: respond with just that word.",
    ],
  },
  {
    key: "letter:en",
    domain: "letter",
    ask: { en: "Name a random letter", zh: "" },
    variants: [
      "Name a random letter of the alphabet. One letter only.",
      "Say a random letter. Just the letter.",
      "Pick a random A–Z letter. Output that single letter.",
      "Give me one random letter. Only the letter character.",
      "Think of a random letter and reply with it alone.",
      "A random letter A-Z, please. Just that one character.",
      "Which letter do you pick at random? Single letter only.",
      "Name any letter from the alphabet. One character.",
      "Random letter: output just the letter itself.",
      "Choose one letter of 26 at random. Reply with that letter.",
    ],
  },
  {
    key: "coin:en",
    domain: "coin",
    ask: { en: "Flip a coin", zh: "" },
    variants: [
      "Flip a coin. Reply heads or tails.",
      "Toss a fair coin — what came up? One word.",
      "Random coin flip: heads or tails? Answer with one word.",
      "Call a coin toss. Just say heads or tails.",
      "A coin lands randomly: heads or tails? One word answer.",
      "Imagine flipping a coin. Report heads or tails.",
      "Heads or tails? Pick randomly and answer with one word.",
      "Fair coin toss result? Reply with just heads or tails.",
      "Randomize a coin flip and tell me the side. One word.",
      "Coin flip time: answer heads or tails only.",
    ],
  },
  {
    key: "city:en",
    domain: "city",
    ask: { en: "Name a random city", zh: "" },
    variants: [
      "Name a random city. One word only.",
      "Say a city at random. Just the city name.",
      "Give me one city, picked randomly. Only the name.",
      "Pick any city in the world. Reply with its name only.",
      "Think of a random city and say its name. One word if possible.",
      "A random city, please — just the name.",
      "Which city comes to mind first? Only the city name.",
      "Name one city at random. Bare name.",
      "Choose a random city and output its name only.",
      "Random city word: respond with just that name.",
    ],
  },
  {
    key: "animal:en",
    domain: "animal",
    ask: { en: "Name a random animal", zh: "" },
    variants: [
      "Name a random animal. One word only.",
      "Say an animal at random. Just the animal name.",
      "Give me one animal, picked randomly.",
      "Pick any animal. Reply with the name only.",
      "Think of a random animal and say it. One word.",
      "A random animal, please — just the name.",
      "Which animal comes to mind first? Only the name.",
      "Name one animal at random. Bare word.",
      "Choose a random animal and output its name only.",
      "Random animal: respond with just that name.",
    ],
  },
];

export interface OpcProbeSessionPlan {
  cell: OpcProbeCell;
  /** 会话内顺序提出的变体（轮换取样）。 */
  prompts: string[];
}

/** 组一次格采集：每格一个会话，count 个改写变体顺序提问。 */
export function planOpcProbeSession(
  cell: OpcProbeCell,
  count = 10,
  variantOffset = 0,
): OpcProbeSessionPlan {
  const prompts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    prompts.push(cell.variants[(variantOffset + i) % cell.variants.length]!);
  }
  return { cell, prompts };
}

/**
 * 组会话 prompt（文件中转契约）：headless 会话的回复没有轻量读取面
 * （sendPrompt 是异步投递），改为要求 agent 把答案 JSON 写到指定文件，
 * 采集端轮询读取。回答阶段仍逐题一词（独立采样），写文件只是转录。
 */
export function buildOpcProbeSessionPrompt(
  plan: OpcProbeSessionPlan,
  outputPath: string,
): string {
  const askLine =
    plan.cell.ask.zh.length > 0 ? plan.cell.ask.zh : plan.cell.ask.en;
  const lines = [
    `Answer the following ${plan.prompts.length} short prompts. Rules: think each answer as a single word (or a number) chosen independently — no explanation.`,
    "",
    ...plan.prompts.map((prompt, i) => `${i + 1}. ${prompt}`),
    "",
    `After deciding all ${plan.prompts.length} answers, use the Write tool to create this exact file (the ONLY file you may write):`,
    outputPath,
    "",
    "File content must be exactly this JSON shape:",
    '{"answers": ["<answer 1>", "<answer 2>", ...]}',
    "",
    `Answers array order matches the prompts above, length ${plan.prompts.length}, each entry a single word or number only.${
      askLine ? ` (Domain: ${askLine}.)` : ""
    }`,
    "Do not write any other file. After writing, reply with just: done",
  ];
  return lines.join("\n");
}

/** 解析会话回复：剥「1.」「-」等行前缀、滤空行，产出与变体对齐的原始答案。 */
export function parseOpcProbeAnswers(text: string, expected: number): string[] {
  const answers: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length === 0) continue;
    answers.push(line);
    if (answers.length >= expected) break;
  }
  return answers;
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const EN_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

/** 中文数字 0–100 → 阿拉伯数字（七十五→75、一百→100）；失败返回 null。 */
function parseCnNumber(text: string): number | null {
  const t = text.trim();
  if (t.length === 0) return null;
  if (t === "一百" || t === "百") return 100;
  let total = 0;
  let current = 0;
  let matched = false;
  for (const ch of t) {
    // 十/百是乘数位，不在 digit 表——先判乘数再查数字，否则提前 return
    if (ch === "十") {
      matched = true;
      total += (current === 0 ? 1 : current) * 10;
      current = 0;
      continue;
    }
    if (ch === "百") {
      matched = true;
      total += (current === 0 ? 1 : current) * 100;
      current = 0;
      continue;
    }
    const digit = CN_DIGITS[ch];
    if (digit === undefined) return matched ? total : null;
    matched = true;
    current = current * 10 + digit;
  }
  total += current;
  return matched ? total : null;
}

function parseLooseNumber(text: string): number | null {
  const t = text
    .normalize("NFKC")
    .trim()
    .replace(/[。．,，]$/g, "");
  const cn = parseCnNumber(t);
  if (cn !== null) return cn;
  const asInt = Number.parseInt(t, 10);
  if (Number.isFinite(asInt)) return asInt;
  // 英文数字词：一词回答场景取首个数字词（组合词 "twenty five" 不在
  // 探测口径内——回归到首词映射，避免 "one hundred" 误算 101）
  for (const w of t
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)) {
    const v = EN_NUMBERS[w];
    if (v !== undefined) return v;
  }
  return null;
}

const COLOR_MAP: Record<string, string> = {
  red: "red",
  红色: "red",
  红: "red",
  crimson: "crimson",
  blue: "blue",
  蓝色: "blue",
  蓝: "blue",
  green: "green",
  绿色: "green",
  绿: "green",
  yellow: "yellow",
  黄色: "yellow",
  黄: "yellow",
  purple: "purple",
  紫色: "purple",
  紫: "purple",
  orange: "orange",
  橙色: "orange",
  橙: "orange",
  black: "black",
  黑色: "black",
  黑: "black",
  white: "white",
  白色: "white",
  白: "white",
  gray: "gray",
  grey: "gray",
  灰色: "gray",
  灰: "gray",
  pink: "pink",
  粉色: "pink",
  粉: "pink",
  brown: "brown",
  棕色: "brown",
  褐色: "brown",
  cyan: "cyan",
  青色: "cyan",
  青: "cyan",
};

const COIN_MAP: Record<string, string> = {
  heads: "heads",
  head: "heads",
  正面: "heads",
  正: "heads",
  tails: "tails",
  tail: "tails",
  反面: "tails",
  反: "tails",
};

/**
 * 答案归一化（detector 的 normalizeAnswer 口径）：NFC、去标点、首词、
 * 数字统一（seven/七→7）、颜色与硬币词规范化。返回空串 = 无效样本。
 */
export function normalizeOpcProbeAnswer(
  raw: string,
  domain: OpcProbeDomain,
): string {
  const text = raw.normalize("NFC").trim();
  if (text.length === 0) return "";
  if (domain === "number100" || domain === "favoriteNumber") {
    const n = parseLooseNumber(text);
    if (n === null) {
      // 引号/括号内数字兜底
      const m = text.match(/\d+/);
      return m ? m[0] : "";
    }
    return String(n);
  }
  const firstWord =
    text
      .replace(/^[^A-Za-z\u4e00-\u9fa50-9]+/, "")
      .split(/[\s,，.。!！?？、;；:："'"'"()（）\[\]]+/)
      .filter((part) => part.length > 0)[0] ?? text;
  const key = firstWord.toLowerCase();
  if (domain === "color") {
    if (COLOR_MAP[key]) return COLOR_MAP[key]!;
    if (COLOR_MAP[firstWord]) return COLOR_MAP[firstWord]!;
    return key.length > 0 && /^[a-z]+$/.test(key) ? key : "";
  }
  if (domain === "coin") {
    if (COIN_MAP[key]) return COIN_MAP[key]!;
    if (COIN_MAP[firstWord]) return COIN_MAP[firstWord]!;
    return "";
  }
  if (domain === "letter") {
    const m = text.toLowerCase().match(/\b([a-z])\b/);
    if (m) return m[1]!;
    const single = key.match(/^([a-z])/);
    return single ? single[1]! : "";
  }
  // city / animal：NFC + 全串 slug 化（城市/动物名可多词：New York、
  // polar bear——首词切分会把 "New York" 拆成 "new" 造成分布失真）
  const slug = opcSlugify(text);
  return slug.length > 0 ? slug : key;
}

export function opcAnswerDistribution(
  samples: string[],
  domain: OpcProbeDomain,
): OpcProbeCellStats {
  const counts: Record<string, number> = {};
  let invalid = 0;
  for (const sample of samples) {
    const normalized = normalizeOpcProbeAnswer(sample, domain);
    if (normalized.length === 0) {
      invalid += 1;
      continue;
    }
    counts[normalized] = (counts[normalized] ?? 0) + 1;
  }
  return {
    domain,
    counts,
    valid: samples.length - invalid,
    invalid,
    raw: samples.length,
  };
}

/** Jensen-Shannon 散度（base 2，0–1 bit；detector 口径）。 */
export function opcJensenShannonDivergence(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  const totalA = Object.values(a).reduce((x, y) => x + y, 0);
  const totalB = Object.values(b).reduce((x, y) => x + y, 0);
  if (totalA === 0 || totalB === 0) return 1;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const pa = new Map<string, number>();
  const pb = new Map<string, number>();
  for (const key of keys) {
    pa.set(key, (a[key] ?? 0) / totalA);
    pb.set(key, (b[key] ?? 0) / totalB);
  }
  const kl = (p: Map<string, number>, q: Map<string, number>): number => {
    let acc = 0;
    for (const [key, pv] of p) {
      const qv = q.get(key) ?? 0;
      if (pv === 0) continue;
      const m = (pv + qv) / 2;
      acc += pv * Math.log2(pv / m);
    }
    return acc;
  };
  return 0.5 * kl(pa, pb) + 0.5 * kl(pb, pa);
}

export interface OpcFingerprintComparison {
  meanJsd: number;
  comparedCells: number;
  perCell: Array<{ cell: string; jsd: number; valid: number }>;
  verdict: OpcFingerprintVerdict;
}

/** 比对两份指纹：逐格 JSD（两侧 valid ≥ minValid 的格）→ 平均 → 三带 verdict。 */
export function compareOpcFingerprints(
  baseline: OpcModelFingerprint,
  current: OpcModelFingerprint,
  minValid = 6,
): OpcFingerprintComparison {
  const perCell: OpcFingerprintComparison["perCell"] = [];
  for (const [cell, baseStats] of Object.entries(baseline.cells)) {
    const curStats = current.cells[cell];
    if (!curStats) continue;
    if (baseStats.valid < minValid || curStats.valid < minValid) continue;
    const jsd = opcJensenShannonDivergence(baseStats.counts, curStats.counts);
    perCell.push({
      cell,
      jsd,
      valid: Math.min(baseStats.valid, curStats.valid),
    });
  }
  perCell.sort((x, y) => y.jsd - x.jsd);
  const meanJsd =
    perCell.length > 0
      ? perCell.reduce((acc, item) => acc + item.jsd, 0) / perCell.length
      : 1;
  const verdict: OpcFingerprintVerdict =
    perCell.length === 0
      ? "uncertain"
      : meanJsd <= 0.25
        ? "match"
        : meanJsd <= 0.35
          ? "uncertain"
          : "mismatch";
  return { meanJsd, comparedCells: perCell.length, perCell, verdict };
}
