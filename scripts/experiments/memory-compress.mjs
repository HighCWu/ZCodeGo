#!/usr/bin/env node
/**
 * OPC 记忆压缩试验：提示词诱导的模型特定编码（模型指纹锁定解码方）。
 *
 * 思想：让同一基模把一段记忆压缩成只有它自己能可靠解码的紧凑表示；
 * 模型指纹锁定「同一模型」这一前提——指纹变动即乱码可能不可解码的信号。
 *
 * 三组无意义化策略（对照 LM Babel/PromptQuine 式「模型特定编码」思想）：
 *   E 随机映射密码（每条事实 → 随机串，无对照表）
 *   F 噪声块（全部事实 → 伪 Base64/哈希乱码块，可掺无关伪词）
 *   G 罕见字符密码（罕见 Unicode 符号私有编码）
 * 每组：编码 → 同模型解码（事实恢复率 F）→ 压缩率 R（字符代理，参考）；
 * 可选 --cross-model <modelKey> 跨模型解码对照（G = F同 - F跨）。
 * 可读压缩对照（电报体/自创符号）历史数据：R≈0.35-0.51，F≈0.8-1.0。
 *
 * 调用走 zcode CLI headless（-p 一次问一次答）——GLM coding plan 只支持
 * 在 coding harness 中使用，不能直连 OpenAI 兼容 API。每次 spawn 是独立
 * 会话（无上下文污染）；采样温度不可控为已知局限（spec 如实记录）。
 *
 * 用法：
 *   node scripts/experiments/memory-compress.mjs \
 *     [--cli zcode] [--model glm-4.7] [--samples 3] \
 *     [--out report.md]
 *
 * --model 仅用于报告标注与跨模型对照的标注（实际模型由 CLI 会话的
 * 默认模型/用户配置决定）。
 */
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const httpBase = arg("--http") ?? process.env.OPC_EXP_HTTP ?? "";
// --http http://127.0.0.1:<port>：走桌面试验接口（推荐——真实模型链路已验证）
const cliBin = arg("--cli") ?? "zcode";
const model = arg("--model") ?? "(cli 默认模型)";
const samples = Number(arg("--samples") ?? 1);
const outPath = arg("--out");

// ── 试验原文：含 10 个可核查事实的中文记忆片段（模拟员工私人记忆） ──
const ORIGINAL_TEXT = `上周三（10 月 8 日）我在杭州分公司与供应商林晓峰谈妥了二期合同，金额 187 万元，付款分三期：签约付 40%、交付验收付 50%、质保期满付 10%，质保期 18 个月。对方要求我方在 11 月 15 日前提供部署清单，由张明负责对接，他的邮箱是 zhangming@example.com。另外会议决定把旧版报表系统的下线时间从原定的 12 月 1 日推迟到 12 月 20 日，原因是运营部李婷的团队还在用其中三个报表：日报、周报和库存月报。合同编号 HT-2026-1108，纸质版一式四份，我方存三份，一份寄回对方法务部（收件人写陈法务）。`;

const FACTS = [
  {
    id: "1",
    question: "二期合同的金额和付款分几期？",
    expectKeywords: ["187", "三"],
  },
  { id: "2", question: "签约阶段付款比例是多少？", expectKeywords: ["40"] },
  { id: "3", question: "质保期多长？", expectKeywords: ["18"] },
  { id: "4", question: "部署清单的截止日期？", expectKeywords: ["11", "15"] },
  { id: "5", question: "部署清单由谁负责对接？", expectKeywords: ["张明"] },
  {
    id: "6",
    question: "旧版报表系统推迟到哪天下线？",
    expectKeywords: ["12", "20"],
  },
  {
    id: "7",
    question: "还在用旧系统的团队负责人是谁？",
    expectKeywords: ["李婷"],
  },
  {
    id: "8",
    question: "还在使用的三个报表是什么？",
    expectKeywords: ["日报", "周报", "月报"],
  },
  {
    id: "9",
    question: "合同编号是什么？",
    expectKeywords: ["ht-2026-1108", "ht-2026-1108"],
  },
  {
    id: "10",
    question: "纸质合同寄给对方的收件人要求写谁？",
    expectKeywords: ["陈法务"],
  },
];

