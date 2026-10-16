#!/usr/bin/env node
/**
 * OPC 记忆压缩试验 v3：极限骨架密文（无意义化=压缩，一级到位）+ N 级蒸馏。
 *
 * 协议修正（用户指出 v2 假设错误）：「无意义化」与「浓缩」不可兼得是伪二分——
 * gzip 后的二进制对人无意义，但它同时就是压缩。去掉人类可读冗余 = 去掉统计冗余。
 * v1/v2 各组膨胀（R≈2.4-3.0）的根因是模型选错编码对象：翻译全文而非提取事实。
 *
 * v3 编码原理（对齐信息论下限）：
 * 1. 先提取事实骨架（谁/何时/多少/什么条件）——10 条事实 ≈150bit ≈19 字节
 *    ≈25 个 Base64 字符 ≈ 原文的 9%，<10% 在信息论上可行。
 * 2. 数字/日期/编号原样直存（本身即最高效编码，「看似有意义」的合法掺杂）。
 * 3. 文字实体压成 1-3 字符自造代号：须成体系（片段内一致的变换规则，
 *    如固定偏移/部首替换/私有惯用变体），禁纯随机（v1 E 组证明纯随机 F=0），
 *    模型要能顺着规则读回来。
 * 4. 禁原文词汇/拼音/缩写等人类可回猜形态。
 *
 * 级联：L1 每段 ≤12% → L2 联合 ≤原文 10% → L3 蒸馏 ≤原文 5%
 *（每级丢一层细节、保骨架；从最深层解码验证）。
 *
 * 用法：
 *   node scripts/experiments/memory-compress-v3.mjs \
 *     --cli /tmp/zcode-cli-headless [--out report.md]
 */
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const cliBin = arg("--cli") ?? "zcode";
const model = arg("--model") ?? "(cli 默认模型)";
const outPath = arg("--out");

const SEGMENTS = [
  {
    id: "S1",
    text: "上周三（10 月 8 日）我在杭州分公司与供应商林晓峰谈妥了二期合同，金额 187 万元，付款分三期：签约付 40%、交付验收付 50%、质保期满付 10%，质保期 18 个月。合同编号 HT-2026-1108。",
  },
  {
    id: "S2",
    text: "对方要求我方在 11 月 15 日前提供部署清单，由张明负责对接，他的邮箱是 zhangming@example.com。纸质版一式四份，我方存三份，一份寄回对方法务部（收件人写陈法务）。",
  },
  {
    id: "S3",
    text: "会议决定把旧版报表系统的下线时间从原定的 12 月 1 日推迟到 12 月 20 日，原因是运营部李婷的团队还在用其中三个报表：日报、周报和库存月报。",
  },
];
const ORIGINAL_CHARS = SEGMENTS.reduce((sum, seg) => sum + seg.text.length, 0);

const FACTS = [
  { id: "1", seg: "S1", question: "二期合同的金额是多少？付款分几期？", keywords: ["187", "三"], coreKeywords: ["万"] },
  { id: "2", seg: "S1", question: "签约阶段付款比例是多少？", keywords: ["40"] },
  { id: "3", seg: "S1", question: "质保期多长？", keywords: ["18"] },
  { id: "4", seg: "S1", question: "合同编号是什么？", keywords: ["ht-2026-1108"] },
  { id: "5", seg: "S2", question: "部署清单的截止日期是哪天？", keywords: ["11", "15"], coreKeywords: ["11"] },
  { id: "6", seg: "S2", question: "部署清单由谁负责对接？", keywords: ["张明"], coreKeywords: ["张明"] },
  { id: "7", seg: "S2", question: "对接人张明的邮箱是什么？", keywords: ["zhangming@example.com"] },
  { id: "8", seg: "S2", question: "寄回对方法务部的收件人要求写谁？", keywords: ["陈法务"], coreKeywords: ["陈"] },
  { id: "9", seg: "S3", question: "旧版报表系统的下线时间推迟到了哪天？", keywords: ["12", "20"], coreKeywords: ["12"] },
  { id: "10", seg: "S3", question: "哪个团队还在用旧报表系统？负责人是谁？", keywords: ["李婷"], coreKeywords: ["李婷"] },
];

