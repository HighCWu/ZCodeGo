import assert from "node:assert/strict";
import test from "node:test";
import { extractLogicalFramePayload, wireFrameTopic } from "../src/zcode-agent/zcodeGoWireFrame.js";

/**
 * zcode-go wire 帧提取：complete 帧直取 payload；fragment 逐片 base64 解码后
 * 按字节拼接重组（乱序到达、集齐那一片返回整帧）；非帧/坏形状一律 null。
 * 运行：npx tsx --test packages/services/test/zcodeGoWireFrame.test.ts
 */

function framePayload(obj: unknown) {
  return { frame: { payload: obj } };
}

test("complete 帧：snapshot 与 deltas 直取", () => {
  assert.deepEqual(extractLogicalFramePayload({
    ...framePayload({ kind: "snapshot", snapshot: { a: 1 } }),
    kind: "complete",
    topic: "t1",
  }), { kind: "snapshot", snapshot: { a: 1 } });
  assert.deepEqual(extractLogicalFramePayload({
    ...framePayload({ kind: "deltas", deltas: [{ op: 1 }] }),
    kind: "complete",
  }), { kind: "deltas", deltas: [{ op: 1 }] });
});

test("complete 帧非快照/非增量 payload → null", () => {
  assert.equal(extractLogicalFramePayload({ kind: "complete", frame: { payload: { kind: "other" } } }), null);
  assert.equal(extractLogicalFramePayload({ kind: "complete", frame: null }), null);
});

test("fragment 乱序重组：集齐那一片返回整帧，未集齐为 null", () => {
  // 逻辑帧（{frame:{payload}} 同 complete 形态）序列化后按字节切 3 片，乱序投递
  const json = JSON.stringify({ payload: { kind: "snapshot", snapshot: { goal: "run" } } });
  const bytes = Buffer.from(json, "utf8");
  const size = Math.ceil(bytes.length / 3);
  const frag = (i: number) => ({
    kind: "fragment",
    logicalFrameId: "lf-1",
    fragmentIndex: i,
    fragmentCount: 3,
    dataBase64: bytes.subarray(i * size, (i + 1) * size).toString("base64"),
  });
  assert.equal(extractLogicalFramePayload(frag(1)), null);
  assert.equal(extractLogicalFramePayload(frag(2)), null);
  assert.deepEqual(extractLogicalFramePayload(frag(0)), { kind: "snapshot", snapshot: { goal: "run" } });
});

test("fragment 坏形状（缺 id/越界 index/坏 base64）→ null", () => {
  assert.equal(
    extractLogicalFramePayload({ kind: "fragment", fragmentIndex: 0, fragmentCount: 2, dataBase64: "aGk=" }),
    null,
  );
  assert.equal(
    extractLogicalFramePayload({ kind: "fragment", logicalFrameId: "x", fragmentIndex: 2, fragmentCount: 2, dataBase64: "aGk=" }),
    null,
  );
});

test("非帧形态（null/字符串/其它 kind）→ null；topic 提取", () => {
  assert.equal(extractLogicalFramePayload(null), null);
  assert.equal(extractLogicalFramePayload("x"), null);
  assert.equal(extractLogicalFramePayload({ kind: "mystery" }), null);
  assert.equal(wireFrameTopic({ topic: "goal" }), "goal");
  assert.equal(wireFrameTopic({ topic: "" }), undefined);
  assert.equal(wireFrameTopic({}), undefined);
  assert.equal(wireFrameTopic(null), undefined);
});
