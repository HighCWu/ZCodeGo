import { describe, expect, it } from "vitest";
import {
  buildOpcProbeSessionPrompt,
  compareOpcFingerprints,
  normalizeOpcProbeAnswer,
  opcAnswerDistribution,
  opcJensenShannonDivergence,
  parseOpcProbeAnswers,
  planOpcProbeSession,
} from "../src/opc/opc-fingerprint.js";
import {
  applyOpcMutation,
  createEmptyOpcCompanyState,
} from "../src/opc/opc-reducer.js";
import { OPC_PROBE_CELLS } from "../src/opc/opc-fingerprint.js";

const NOW = 1_700_000_000_000;

describe("答案归一化", () => {
  it("数字域：中文数字/英文词/字面量统一", () => {
    const cell = OPC_PROBE_CELLS.find(
      (c) => c.key === "random-number-1-100:en",
    )!;
    for (const [raw, want] of [
      ["42", "42"],
      ["42.", "42"],
      ["**42**", "42"],
      ["Seven", "7"],
      ["七", "7"],
      ["七十五", "75"],
      ["一百", "100"],
      ["七十三", "73"],
    ] as const) {
      expect(normalizeOpcProbeAnswer(raw, cell.domain)).toBe(want);
    }
  });

  it("颜色/硬币域：中英映射；无效样本为空", () => {
    const color = OPC_PROBE_CELLS.find((c) => c.key === "color:en")!;
    expect(normalizeOpcProbeAnswer("Red.", color.domain)).toBe("red");
    expect(normalizeOpcProbeAnswer("蓝色", color.domain)).toBe("blue");
    const coin = OPC_PROBE_CELLS.find((c) => c.key === "coin:en")!;
    expect(normalizeOpcProbeAnswer("正面", coin.domain)).toBe("heads");
    expect(normalizeOpcProbeAnswer("tails", coin.domain)).toBe("tails");
    expect(normalizeOpcProbeAnswer("也许吧", coin.domain)).toBe("");
    // city 格（spec 核心电池；此前实现缺失用 coin:zh 补位——已对齐）
    const city = OPC_PROBE_CELLS.find((c) => c.key === "city:en")!;
    expect(normalizeOpcProbeAnswer("Tokyo", city.domain)).toBe("tokyo");
    expect(normalizeOpcProbeAnswer("New York.", city.domain)).toBe("new-york");
  });

  it("字母域取单字母；城市域按词 slug", () => {
    const letter = OPC_PROBE_CELLS.find((c) => c.key === "letter:en")!;
    expect(normalizeOpcProbeAnswer("K", letter.domain)).toBe("k");
    expect(normalizeOpcProbeAnswer("The letter Q", letter.domain)).toBe("q");
  });
});

describe("会话 prompt 与行解析", () => {
  it("plan 轮换改写；prompt 携带写文件契约与答案数组指令", () => {
    const cell = OPC_PROBE_CELLS[0]!;
    const plan = planOpcProbeSession(cell, 10, 3);
    expect(plan.prompts).toHaveLength(10);
    const prompt = buildOpcProbeSessionPrompt(plan, ".opc/fingerprint/x.json");
    expect(prompt).toContain("1.");
    expect(prompt).toContain("10.");
    // 文件中转契约：输出路径与 answers JSON 形状指令必须在场
    expect(prompt).toContain(".opc/fingerprint/x.json");
    expect(prompt).toContain('"answers"');
    expect(prompt).toContain("the ONLY file you may write");
  });

  it("解析剥序号/列表前缀并截断到预期数", () => {
    const text = ["1. 42", "- 73", "• 17", "", "9", "extra"].join("\n");
    expect(parseOpcProbeAnswers(text, 4)).toEqual(["42", "73", "17", "9"]);
  });
});

describe("JSD 与指纹比对", () => {
  it("同分布 JSD=0；完全分离 JSD=1", () => {
    expect(opcJensenShannonDivergence({ a: 5, b: 5 }, { a: 5, b: 5 })).toBe(0);
    expect(opcJensenShannonDivergence({ a: 10 }, { b: 10 })).toBe(1);
  });

  function fingerprintFor(counts: Record<string, number>, modelKey = "m") {
    const cells = Object.fromEntries(
      Object.entries(counts).map(([cell, n]) => [
        cell,
        {
          domain: "number100" as const,
          counts: { "42": n, "73": Math.max(0, 10 - n) },
          valid: 10,
          invalid: 0,
          raw: 10,
        },
      ]),
    );
    return {
      modelKey,
      capturedAt: NOW,
      cells:
        cells as unknown as import("../src/opc/opc-types.js").OpcModelFingerprint["cells"],
      sessionCount: 1,
      validTotal: 10 * Object.keys(counts).length,
    };
  }

  it("match/uncertain/mismatch 三带", () => {
    // n=10 → {42:10, 73:0}（完全分离才有 mismatch 量级；10 样本的 5/5 vs
    // 0/10 翻转 JSD≈0.31 只落 uncertain——detector 论文口径）
    const base = fingerprintFor({ "random-number-1-100:en": 10 });
    const same = fingerprintFor({ "random-number-1-100:en": 10 });
    expect(compareOpcFingerprints(base, same).verdict).toBe("match");
    const flipped = {
      ...base,
      cells: Object.fromEntries(
        Object.entries(base.cells).map(([cell, stats]) => [
          cell,
          { ...stats, counts: { "42": 0, "73": 10 } },
        ]),
      ),
    };
    expect(compareOpcFingerprints(base, flipped).verdict).toBe("mismatch");
    // 无可比格 → uncertain
    expect(
      compareOpcFingerprints(base, { ...flipped, cells: {} }).verdict,
    ).toBe("uncertain");
  });
});

