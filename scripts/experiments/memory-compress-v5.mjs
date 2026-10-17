#!/usr/bin/env node
/**
 * OPC 记忆压缩试验 v5（token 感知定版）：目标 R_token ≈ 0.10-0.17（≤30 tokens，
 * 硬上限 35），编码产物送入无编码上下文的独立新会话解码验证。
 *
 * v4 之后的改造（tokenizer 实测驱动）：
 * - 向模型明示 GLM tokenizer 成本规则：罕见字符（韩文/盲文/生僻字）每字被拆
 *   2-4 token（禁用）；常用汉字 ≈1 token/字；数字/ASCII 2-4 字符 ≈1 token（直存最省）。
 * - token 预算制：脚本用 GLM-5.3-Flash tokenizer 实测产物 token 数并参与反馈判定。
 * - 文字实体用常用汉字形近变体（1 token/字、不可人工回猜）——v4·L2 已实证该
 *   体系可解码（F_core 4/6）。
 * - 长实体（合同编号、邮箱）显式授权丢弃——<25 tokens 的信息论前提。
 * - 解码判定数字归一化（三↔3）修复 v4 的「三期/3期」误杀。
 * 每次调用均为独立 headless 会话（无编码上下文）——「新会话可解码」由该通路
 * 结构性保证。
 *
 * 用法：node scripts/experiments/memory-compress-v5.mjs --cli /tmp/zcode-cli-headless [--out report.md]
 */
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const cliBin = arg("--cli") ?? "zcode";
const model = arg("--model") ?? "(cli 默认模型)";
const outPath = arg("--out");
const TOKENIZER = "/tmp/glm-tokenizer.json";

const ORIGINAL = "上周三（10 月 8 日）我在杭州分公司与供应商林晓峰谈妥了二期合同，金额 187 万元，付款分三期：签约付 40%、交付验收付 50%、质保期满付 10%，质保期 18 个月。合同编号 HT-2026-1108。对方要求我方在 11 月 15 日前提供部署清单，由张明负责对接，他的邮箱是 zhangming@example.com。纸质版一式四份，我方存三份，一份寄回对方法务部（收件人写陈法务）。会议决定把旧版报表系统的下线时间从原定的 12 月 1 日推迟到 12 月 20 日，原因是运营部李婷的团队还在用其中三个报表：日报、周报和库存月报。";

const FACTS = [
  { id: "1", core: true, question: "二期合同的金额是多少？付款分几期？", keywords: ["187", "三期"] },
  { id: "2", core: false, question: "签约阶段付款比例是多少？", keywords: ["40"] },
  { id: "3", core: false, question: "交付验收和质保期满的付款比例是多少？", keywords: ["50", "10"] },
  { id: "4", core: false, question: "质保期多长？", keywords: ["18"] },
  { id: "5", core: false, question: "合同编号是什么？（允许回答「已丢弃」）", keywords: ["ht-2026-1108"], droppable: true },
  { id: "6", core: true, question: "部署清单的截止日期是哪天？", keywords: ["11", "15"] },
  { id: "7", core: true, question: "部署清单由谁负责对接？", keywords: ["张明"] },
  { id: "8", core: false, question: "张明的邮箱是什么？（允许回答「已丢弃」）", keywords: ["zhangming@example.com"], droppable: true },
  { id: "9", core: true, question: "旧报表系统的下线时间推迟到了哪天？", keywords: ["12", "20"] },
  { id: "10", core: true, question: "哪个团队还在用旧报表？负责人是谁？", keywords: ["李婷"] },
];

// ── GLM tokenizer 计数（python tokenizers） ──
function countTokens(text) {
  const proc = spawnSync("python3", ["-c", `
from tokenizers import Tokenizer
import sys
tok = Tokenizer.from_file(${JSON.stringify(TOKENIZER)})
print(len(tok.encode(sys.argv[1]).ids))
`, text], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error("tokenizer 失败: " + proc.stderr.slice(0, 120));
  return Number(proc.stdout.trim());
}

// ── CLI headless（每次调用 = 独立新会话，无编码上下文） ──
function zcodeCli(content) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliBin, ["-p", content], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI 超时（600s）")); }, 600_000);
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && stdout.trim().length === 0) reject(new Error(`CLI 退出码 ${code}: ${stderr.slice(0, 200)}`));
      else resolve({ text: stdout });
    });
  });
}

