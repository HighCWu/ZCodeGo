#!/usr/bin/env node
/**
 * OPC 记忆压缩试验 v4（收敛版）：骨架密文 + 分级上限 + 结构保持反馈。
 *
 * 综合 v1-v3 实证的协议参数：
 * - v1：无意义化无长度约束 → F=1 但 R≈2.4-3.0 膨胀；纯随机映射 F=0（禁用）。
 * - v2：L1 ≤30% + 反馈迭代 → R=0.31 全段满分；L2 联合 ≤10% → R=0.10 时
 *   F_full=6/10、骨架≈满。**10% 是当前模型可达边界**；L2 反馈重编会倒退
 *   （重编把已可解码结构也改掉 → F 全崩）。
 * - v3：单段 12% 过狠（数字直存即占满，4 条事实 F=0 三轮不收敛）。
 *
 * v4 改动：
 * 1. L1 回 30%，编码协议用骨架原理（数字/编号直存 + 文字实体成体系代号）。
 * 2. L2 反馈 prompt 加结构保持约束：「保留已可还原部分的编码，仅补充缺失」。
 * 3. L2 收敛判据 = F_core 满（细节丢失是 <10% 的必然代价，不追求 F_full）。
 * 4. 修复 v2 判定溢出：非核心事实不再计入 F_core。
 *
 * 用法：
 *   node scripts/experiments/memory-compress-v4.mjs \
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
  { id: "1", seg: "S1", core: true, question: "二期合同的金额是多少？付款分几期？", keywords: ["187", "三"] },
  { id: "2", seg: "S1", core: false, question: "签约阶段付款比例是多少？", keywords: ["40"] },
  { id: "3", seg: "S1", core: false, question: "质保期多长？", keywords: ["18"] },
  { id: "4", seg: "S1", core: false, question: "合同编号是什么？", keywords: ["ht-2026-1108"] },
  { id: "5", seg: "S2", core: true, question: "部署清单的截止日期是哪天？", keywords: ["11", "15"] },
  { id: "6", seg: "S2", core: true, question: "部署清单由谁负责对接？", keywords: ["张明"] },
  { id: "7", seg: "S2", core: false, question: "对接人张明的邮箱是什么？", keywords: ["zhangming@example.com"] },
  { id: "8", seg: "S2", core: true, question: "寄回对方法务部的收件人要求写谁？", keywords: ["陈法务"] },
  { id: "9", seg: "S3", core: true, question: "旧版报表系统的下线时间推迟到了哪天？", keywords: ["12", "20"] },
  { id: "10", seg: "S3", core: true, question: "哪个团队还在用旧报表系统？负责人是谁？", keywords: ["李婷"] },
];

const CIPHER_RULE = [
  "编码原理（如同 gzip：去掉人类可读的冗余，只保留信息本身）——",
  "1. 先在心里列出事实清单（谁/何时/多少/什么条件），只编码事实，不编码措辞。",
  "2. 数字、日期、编号、金额原样直存（最高效且精确）。",
  "3. 文字实体（人名、机构、事件）压成 1-3 字符的自造代号：片段内用一致的变换规则",
  "   （固定偏移/部首替换/你的私有惯用变体），稍后你要能顺着同一套规则读回来。",
  "   禁止纯随机串。",
  "4. 产物不得保留原文词汇、拼音首字母、常见缩写等人类可回猜形态（数字/编号直存除外）。",
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

function looksLikeRefusal(text) {
  return /无法|不能|做不到/.test(text) && text.length <= 60;
}

function buildEncodePrompt(text, limitChars, label) {
  return [
    `把下面的${label}压缩成一段密文——外部观察者完全无法读懂，`,
    "但稍后把密文单独交还给你时，你必须能凭它还原其中的关键事实。",
    CIPHER_RULE,
    `长度硬上限：${limitChars} 字符。若你认为上限内无法同时做到「可还原」与「不可读」，`,
    "优先保证可还原，并尽量接近上限。",
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
    reasons.push(`凭这段密文你无法还原：${failures.questions.join("；")}`);
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
    "请在这段密文的基础上改进：**已能还原的信息保持原编码不动，只修正丢失/超长部分**",
    "（不要整体重写——原有结构是你稍后解码的依据）。仍须满足：事实完整、无意义密文形态、",
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
    "请把它们联合压缩成一段更短的密文（三份密文档案合并成一份总索引），",
    `长度硬上限：${limitChars} 字符。若认为上限内无法保全骨架，优先保全骨架并尽量接近上限。`,
    "联合后你仍必须能凭它回答关于原始记录的关键事实（主要人物、金额、日期、事件方向）；",
    "次要细节允许进一步浓缩。",
    CIPHER_RULE,
    "",
    ...items.map((item) => `【片段 ${item.seg} 的密文】\n${item.encoded}`),
    "",
    "把联合密文包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function judgeAll(facts, answersText) {
  const perFact = facts.map((fact) => {
    const line = answersText
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith(`${fact.id}.`));
    const answer = (line ?? "").toLowerCase();
    const hit = fact.keywords.every((keyword) => answer.includes(keyword.toLowerCase()));
    return {
      id: fact.id,
      core: fact.core,
      recovered: answer.length > 0 && hit,
      answer: (line ?? "").trim().slice(0, 60),
    };
  });
  return {
    perFact,
    full: perFact.filter((item) => item.recovered).length,
    core: perFact.filter((item) => item.core && item.recovered).length,
    coreTotal: perFact.filter((item) => item.core).length,
    failedQuestions: facts
      .filter((_, index) => !perFact[index].recovered)
      .map((fact) => fact.question),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (message) => console.log(message);

async function encodeWithFeedback(text, facts, limitRatio, label) {
  const limitChars = Math.ceil(text.length * limitRatio);
  let encoded = null;
  let verdict = null;
  let rounds = 0;
  for (let round = 1; round <= 3; round += 1) {
    rounds = round;
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
      const candidate = extractMarked(raw.text, "ENC") ?? "";
      if (!candidate || looksLikeRefusal(candidate)) {
        say(`[${label}] 第${round}轮 模型拒绝/空编码，重试`);
        verdict = verdict ?? { failedQuestions: facts.map((fact) => fact.question) };
        continue;
      }
      encoded = candidate;
      const decodedRaw = await zcodeCli(buildDecodePrompt(encoded, facts, label));
      verdict = judgeAll(facts, extractMarked(decodedRaw.text, "ANS") ?? "");
      say(
        `[${label}] 第${round}轮 密文${encoded.length}字符（上限${limitChars}，R=${(encoded.length / text.length).toFixed(2)}） F=${verdict.full}/${facts.length}`,
      );
      if (verdict.full === facts.length && encoded.length <= limitChars) break;
      if (round === 3) break;
      await sleep(400);
    } catch (error) {
      say(`[${label}] 第${round}轮失败: ${String(error).slice(0, 120)}`);
      break;
    }
  }
  return { encoded: encoded ?? "", verdict, rounds, limitChars };
}

say(
  `模型：${model} · 3 段共 ${ORIGINAL_CHARS} 字符 · L1 ≤30%（骨架密文）· L2 联合 ≤10%（结构保持反馈）`,
);

const l1Results = [];
for (const seg of SEGMENTS) {
  const facts = FACTS.filter((fact) => fact.seg === seg.id);
  const result = await encodeWithFeedback(seg.text, facts, 0.3, seg.id);
  l1Results.push({
    seg: seg.id,
    encoded: result.encoded,
    chars: result.encoded.length,
    ratio: result.encoded ? Math.round((result.encoded.length / seg.text.length) * 100) / 100 : null,
    full: result.verdict?.full ?? 0,
    total: facts.length,
    rounds: result.rounds,
    preview: result.encoded.slice(0, 80),
  });
  await sleep(400);
}

// L2：联合压缩 ≤10%，判据 F_core 满
const jointTarget = Math.ceil(ORIGINAL_CHARS * 0.1);
let l2 = null;
let l2Verdict = null;
let l2Rounds = 0;
const valid = l1Results.filter((item) => item.encoded.length > 0);
if (valid.length === SEGMENTS.length) {
  for (let round = 1; round <= 3; round += 1) {
    l2Rounds = round;
    const overLimit = l2 !== null && l2.length > jointTarget;
    const base = buildJointEncodePrompt(
      valid.map((item) => ({ seg: item.seg, encoded: item.encoded })),
      jointTarget,
    );
    const prompt =
      round === 1
        ? base
        : [
            base,
            "",
            `你上一次的联合密文不达标：${[
              l2Verdict.failedQuestions.length
                ? `无法还原：${l2Verdict.failedQuestions.slice(0, 4).join("；")}`
                : "",
              overLimit ? `超长（上限 ${jointTarget} 字符）` : "",
            ]
              .filter(Boolean)
              .join("，且")}。`,
            "请在原密文基础上改进：已能还原的信息保持原编码不动，只修正缺失/超长部分。",
          ].join("\n");
    try {
      const raw = await zcodeCli(prompt);
      const candidate = extractMarked(raw.text, "ENC") ?? "";
      if (!candidate || looksLikeRefusal(candidate)) {
        say(`[L2 联合] 第${round}轮 模型拒绝/空编码`);
        l2Verdict = l2Verdict ?? { failedQuestions: FACTS.map((fact) => fact.question) };
        continue;
      }
      l2 = candidate;
      const decodedRaw = await zcodeCli(buildDecodePrompt(l2, FACTS, "联合密文"));
      l2Verdict = judgeAll(FACTS, extractMarked(decodedRaw.text, "ANS") ?? "");
      say(
        `[L2 联合] 第${round}轮 密文${l2.length}字符（上限${jointTarget}，R=${(l2.length / ORIGINAL_CHARS).toFixed(3)}） F_full=${l2Verdict.full}/${FACTS.length} F_core=${l2Verdict.core}/${l2Verdict.coreTotal}`,
      );
      if (l2Verdict.core === l2Verdict.coreTotal && l2.length <= jointTarget) break;
      if (round === 3) break;
      await sleep(400);
    } catch (error) {
      say(`[L2 联合] 第${round}轮失败: ${String(error).slice(0, 120)}`);
      break;
    }
  }
} else {
  say("[L2 联合] 跳过：存在编码失败片段");
}

const report = [
  "# OPC 记忆压缩试验 v4（骨架密文收敛版）",
  "",
  `- 模型：${model} · 3 段共 ${ORIGINAL_CHARS} 字符 · 事实 ${FACTS.length} 条（骨架 ${l2Verdict?.coreTotal ?? "?"} 条）`,
  "- 协议：L1 ≤30% 骨架密文（数字直存+成体系代号，结构保持反馈）→ L2 联合 ≤10%",
  "  （判据=骨架满，细节允许浓缩）。",
  "",
  "| 层 | 密文字符 | R | F_full | F_core | 轮数 |",
  "|---|---|---|---|---|---|",
  ...l1Results.map(
    (item) =>
      `| L1·${item.seg} | ${item.chars} | ${item.ratio ?? "?"} | ${item.full}/${item.total} | — | ${item.rounds} |`,
  ),
  l2 !== null
    ? `| L2 联合 | ${l2.length} | ${(l2.length / ORIGINAL_CHARS).toFixed(3)} | ${l2Verdict.full}/${FACTS.length} | ${l2Verdict.core}/${l2Verdict.coreTotal} | ${l2Rounds} |`
    : "| L2 联合 | — | — | — | — | — |",
  "",
  "## L1 密文",
  "",
  ...l1Results.map(
    (item) => `- ${item.seg}（F=${item.full}/${item.total}）：\n\n\`\`\`\n${item.encoded}\n\`\`\``,
  ),
  "",
  "## L2 联合密文全文",
  "",
  l2 ? "```\n" + l2 + "\n```" : "（未获得）",
  "",
  "L2 逐条判定：",
  ...(l2Verdict?.perFact ?? []).map(
    (item) =>
      `- ${item.id}${item.core ? "★" : ""}. ${item.recovered ? "✓" : "✗"} ${item.answer}`,
  ),
  "",
  "## 判读",
  "",
  "- v2 基线：L2 R=0.10 时 F_full=6/10、骨架≈满（无结构保持反馈）",
  "- v4 对比：骨架编码 + 结构保持反馈能否把 F_full 推向 8+/10",
].join("\n");

if (outPath) writeFileSync(outPath, report);
say("\n" + (outPath ? `报告已写入 ${outPath}` : report));