const STRATEGIES = [
  {
    id: "random-cipher",
    label: "E 随机映射密码",
  },
  {
    id: "noise-blob",
    label: "F 噪声块",
  },
  {
    id: "rare-glyph",
    label: "G 罕见字符密码",
  },
];

// 各策略的无意义化规则：目标是「外部观察者完全无法读出原文信息」的乱码，
// 而非电报体/缩写式换写法（那组数据作为可读压缩对照另行保留）。
const STRATEGY_RULES = {
  "random-cipher": [
    "规则：现场为每条关键事实发明一个随机映射——把事实转成一段看似完全随机的",
    "字母、数字与符号混排串（例如把某条事实映射成像 Xq7#九fK@⌘ 2k 这样的随机片段）。",
    "硬性约束：输出中不得出现原文的任何词汇、人名、地名、邮箱、编号原文形态，",
    "也不得用拼音首字母、缩写、谐音等可回猜表示；不得输出映射表或任何解释。",
    "片段之间用你自己选的私有分隔符连接。",
  ],
  "noise-blob": [
    "规则：把全部关键事实编码成一整块看似 Base64/哈希摘要的乱码文本。",
    "允许掺杂看起来像有意义单词/数字的伪词伪数（但必须与原文内容完全无关，",
    "仅作掩护）。硬性约束：不得出现原文词汇、人名、编号、金额等原文形态，",
    "不得用拼音或缩写回猜表示；不得输出任何对照表或解释。",
  ],
  "rare-glyph": [
    "规则：只用罕见 Unicode 符号（如 ㊾ ㋛ ⌘ ☯ ⟁ ⨳ ⁂ ⸘ ⧉ ⓳ 等及同类）",
    "与你自己发明的符号序列构造私有编码，每个符号序列绑定一条关键事实。",
    "硬性约束：不得出现汉字、字母、数字的原文信息形态（纯作为私有符号使用的",
    "字符除外）；不得输出任何对照表或解释。",
  ],
};

// ── zcode CLI headless 调用（coding harness 内使用 coding plan） ──

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
        resolve({ text: stdout, usageTokens: null });
      }
    });
  });
}