describe("reducer：capture/acknowledge（三轮 review 的 E2E 断言语义）", () => {
  function fp(modelKey: string, prefer42: boolean, capturedAt = NOW) {
    return {
      modelKey,
      capturedAt,
      cells: {
        "random-number-1-100:en": {
          domain: "number100" as const,
          counts: prefer42 ? { "42": 10 } : { "73": 10 },
          valid: 10,
          invalid: 0,
          raw: 10,
        },
      },
      sessionCount: 1,
      validTotal: 10,
    };
  }

  it("首次采集建 baseline 无判定；复测 mismatch 产生进化事件", () => {
    let state = createEmptyOpcCompanyState(NOW);
    const first = applyOpcMutation(
      state,
      { kind: "fingerprint.capture", fingerprint: fp("glm/glm-4.7", true) },
      NOW + 1,
    );
    const entry1 = first.state.modelFingerprints?.["glm/glm-4.7"]!;
    expect(entry1.baseline).toBe(entry1.last);
    expect(entry1.lastVerdict).toBeUndefined();
    // 复测：分布翻转 → mismatch + 事件
    const second = applyOpcMutation(
      first.state,
      { kind: "fingerprint.capture", fingerprint: fp("glm/glm-4.7", false) },
      NOW + 2,
    );
    const entry2 = second.state.modelFingerprints?.["glm/glm-4.7"]!;
    expect(entry2.lastVerdict).toBe("mismatch");
    expect(entry2.lastChangedAt).toBe(NOW + 2);
    expect(second.events.length).toBe(1);
    expect(second.events[0]!.summary).toContain("指纹变动");
    // baseline 不变
    expect(entry2.baseline.capturedAt).toBe(NOW);
    // match 复测不产生事件
    // 回正复测（分布与 baseline 一致）→ match、零事件
    const third = applyOpcMutation(
      second.state,
      { kind: "fingerprint.capture", fingerprint: fp("glm/glm-4.7", true) },
      NOW + 3,
    );
    expect(third.events.length).toBe(0);
    expect(third.state.modelFingerprints?.["glm/glm-4.7"]!.lastVerdict).toBe(
      "match",
    );
    state = third.state;
  });

  it("acknowledge：last 升为 baseline、verdict 清空、acknowledgedAt 落账", () => {
    let state = createEmptyOpcCompanyState(NOW);
    state = applyOpcMutation(
      state,
      { kind: "fingerprint.capture", fingerprint: fp("glm/glm-4.7", true) },
      NOW + 1,
    ).state;
    const flipped = applyOpcMutation(
      state,
      { kind: "fingerprint.capture", fingerprint: fp("glm/glm-4.7", false) },
      NOW + 2,
    ).state;
    const ack = applyOpcMutation(
      flipped,
      { kind: "fingerprint.acknowledge", modelKey: "glm/glm-4.7" },
      NOW + 3,
    );
    const entry = ack.state.modelFingerprints?.["glm/glm-4.7"]!;
    expect(entry.baseline).toBe(entry.last);
    expect(entry.lastVerdict).toBeUndefined();
    expect(entry.acknowledgedAt).toBe(NOW + 3);
    // 未知 modelKey 无操作
    const noop = applyOpcMutation(
      ack.state,
      { kind: "fingerprint.acknowledge", modelKey: "unknown" },
      NOW + 4,
    );
    expect(noop.state).toBe(ack.state);
  });
});

describe("split-half 自洽（detector 采集自检思想）", () => {
  it("稳定分布自洽度高；随机分布自洽度低", () => {
    const stable = opcAnswerDistribution(
      Array.from({ length: 10 }, () => "42"),
      "number100",
    );
    expect(stable.selfConsistency).toBe(1);
    const noisy = opcAnswerDistribution(
      ["1", "2", "3", "4", "5", "6", "7", "8"],
      "number100",
    );
    expect(noisy.selfConsistency).toBeLessThan(stable.selfConsistency);
    // 样本 <4：无从分半，自洽度记 0（比对信号降权由调用方处理）
    const tiny = opcAnswerDistribution(["42", "73"], "number100");
    expect(tiny.selfConsistency).toBe(0);
  });
});