const CIPHER_RULE = [
  "编码原理（如同 gzip：去掉人类可读的冗余，只保留信息本身）——",
  "1. 先在心里列出该片段的事实清单（谁/何时/多少/什么条件），只编码事实，不编码措辞。",
  "2. 数字、日期、编号、金额原样直存（它们本身就是最高效且精确的编码）。",
  "3. 文字实体（人名、机构、事件）压缩成 1-3 字符的自造代号：代号必须成体系——",
  "   片段内用一致的变换规则（例如固定字符偏移、固定部首/字形替换、你惯用的",
  "   私有变体），稍后你要能顺着同一套规则把它们读回来。禁止纯随机串。",
  "4. 产物中不得保留任何原文词汇、拼音首字母、常见缩写等人类可回猜形态",
  "   （数字与编号直存除外——它们属于「看似有意义实则只是数据」的部分）。",
  "5. 不得输出任何对照表、规则说明或解释。",
].join("\n");

function zcodeCli(content) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliBin, ["-p", content], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI 超时（600s）"));
    }, 600_000);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && stdout.trim().length === 0) {
        reject(new Error(`CLI 退出码 ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve({ text: stdout });
      }
    });
  });
}

function extractMarked(text, tag) {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  let last = null;
  let match = pattern.exec(text);
  while (match !== null) {
    last = match[1];
    match = pattern.exec(text);
  }
  return last?.trim() ?? null;
}

function buildEncodePrompt(text, limitChars, label) {
  return [
    `把下面的${label}压缩成一段密文——外部观察者完全无法读懂，`,
    "但稍后把密文单独交还给你时，你必须能凭它还原其中的关键事实。",
    CIPHER_RULE,
    `长度硬上限：${limitChars} 字符（这是压缩目标，超限即失败；尽量更短）。`,
    "",
    "【原文】",
    text,
    "",
    "把密文包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function buildFeedbackEncodePrompt(text, prevEncoded, limitChars, failures, label) {
  const reasons = [];
  if (failures.questions.length) {
    reasons.push(
      `凭这段密文你无法还原：${failures.questions.join("；")}`,
    );
  }
  if (failures.overLimit) {
    reasons.push(`超长（上限 ${limitChars} 字符）`);
  }
  return [
    "你此前的一段压缩密文不达标：",
    "",
    "【上一次的密文】",
    prevEncoded,
    "",
    ...reasons.map((reason, index) => `${index + 1}. ${reason}`),
    "",
    `请重新压缩，同时满足：事实完整可还原、无意义密文形态（成体系代号+数字直存）、`,
    `长度 ≤ ${limitChars} 字符。`,
    "",
    "【原文】",
    text,
    "",
    "把新密文包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function buildDecodePrompt(encodedText, facts, label) {
  return [
    `下面这段密文是你此前对一段${label}做的压缩。请解码：逐条回答以下问题，`,
    "答案基于原文内容。语法可以自由重组，但具体值（数字、日期、人名、编号）必须",
    "给出原文中的实际值；确实无法还原的条目回答「无法还原」，不要编造。",
    "",
    "【密文】",
    encodedText,
    "",
    "【问题清单】",
    ...facts.map((fact) => `${fact.id}. ${fact.question}`),
    "",
    "全部回答包在 <ANS> 与 </ANS> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function buildJointEncodePrompt(items, limitChars) {
  return [
    "下面是同一份原始记录切成的三个片段各自的压缩密文。",
    "请把它们联合压缩成一段更短的密文（把三份密文档案合并成一份总索引），",
    `长度硬上限：${limitChars} 字符（尽量更短）。`,
    "联合后你仍必须能凭它回答关于原始记录的关键事实：主要人物、金额、日期、",
    "事件方向等骨架必须保留；次要细节允许进一步浓缩。",
    CIPHER_RULE,
    "",
    ...items.map((item) => `【片段 ${item.seg} 的密文】\n${item.encoded}`),
    "",
    "把联合密文包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function judgeFact(fact, answersText) {
  const line = answersText
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith(`${fact.id}.`));
  const answer = (line ?? "").toLowerCase();
  const hit = (keywords) => keywords.every((keyword) => answer.includes(keyword.toLowerCase()));
  return {
    full: answer.length > 0 && hit(fact.keywords),
    core: answer.length > 0 && hit(fact.coreKeywords ?? fact.keywords),
    answer: (line ?? "").trim().slice(0, 60),
  };
}

function judgeAll(facts, answersText) {
  const perFact = facts.map((fact) => ({ id: fact.id, ...judgeFact(fact, answersText) }));
  const coreFacts = facts.filter((fact) => fact.coreKeywords);
  return {
    perFact,
    full: perFact.filter((item) => item.full).length,
    core: perFact.filter((item) => item.core).length,
    coreTotal: coreFacts.length || facts.length,
    failedQuestions: facts.filter((_, index) => !perFact[index].full).map((fact) => fact.question),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = [];
const say = (message) => {
  console.log(message);
  log.push(message);
};

// 带反馈迭代的「编码→解码验证」闭环；返回 {encoded, verdict, rounds}
async function encodeWithFeedback(text, facts, limitRatio, label) {
  const limitChars = Math.ceil(text.length * limitRatio);
  let encoded = null;
  let verdict = null;
  for (let round = 1; round <= 3; round += 1) {
    const overLimit = encoded !== null && encoded.length > limitChars;
    const prompt =
      encoded === null
        ? buildEncodePrompt(text, limitChars, label)
        : buildFeedbackEncodePrompt(
            text,
            encoded,
            limitChars,
            { questions: verdict.failedQuestions.slice(0, 4), overLimit },
            label,
          );
    try {
      const raw = await zcodeCli(prompt);
      encoded = extractMarked(raw.text, "ENC") ?? "";
      const decodedRaw = await zcodeCli(buildDecodePrompt(encoded, facts, label));
      verdict = judgeAll(facts, extractMarked(decodedRaw.text, "ANS") ?? "");
      say(
        `[${label}] 第${round}轮 密文${encoded.length}字符（上限${limitChars}，R=${(encoded.length / text.length).toFixed(2)}） F=${verdict.full}/${facts.length}${verdict.coreTotal !== facts.length ? ` F_core=${verdict.core}/${verdict.coreTotal}` : ""}`,
      );
      if (verdict.full === facts.length && encoded.length <= limitChars) break;
      if (round === 3) break;
      say(
        `[${label}] 反馈重编（${[
          verdict.failedQuestions.length ? `丢${verdict.failedQuestions.length}条` : "",
          encoded.length > limitChars ? "超长" : "",
        ]
          .filter(Boolean)
          .join("+")}）`,
      );
      await sleep(400);
    } catch (error) {
      say(`[${label}] 第${round}轮失败: ${String(error).slice(0, 120)}`);
      break;
    }
  }
  return { encoded, verdict, rounds: verdict ? Math.min(3, verdict.rounds ?? 3) : 0, limitChars };
}

say(
  `模型：${model} · 3 段共 ${ORIGINAL_CHARS} 字符 · L1 ≤12%/段 · L2 联合 ≤10% · L3 蒸馏 ≤5%`,
);

// L1：分段极限密文
const l1Results = [];
for (const seg of SEGMENTS) {
  const facts = FACTS.filter((fact) => fact.seg === seg.id);
  const { encoded, verdict } = await encodeWithFeedback(seg.text, facts, 0.12, seg.id);
  l1Results.push({
    seg: seg.id,
    encoded: encoded ?? "",
    chars: encoded?.length ?? 0,
    ratio: encoded ? Math.round((encoded.length / seg.text.length) * 100) / 100 : null,
    full: verdict?.full ?? 0,
    total: facts.length,
    preview: (encoded ?? "").slice(0, 80),
  });
  await sleep(400);
}

// L2：联合压缩 ≤ 原文 10%
const jointTarget = Math.ceil(ORIGINAL_CHARS * 0.1);
let l2 = null;
let l2Verdict = null;
const valid = l1Results.filter((item) => item.encoded.length > 0);
if (valid.length === SEGMENTS.length) {
  try {
    const raw = await zcodeCli(
      buildJointEncodePrompt(
        valid.map((item) => ({ seg: item.seg, encoded: item.encoded })),
        jointTarget,
      ),
    );
    l2 = extractMarked(raw.text, "ENC") ?? "";
    const decodedRaw = await zcodeCli(buildDecodePrompt(l2, FACTS, "联合密文"));
    l2Verdict = judgeAll(FACTS, extractMarked(decodedRaw.text, "ANS") ?? "");
    say(
      `[L2 联合] 密文${l2.length}字符（上限${jointTarget}，R=${(l2.length / ORIGINAL_CHARS).toFixed(3)}） F_full=${l2Verdict.full}/${FACTS.length} F_core=${l2Verdict.core}/${l2Verdict.coreTotal}`,
    );
  } catch (error) {
    say(`[L2 联合] 失败: ${String(error).slice(0, 120)}`);
  }
} else {
  say("[L2 联合] 跳过：存在编码失败片段");
}

// L3：对 L2 再蒸馏 ≤ 原文 5%（级联第二次）
let l3 = null;
let l3Verdict = null;
const l3Target = Math.ceil(ORIGINAL_CHARS * 0.05);
if (l2 && l2.length > 0) {
  try {
    const raw = await zcodeCli(
      buildEncodePrompt(
        `（这是你此前对一份记录压缩得到的联合密文，其原始记录包含 ${FACTS.length} 条事实）\n${l2}`,
        l3Target,
        "联合密文（对它做第二次压缩）",
      ),
    );
    l3 = extractMarked(raw.text, "ENC") ?? "";
    const decodedRaw = await zcodeCli(buildDecodePrompt(l3, FACTS, "二次压缩密文"));
    l3Verdict = judgeAll(FACTS, extractMarked(decodedRaw.text, "ANS") ?? "");
    say(
      `[L3 蒸馏] 密文${l3.length}字符（上限${l3Target}，R=${(l3.length / ORIGINAL_CHARS).toFixed(3)}） F_full=${l3Verdict.full}/${FACTS.length} F_core=${l3Verdict.core}/${l3Verdict.coreTotal}`,
    );
  } catch (error) {
    say(`[L3 蒸馏] 失败: ${String(error).slice(0, 120)}`);
  }
}

// ── 报告 ──
const level = (chars) => (chars === null ? "—" : `${chars}（R=${(chars / ORIGINAL_CHARS).toFixed(3)}）`);
const report = [
  "# OPC 记忆压缩试验 v3（极限骨架密文 + N 级蒸馏）",
  "",
  `- 模型：${model} · 原始记录 3 段共 ${ORIGINAL_CHARS} 字符 · 事实 ${FACTS.length} 条（骨架 ${l2Verdict?.coreTotal ?? "?"} 条）`,
  "- 协议：无意义化=压缩（gzip 同理：去掉人类可读冗余）。数字/编号直存，",
  "  文字实体成体系代号化（禁纯随机——v1 已证纯随机 F=0）。",
  "- F_full=精确恢复（数字/人名/编号）；F_core=大意骨架（语法重组、意思对即可）。",
  "",
  "## 各级压缩结果",
  "",
  "| 层 | 密文字符 | R（对原文） | F_full | F_core |",
  "|---|---|---|---|---|",
  ...l1Results.map(
    (item) =>
      `| L1·${item.seg}（对段原文${SEGMENTS.find((seg) => seg.id === item.seg).text.length}字符） | ${item.chars} | ${item.ratio ?? "?"} | ${item.full}/${item.total} | — |`,
  ),
  l2 !== null
    ? `| L2 联合 | ${l2.length} | ${(l2.length / ORIGINAL_CHARS).toFixed(3)} | ${l2Verdict.full}/${FACTS.length} | ${l2Verdict.core}/${l2Verdict.coreTotal} |`
    : "| L2 联合 | — | — | — | — |",
  l3 !== null
    ? `| L3 蒸馏（二次压缩） | ${l3.length} | ${(l3.length / ORIGINAL_CHARS).toFixed(3)} | ${l3Verdict.full}/${FACTS.length} | ${l3Verdict.core}/${l3Verdict.coreTotal} |`
    : "| L3 蒸馏（二次压缩） | — | — | — | — |",
  "",
  "## L2 联合密文全文",
  "",
  l2 ? "```\n" + l2 + "\n```" : "（未获得）",
  "",
  "L2 逐条判定：",
  ...(l2Verdict?.perFact ?? []).map(
    (item) =>
      `- ${item.id}. ${item.full ? "✓精确" : item.core ? "△仅大意" : "✗丢失"} ${item.answer}`,
  ),
  "",
  "## L3 蒸馏密文全文（N=2 次压缩后）",
  "",
  l3 ? "```\n" + l3 + "\n```" : "（未获得）",
  "",
  "L3 逐条判定：",
  ...(l3Verdict?.perFact ?? []).map(
    (item) =>
      `- ${item.id}. ${item.full ? "✓精确" : item.core ? "△仅大意" : "✗丢失"} ${item.answer}`,
  ),
  "",
  "## 判读",
  "",
  "- L2 R<0.10 且 F_core 满：无意义化与 <10% 压缩兼得（协议成立）",
  "- L3 存活度（F_core 保持）：级联第二次压缩后骨架是否仍在（N 次压缩可行性）",
  "- L1 反馈轮数与 F 变化：黑盒反馈搜索（TextGrad 思想）收敛性",
].join("\n");

if (outPath) writeFileSync(outPath, report);
say("\n" + (outPath ? `报告已写入 ${outPath}` : report));