async function chat(content) {
  if (httpBase) {
    // 桌面试验接口：临时会话执行，回复经 .opc/exp/<tag>.json 轮询回传
    const response = await fetch(`${httpBase}/exp/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, timeoutMs: 180_000 }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error ?? "exp timeout");
    return { text: data.text, usageTokens: null };
  }
  return zcodeCli(content);
}

/** zcode headless 的 stdout 混有 Electron 启动日志——prompt 契约用标记包裹，
 *  这里提取标记间内容（最后一个标记块，日志里也可能出现字面标记）。 */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

console.log(
  `模型：${model} · 样本 ${samples} · 原文 ${ORIGINAL_TEXT.length} 字符`,
);

for (const strategy of STRATEGIES) {
  const entry = { strategy: strategy.label, id: strategy.id, runs: [] };
  for (let run = 0; run < samples; run += 1) {
    try {
      // 编码
      const encodePrompt = [
        "把下面的原文转换成一种无意义字符表示（对外部观察者是完全无法读懂的乱码）。",
        ...STRATEGY_RULES[strategy.id],
        "唯一要求：稍后把这段乱码单独交还给你（同一个人工智能助手）时，",
        "你必须能凭它还原原文的全部 10 条关键事实。",
        "",
        "【原文】",
        ORIGINAL_TEXT,
        "",
        "把最终乱码表示包在 <ENC> 与 </ENC> 标记之间（标记各占一行），标记外不要有任何内容。",
      ].join("\n");
      const encodedRaw = await chat(encodePrompt);
      const encodedText = extractMarked(encodedRaw.text, "ENC") ?? "";
      await sleep(500);
      // 同模型解码
      const decodePrompt = [
        "下面这段紧凑表示是你此前对一段原文做的压缩。请解码还原：逐条回答以下问题，",
        "答案基于原原文，每条一行，格式「编号. 答案」。无法还原的条目回答「无法还原」。",
        "",
        "【压缩表示】",
        encodedText,
        "",
        "【问题清单】",
        ...FACTS.map((fact) => `${fact.id}. ${fact.question}`),
      ].join("\n");
      const decoded = await chat(
        decodePrompt +
          "\n全部回答包在 <ANS> 与 </ANS> 标记之间（标记各占一行），标记外不要有任何内容。",
      );
      const answersText = extractMarked(decoded.text, "ANS") ?? "";
      const perFact = FACTS.map((fact) => {
        const line = answersText
          .split(/\r?\n/)
          .find((line) => line.trim().startsWith(`${fact.id}.`));
        const answer = (line ?? "").toLowerCase();
        return {
          id: fact.id,
          recovered:
            answer.length > 0 &&
            fact.expectKeywords.every((keyword) =>
              answer.includes(keyword.toLowerCase()),
            ),
        };
      });
      const recovered = perFact.filter((item) => item.recovered).length;
      const ratio = encodedText.length / ORIGINAL_TEXT.length;
      entry.runs.push({
        run: run + 1,
        ratio: Math.round(ratio * 100) / 100,
        encodedChars: encodedText.length,
        recovered,
        rate: Math.round((recovered / FACTS.length) * 100) / 100,
        perFact,
        encodedPreview: encodedText.slice(0, 120),
      });
      console.log(
        `[${strategy.label}] #${run + 1} R=${ratio.toFixed(2)} F=${recovered}/${FACTS.length}`,
      );
      await sleep(500);
    } catch (error) {
      console.error(
        `[${strategy.label}] #${run + 1} 失败:`,
        String(error).slice(0, 160),
      );
      entry.runs.push({ run: run + 1, error: String(error).slice(0, 200) });
    }
  }
  results.push(entry);
}

// 跨模型对照（G）暂缺：zcode CLI 单配置模型（无 --model），多模型对照
// 留待面板内多员工（不同 modelSelection）路径。

// ── Markdown 报告 ──
const report = [
  "# OPC 记忆压缩试验报告（无意义字符编码）",
  "",
  `- 模型：${model}`,
  `- 原文：${ORIGINAL_TEXT.length} 字符 · 事实核查 ${FACTS.length} 条 · 每组样本 ${samples}`,
  "- 目标形态：编码产物对外部观察者是完全无法读懂的乱码（非电报体/缩写换写法），",
  "  同模型可解码；模型指纹锁定「同一模型」前提，指纹变动即乱码可能不可解码。",
  "",
  "| 组 | R（字符比，参考） | F（恢复率） | 编码预览 |",
  "|---|---|---|---|",
  ...results.flatMap((entry) =>
    entry.runs.map(
      (run) =>
        `| ${entry.strategy} #${run.run} | ${run.ratio ?? "?"} | ${run.rate ?? "?"}（${run.recovered ?? "?"}/${FACTS.length}） | ${(run.encodedPreview ?? run.error ?? "").replace(/\|/g, "/").slice(0, 60)} |`,
    ),
  ),
  "",

  "",
  "## 判读基准",
  "",
  "- 无意义化策略的首要指标是 F：F ≥ 0.9 说明同模型能从乱码恢复事实（编码可行）；",
  "  F 接近 0 说明无对照表的独立会话解码不成立（需迭代：自描述解码头/密钥提示）。",
  "- R 仅字符比代理：乱码符号的 token 密度与汉字不同，字符比不等于 token 比；",
  "  无意义化策略不以 R 为目标（与可读压缩对照分开解读）。",
  "- 可读压缩对照（历史数据，电报体/自创符号策略）：R≈0.35-0.51，F≈0.8-1.0——",
  "  「换一种写法」可行性已证；本报告实验组验证的是「无意义化后还能否解码」。",
  "- 跨模型 F 显著低于同模型：编码依赖目标模型特有能力（模型特定编码成立）。",
].join("\n");

if (outPath) writeFileSync(outPath, report);
console.log("\n" + (outPath ? `报告已写入 ${outPath}` : report));
