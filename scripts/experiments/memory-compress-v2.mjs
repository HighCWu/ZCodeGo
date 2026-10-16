#!/usr/bin/env node
/**
 * OPC 记忆压缩试验 v2：分段无意义化编码 + 级联联合压缩 + 解码反馈迭代。
 *
 * 论文依据（本仓库试验对协议的改造点）：
 * - LM Babel（arXiv:2404.17120）：乱码诱导成功率随目标长度骤降（≤10 token 达
 *   71-91%，>22 token 跌破 10-20%）——编码目标按段拆小，再级联联合压缩。
 * - PromptQuine（arXiv:2506.17930）/ TextGrad（Nature 2025）：黑盒场景下靠
 *   「解码质量当适应度」的反馈搜索逼近可行编码——解码失败的事实回喂编码器
 *   重编码（预算内一轮）。
 * - 产物口径（用户定版）：无意义乱码（可掺与原文无关的伪词掩护，不得有
 *   原文词汇/拼音/缩写等可回猜形态）；联合层 R < 10%（字符代理）；
 *   还原允许语法重组，以「基本代表原文意思」= 核心事实骨架（F_core）为准，
 *   精确细节（F_full）另列。
 *
 * 用法：
 *   node scripts/experiments/memory-compress-v2.mjs \
 *     --cli /tmp/zcode-cli-headless [--out report.md]
 *
 * 调用走 zcode CLI headless（GLM coding plan 只能在 coding harness 中使用）。
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

// ── 原始记录：切成三段记忆片段（模拟同一员工的三条私人记忆） ──
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

// facts: full 关键词=精确恢复；coreKeywords=大意骨架（缺失时回退 keywords）
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
const CORE_FACTS = FACTS.filter((fact) => fact.coreKeywords);

const NOISE_RULE = [
  "规则：把信息编码成看似 Base64/哈希摘要的乱码文本，可掺杂与原文完全无关的",
  "伪词伪数作掩护。硬性约束：不得出现原文词汇、人名、编号、金额、日期的",
  "原文形态，不得用拼音、缩写、谐音等可回猜表示；不得输出任何对照表或解释。",
].join("\n");

// ── zcode CLI headless 调用 ──

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

// ── 编码 / 解码 prompt 构建 ──

function buildEncodePrompt(seg) {
  return [
    "把下面的记忆片段转换成一段无意义字符表示（对外部观察者是完全无法读懂的乱码）。",
    NOISE_RULE,
    "硬性要求：稍后这段乱码会被单独交还给你，你必须能凭它还原该片段记录的全部关键事实",
    "（人物、金额、日期、期限等精确值都不能丢）。",
    `长度上限：不超过原文的 30%（原文 ${seg.text.length} 字符，上限 ${Math.ceil(seg.text.length * 0.3)} 字符）。`,
    "",
    "【记忆片段】",
    seg.text,
    "",
    "把最终乱码包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function buildFeedbackEncodePrompt(seg, prevEncoded, failedQuestions, overLimit) {
  const reasons = [];
  if (failedQuestions.length) {
    reasons.push(
      `凭这段乱码你无法还原以下问题（信息在编码中丢失）：\n${failedQuestions
        .map((question, index) => `${index + 1}. ${question}`)
        .join("\n")}`,
    );
  }
  if (overLimit) {
    reasons.push(
      `这段乱码超长（上限 ${Math.ceil(seg.text.length * 0.3)} 字符），必须压缩到上限以内`,
    );
  }
  return [
    "你此前把一段记忆片段编码成了下面的乱码：",
    "",
    "【上一次的乱码】",
    prevEncoded,
    "",
    "但它不达标：",
    ...reasons.map((reason, index) => `${index + 1}. ${reason}`),
    "",
    "请重新编码该记忆片段，同时满足：信息完整（可还原全部关键事实）、",
    `无意义乱码形态、长度不超过 ${Math.ceil(seg.text.length * 0.3)} 字符。`,
    "",
    "【原记忆片段】",
    seg.text,
    "",
    "把新的乱码包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function buildDecodePrompt(encodedText, facts) {
  return [
    "下面这段乱码是你此前对一些记忆片段做的无意义化编码。请解码还原：逐条回答以下问题，",
    "答案基于原记忆内容，每条一行，格式「编号. 答案」。语法可以自由重组，意思对即可；",
    "确实无法还原的条目回答「无法还原」，不要编造。",
    "",
    "【乱码】",
    encodedText,
    "",
    "【问题清单】",
    ...facts.map((fact) => `${fact.id}. ${fact.question}`),
    "",
    "全部回答包在 <ANS> 与 </ANS> 标记之间（标记各占一行），标记外不要有任何内容。",
  ].join("\n");
}

function buildJointEncodePrompt(encodedSegments, targetChars) {
  return [
    "下面是同一份原始记录切成的三个片段各自的无意义化乱码表示。",
    "请把它们联合压缩成一段更短的乱码表示（相当于把三份乱码档案合并成一份索引），",
    `长度不超过 ${targetChars} 字符（原始记录全文的 10% 以内）。`,
    "联合后你仍必须能凭这段乱码回答关于原始记录的关键问题：主要人物、金额量级、",
    "时间期限、事件方向等事实骨架必须保留；确实次要的细节允许进一步浓缩。",
    NOISE_RULE,
    "",
    ...encodedSegments.map((item) => `【片段 ${item.seg} 的乱码】\n${item.encoded}`),
    "",
    "把联合乱码包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
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
  const full = perFact.filter((item) => item.full).length;
  const core = perFact.filter((item) => item.core).length;
  return {
    perFact,
    full,
    core,
    coreTotal: facts.filter((fact) => fact.coreKeywords).length || facts.length,
    failedQuestions: facts
      .filter((_, index) => !perFact[index].full)
      .map((fact) => fact.question),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 试验主流程 ──
const log = [];
const say = (message) => {
  console.log(message);
  log.push(message);
};

say(`模型：${model} · 三段共 ${ORIGINAL_CHARS} 字符 · 联合层目标 <${Math.ceil(ORIGINAL_CHARS * 0.1)} 字符（10%）`);

const segmentResults = [];
for (const seg of SEGMENTS) {
  let encoded = null;
  let verdict = null;
  let rounds = 0;
  const limit = Math.ceil(seg.text.length * 0.3);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    rounds += 1;
    const overLimit = encoded !== null && encoded.length > limit;
    const needRetry =
      encoded === null ||
      (verdict !== null &&
        (verdict.full < FACTS.filter((fact) => fact.seg === seg.id).length || overLimit));
    if (encoded !== null && !needRetry) break;
    const prompt =
      attempt === 0 || encoded === null
        ? buildEncodePrompt(seg)
        : buildFeedbackEncodePrompt(seg, encoded, verdict.failedQuestions, overLimit);
    try {
      const raw = await zcodeCli(prompt);
      encoded = extractMarked(raw.text, "ENC") ?? "";
      const segFacts = FACTS.filter((fact) => fact.seg === seg.id);
      const decodedRaw = await zcodeCli(buildDecodePrompt(encoded, segFacts));
      verdict = judgeAll(segFacts, extractMarked(decodedRaw.text, "ANS") ?? "");
      say(
        `[${seg.id}] 第${rounds}轮 R=${(encoded.length / seg.text.length).toFixed(2)}（上限0.30） F=${verdict.full}/${segFacts.length}`,
      );
      const stillOver = encoded.length > limit;
      if (verdict.full === segFacts.length && !stillOver) break;
      say(
        `[${seg.id}] 反馈重编码（${[
          verdict.failedQuestions.length ? `丢失:${verdict.failedQuestions.length}条` : "",
          stillOver ? "超长" : "",
        ]
          .filter(Boolean)
          .join(" ")}）`,
      );
      await sleep(500);
    } catch (error) {
      say(`[${seg.id}] 第${rounds}轮失败: ${String(error).slice(0, 120)}`);
      break;
    }
  }
  segmentResults.push({
    seg: seg.id,
    encoded,
    chars: encoded?.length ?? 0,
    ratio: encoded ? Math.round((encoded.length / seg.text.length) * 100) / 100 : null,
    full: verdict?.full ?? 0,
    total: FACTS.filter((fact) => fact.seg === seg.id).length,
    rounds,
    preview: encoded?.slice(0, 100) ?? "",
  });
  await sleep(500);
}

// L2：联合压缩
let joint = null;
let jointVerdict = null;
let jointRounds = 0;
const jointTarget = Math.ceil(ORIGINAL_CHARS * 0.1);
const validSegments = segmentResults.filter((item) => item.encoded?.length > 0);
if (validSegments.length === SEGMENTS.length) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    jointRounds += 1;
    const basePrompt = buildJointEncodePrompt(
      validSegments.map((item) => ({ seg: item.seg, encoded: item.encoded })),
      jointTarget,
    );
    const overLimit = joint !== null && joint.length > jointTarget;
    const prompt =
      attempt === 0
        ? basePrompt
        : [
            basePrompt,
            "",
            `补充：你上一次的联合乱码${[
              jointVerdict.failedQuestions.length
                ? `无法还原以下问题：${jointVerdict.failedQuestions.slice(0, 4).join("；")}`
                : "",
              overLimit ? `超长（上限 ${jointTarget} 字符），必须压缩` : "",
            ]
              .filter(Boolean)
              .join("，且")}，请改进编码（保持无意义形态）。`,
          ].join("\n");
    try {
      const raw = await zcodeCli(prompt);
      joint = extractMarked(raw.text, "ENC") ?? "";
      const decodedRaw = await zcodeCli(buildDecodePrompt(joint, FACTS));
      jointVerdict = judgeAll(FACTS, extractMarked(decodedRaw.text, "ANS") ?? "");
      say(
        `[L2 联合] 第${jointRounds}轮 R=${(joint.length / ORIGINAL_CHARS).toFixed(2)}（目标<0.10） F_full=${jointVerdict.full}/${FACTS.length} F_core=${jointVerdict.core}/${jointVerdict.coreTotal}`,
      );
      if (
        jointVerdict.core === jointVerdict.coreTotal &&
        joint.length <= jointTarget
      )
        break;
      await sleep(500);
    } catch (error) {
      say(`[L2 联合] 第${jointRounds}轮失败: ${String(error).slice(0, 120)}`);
      break;
    }
  }
} else {
  say("[L2 联合] 跳过：存在编码失败的片段");
}

// ── 报告 ──
const jointRatio = joint ? Math.round((joint.length / ORIGINAL_CHARS) * 100) / 100 : null;
const report = [
  "# OPC 记忆压缩试验 v2（分段无意义化 + 级联联合压缩）",
  "",
  `- 模型：${model}`,
  `- 原始记录：3 段共 ${ORIGINAL_CHARS} 字符 · 事实核查 ${FACTS.length} 条（核心骨架 ${jointVerdict?.coreTotal ?? "?"} 条）`,
  "- 口径：R 为字符比（token 代理）；F_full=精确关键词恢复；F_core=大意骨架恢复",
  "  （还原允许语法重组，以「基本代表原文意思」为准）。",
  "- 协议：L1 分段无意义化编码（解码失败反馈重编码一轮）→ L2 联合压缩至原文 10% 内 →",
  "  从 L2 回答全部事实。协议改造依据：LM Babel（短目标成功率高）、PromptQuine/TextGrad（反馈搜索）。",
  "",
  "## L1 分段编码",
  "",
  "| 段 | 原文字符 | 乱码字符 | R | F（精确） | 编码轮数 | 乱码预览 |",
  "|---|---|---|---|---|---|---|",
  ...segmentResults.map(
    (item) =>
      `| ${item.seg} | ${SEGMENTS.find((seg) => seg.id === item.seg).text.length} | ${item.chars} | ${item.ratio ?? "?"} | ${item.full}/${item.total} | ${item.rounds} | ${(item.preview || "-").replace(/\|/g, "/")} |`,
  ),
  "",
  "## L2 联合压缩",
  "",
  joint
    ? [
        `- 联合乱码 ${joint.length} 字符 · **R=${jointRatio}（目标 <0.10）** · 编码轮数 ${jointRounds}`,
        `- F_full=${jointVerdict.full}/${FACTS.length} · F_core=${jointVerdict.core}/${jointVerdict.coreTotal}`,
        "",
        "联合乱码全文：",
        "",
        "```",
        joint,
        "```",
        "",
        "逐条判定：",
        "",
        ...jointVerdict.perFact.map(
          (item) =>
            `- ${item.id}. ${item.full ? "✓精确" : item.core ? "△仅大意" : "✗丢失"} ${item.answer}`,
        ),
      ].join("\n")
    : "未获得联合编码（片段缺失或调用失败）。",
  "",
  "## 判读",
  "",
  "- L2 R < 0.10 且 F_core 达满：级联压缩可行，信息骨架在两次无意义化后仍可解码；",
  "- L2 R < 0.10 但 F_core 低：极限压缩必须牺牲细节，需更高 L1 冗余或允许 L2 略长；",
  "- L1 反馈重编码显著提 F：验证黑盒反馈搜索（PromptQuine/TextGrad 思想）在本通路有效。",
].join("\n");

if (outPath) writeFileSync(outPath, report);
say("\n" + (outPath ? `报告已写入 ${outPath}` : report));
