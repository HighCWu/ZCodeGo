import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@zcode/services";
import {
  initializeNewTaskDraft,
  pickFirstAvailableDraftModelSelection,
} from "../src/v4/composer/newTaskDraft.js";

/**
 * zcode-go：新任务草稿「自动勾上模型」兜底契约。
 *
 * 背景（5G 真机报告「可用模型没自动勾上，无法发消息」）：新任务草稿的默认
 * 选择依赖 view.preferredSelection——全新环境（新手机浏览器/新数据根）没有
 * 偏好记录且 Registry 可能给不出 preferred 时返回 null，草稿停留在「选择模型」
 * 占位且初始化不重跑，发送被 readiness 门禁拦死。
 *
 * 契约：
 * - preferredSelection 存在时沿用原链（优先 recent → preferred），兜底不参与；
 * - preferredSelection 缺失但 View 有模型 → 自动勾上第一个有模型的 provider
 *   的第一个模型（不带 options，与用户手动选模同形）；
 * - View 无任何模型 → 保持 undefined（不制造假选择）。
 * 运行：npx tsx --test --tsconfig packages/ui/tsconfig.json packages/ui/test/zcodeGoDraftModelFallback.test.ts
 */

const model = (modelId: string) => ({
  modelId,
  displayName: modelId,
  config: {
    optionSpecs: { reasoningLevel: { values: ["low", "high"] } },
  },
});

const view = (providers: { providerId: string; models: { modelId: string }[] }[], preferred?: unknown) =>
  ({
    revision: 1,
    providers: providers.map((p) => ({
      providerId: p.providerId,
      providerName: p.providerId,
      models: p.models.map((m) => model(m.modelId)),
    })),
    ...(preferred ? { preferredSelection: preferred } : {}),
  }) as unknown as ModelSelectionView;

test("preferredSelection 存在时原链优先，兜底不参与", () => {
  const v = view([{ providerId: "p1", models: [{ modelId: "m-a" }] }], {
    providerId: "p1",
    modelId: "m-a",
    options: { reasoningLevel: "high" },
  });
  const draft = initializeNewTaskDraft(
    { text: "", updatedAt: 0 },
    "/tmp/ws",
    undefined,
    v,
  );
  assert.equal(draft.modelSelection?.modelId, "m-a");
  assert.equal(draft.modelSelection?.options?.reasoningLevel, "high");
});

test("preferredSelection 缺失 → 自动勾上第一个可用模型", () => {
  const v = view([
    { providerId: "p-empty", models: [] },
    { providerId: "p1", models: [{ modelId: "m-a" }, { modelId: "m-b" }] },
  ]);
  assert.equal(pickFirstAvailableDraftModelSelection(v)?.providerId, "p1");
  assert.equal(pickFirstAvailableDraftModelSelection(v)?.modelId, "m-a");

  const draft = initializeNewTaskDraft({ text: "", updatedAt: 0 }, "/tmp/ws", undefined, v);
  assert.equal(draft.modelSelection?.providerId, "p1");
  assert.equal(draft.modelSelection?.modelId, "m-a");
  // 与用户手动选模同形：不带 options（档位由控件呈现，不制造越权默认档）。
  assert.equal(draft.modelSelection?.options, undefined);
});

test("View 无任何模型 → 保持 undefined，不造假选择", () => {
  const v = view([{ providerId: "p1", models: [] }]);
  assert.equal(pickFirstAvailableDraftModelSelection(v), undefined);
  const draft = initializeNewTaskDraft({ text: "", updatedAt: 0 }, "/tmp/ws", undefined, v);
  assert.equal(draft.modelSelection, undefined);
});
