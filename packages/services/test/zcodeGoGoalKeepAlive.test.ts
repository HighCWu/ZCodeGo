import assert from "node:assert/strict";
import test from "node:test";
import { authoritativeGoalStatus } from "../src/zcode-agent/zcodeGoGoalKeepAlive.js";

/**
 * goal 看门狗的权威状态裁定：v4 投影把手动 paused 与 budget_limited 都压成
 * "paused"（见会话历史：见 paused 就续跑会误拉起手动暂停），运行时原生状态
 * 才是权威——runtime 优先于 projection，缺失回退，两者皆无返回 undefined。
 * 运行：npx tsx --test packages/services/test/zcodeGoGoalKeepAlive.test.ts
 */
test("runtime.target.status 优先于 projection", () => {
  assert.equal(
    authoritativeGoalStatus({
      runtime: { target: { status: "budget_limited" } },
      projection: { target: { status: "paused" } },
    }),
    "budget_limited",
  );
});

test("runtime 缺失时回退 projection", () => {
  assert.equal(
    authoritativeGoalStatus({ projection: { target: { status: "paused" } } }),
    "paused",
  );
  assert.equal(authoritativeGoalStatus({ runtime: null, projection: { target: { status: "active" } } }), "active");
});

test("非字符串/缺失状态与空快照 → undefined（调用方进入重试裁定）", () => {
  assert.equal(authoritativeGoalStatus({ runtime: { target: { status: 1 } } }), undefined);
  assert.equal(authoritativeGoalStatus({ runtime: { target: {} } }), undefined);
  assert.equal(authoritativeGoalStatus({}), undefined);
  assert.equal(authoritativeGoalStatus(null), undefined);
  assert.equal(authoritativeGoalStatus(undefined), undefined);
});