function extractMarked(text, tag) {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  let last = null, m;
  while ((m = pattern.exec(text)) !== null) last = m[1];
  return last?.trim() ?? null;
}

// 中文数字归一化（修「三期/3期」误杀）
const CN_NUM = { 零: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10" };
function normalize(s) {
  let out = s.toLowerCase();
  for (const [cn, num] of Object.entries(CN_NUM)) out = out.split(cn).join(num);
  return out;
}

function judgeAll(answersText) {
  const lines = normalize(answersText).split(/\r?\n/);
  const perFact = FACTS.map((fact) => {
    const line = lines.find((l) => l.trim().startsWith(`${fact.id}.`));
    const answer = (line ?? "").trim();
    const recovered = fact.keywords.every((k) => answer.includes(normalize(k)));
    return {
      id: fact.id,
      core: fact.core,
      droppable: Boolean(fact.droppable),
      recovered,
      answer: answer.slice(0, 70),
    };
  });
  const mandatory = perFact.filter((p) => !p.droppable);
  return {
    perFact,
    full: perFact.filter((p) => p.recovered).length,
    mandatory: mandatory.filter((p) => p.recovered).length,
    mandatoryTotal: mandatory.length,
    failedQuestions: FACTS.filter((f, i) => !perFact[i].recovered && !f.droppable).map((f) => f.question),
  };
}

const CIPHER_RULE = [
  "格式约束：",
  "- 字符集白名单：数字、半角标点（: ; , < > [ ] ( ) / - → 等）、常用汉字。",
  "  禁止韩文、假名、盲文、生僻字、罕见符号（这些字符在 GLM tokenizer 中会被",
  "  拆成多个 token，成本过高）。",
  "- 数字边界：不同事实的数字必须用分隔符隔开（如 187:40-50-10），",
  "  绝不允许数字黏连成一串。",
  "- 文字实体（人名、机构、事件）用常用汉字的形近变体代号（固定偏旁替换/",
  "  笔画增减的私有规则，全文一致），你稍后能按同一规则读回来。",
  "- 先提取事实骨架（谁/何时/多少/什么条件）再编码；合同编号、邮箱这类长串",
  "  直接丢弃。",
  "- 不输出对照表或解释。",
].join("\n");

function buildEncodePrompt(limit) {
  return [
    "把下面的记录压缩成一段紧凑索引：像 gzip 压缩后的数据一样，对不了解编码约定",
    "的人来说是无意义的字符序列（这是压缩格式的自然属性，不承担对抗性保密要求），",
    "而你稍后能凭它还原记录的主要事实。",
    CIPHER_RULE,
    `长度：≤ ${limit.tokens} tokens（原文 178 tokens 的约 ${Math.round((limit.tokens / 178) * 100)}%）。`,
    "在预算内尽量把更多事实编进去。",
    "",
    "【原文】",
    ORIGINAL,
    "",
    "把索引包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function buildFeedbackPrompt(prevEncoded, tokens, failures) {
  return [
    "你此前压缩的索引不达标：",
    "",
    "【上一次的索引】",
    prevEncoded,
    "",
    `1. 实测 ${tokens} tokens（预算 ≤ ${LIMIT.tokens} tokens，硬上限 35）${tokens > 35 ? "——超预算，必须压缩" : "——尚有预算余量，可补入缺失事实"}。`,
    failures.length ? `2. 凭这段索引你无法还原：${failures.join("；")}` : "",
    "",
    "请在原索引基础上改进：已能还原的信息保持原编码不动，只补入缺失事实的编码",
    "（不要整体重写）。仍须满足：字符集白名单、数字边界、长度预算。",
    "",
    "【原文】",
    ORIGINAL,
    "",
    "把新索引包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function buildDecodePrompt(encodedText) {
  return [
    "下面这段密文是你此前对一份记录做的压缩（该记录包含：一份合同的金额与分期付款、",
    "质保期、合同编号；一个部署任务的责任人与截止日期、邮箱；纸质合同的份数与寄回安排；",
    "一个旧系统下线时间的推迟决定、相关团队与负责人）。请解码：逐条回答以下问题。",
    "语法可以自由重组，但具体值（数字、日期、人名）必须给出原文实际值；",
    "无法还原的条目回答「无法还原」；你知道当初约定丢弃的条目回答「已丢弃」。不要编造。",
    "",
    "【密文】",
    encodedText,
    "",
    "【问题清单】",
    ...FACTS.map((f) => `${f.id}. ${f.question}`),
    "",
    "全部回答包在 <ANS> 与 </ANS> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function looksLikeRefusal(text) {
  return /无法|不能|做不到/.test(text) && text.length <= 60;
}

const say = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 主流程 ──
const origTokens = countTokens(ORIGINAL);
say(`原文 ${ORIGINAL.length} 字符 / ${origTokens} tokens · 预算 ≤30（硬上限 35）· 每次调用均为独立新会话`);

let encoded = null;
let tokens = 0;
let verdict = null;
let rounds = 0;
const LIMIT = { tokens: 30 };

for (let round = 1; round <= 4; round += 1) {
  rounds = round;
  const overBudget = encoded !== null && tokens > 35;
  const needRetry = encoded === null || overBudget || (verdict !== null && verdict.mandatory < verdict.mandatoryTotal);
  if (!needRetry) break;
  const prompt =
    encoded === null
      ? buildEncodePrompt(LIMIT)
      : buildFeedbackPrompt(encoded, tokens, verdict.failedQuestions.slice(0, 4));
  try {
    const raw = await zcodeCli(prompt);
    const candidate = extractMarked(raw.text, "ENC") ?? "";
    if (!candidate || looksLikeRefusal(candidate)) {
      say(`[第${round}轮] 模型拒绝/空编码，重试`);
      continue;
    }
    encoded = candidate;
    tokens = countTokens(encoded);
    const decodedRaw = await zcodeCli(buildDecodePrompt(encoded));
    verdict = judgeAll(extractMarked(decodedRaw.text, "ANS") ?? "");
    say(
      `[第${round}轮] 密文 ${encoded.length} 字符 / ${tokens} tokens（R_token=${(tokens / origTokens).toFixed(3)}） F_full=${verdict.full}/${FACTS.length} 必答=${verdict.mandatory}/${verdict.mandatoryTotal}`,
    );
    await sleep(400);
  } catch (error) {
    say(`[第${round}轮] 失败: ${String(error).slice(0, 140)}`);
    break;
  }
}

// 终验：最终密文再送一个全新会话（与编码/此前解码均无共享上下文）
let finalVerdict = verdict;
if (encoded) {
  try {
    const raw = await zcodeCli(buildDecodePrompt(encoded));
    finalVerdict = judgeAll(extractMarked(raw.text, "ANS") ?? "");
    say(`[终验·全新会话] F_full=${finalVerdict.full}/${FACTS.length} 必答=${finalVerdict.mandatory}/${finalVerdict.mandatoryTotal}`);
  } catch (error) {
    say(`[终验] 失败: ${String(error).slice(0, 140)}`);
  }
}

const report = [
  "# OPC 记忆压缩试验 v5（token 感知定版）",
  "",
  `- 模型：${model} · 原文 ${ORIGINAL.length} 字符 / ${origTokens} tokens（GLM-5.3-Flash tokenizer 实测）`,
  `- 预算 ≤30 tokens（10%=18，17%=30）；硬上限 35；编码轮数 ${rounds}`,
  "- 解码验证：每次调用均为独立 headless 新会话（无编码上下文）；终验为最终密文的又一次全新会话。",
  "",
  "## 结果",
  "",
  encoded
    ? [
        `- 密文 ${encoded.length} 字符 / **${tokens} tokens / R_token=${(tokens / origTokens).toFixed(3)}**`,
        `- 解码（终验·全新会话）：F_full=${finalVerdict.full}/${FACTS.length} · 必答事实 ${finalVerdict.mandatory}/${finalVerdict.mandatoryTotal}`,
        "",
        "### 密文全文",
        "",
        "```",
        encoded,
        "```",
        "",
        "### 逐条判定（终验）",
        "",
        ...finalVerdict.perFact.map(
          (p) =>
            `- ${p.id}${p.core ? "★" : ""}${p.droppable ? "°" : ""}. ${p.recovered ? "✓" : "✗"} ${p.answer}`,
        ),
        "",
        "° = 当初授权丢弃的长细节（合同编号/邮箱）",
      ].join("\n")
    : "未获得有效编码。",
  "",
  "## 判读",
  "",
  "- R_token ≤ 0.20 且必答事实全对：token 口径 ~10-17% 压缩 + 独立新会话可解码（协议成立）",
  "- 丢弃项（编号/邮箱）与保留事实的边界即 <25 tokens 的信息论代价",
].join("\n");

if (outPath) writeFileSync(outPath, report);
say("\n" + (outPath ? `报告已写入 ${outPath}` : report));
