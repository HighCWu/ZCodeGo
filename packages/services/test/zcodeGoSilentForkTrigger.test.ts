import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armZcodeGoSilentForkLatch,
  backdateZcodeGoSilentForkArmedAtForTest,
  checkArmedSessionsAndTrigger,
  observeZcodeGoSilentForkFrame,
  resetZcodeGoSilentForkForTest,
  waitForZcodeGoSilentForkGate,
  setZcodeGoSilentForkDelegate,
} from "../src/zcode-agent/zcodeGoSilentForkTrigger.js";
import {
  resetZcodeGoSessionRedirectCacheForTest,
  setZcodeGoSessionRedirect,
} from "../src/zcode-agent/zcodeGoSessionRedirect.js";

/**
 * zcode-go 静默 fork 第二批：触发器契约。
 * - 静默点：quiescence false 不 notify；true 才 notify（workspace 一并透传）；
 * - 已有 redirect 的 armed 会话被清出且不 notify（上次 fork 仍在役）；
 * - 门闩：无 latch 立即过；redirect 表项出现提前放行；超时兜底放行。
 */

const WORKSPACE = { workspacePath: "/tmp/ws" };

function compactionFrame(sessionId: string) {
  return {
    topic: `conversation/${sessionId}`,
    payload: JSON.stringify({
      type: "conversation.appendPartsV4",
      parts: [{ type: "compaction", compactBoundary: true }],
    }),
  } as Parameters<typeof observeZcodeGoSilentForkFrame>[1];
}

async function withTempStateDir<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "zg-silent-fork-"));
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = dir;
  resetZcodeGoSessionRedirectCacheForTest();
  resetZcodeGoSilentForkForTest();
  try {
    return await fn();
  } finally {
    delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    resetZcodeGoSessionRedirectCacheForTest();
    resetZcodeGoSilentForkForTest();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("静默点触发：not quiet 不 notify；quiet 才 notify 并透传 workspace", async () => {
  await withTempStateDir(async () => {
    const S = "sess_trig_111111111";
    const notified: Array<{ sessionId: string; workspacePath: string }> = [];
    let quiet = false;
    setZcodeGoSilentForkDelegate({
      notifyArm: (params) => notified.push(params),
      checkQuiescence: async () => quiet,
    });

    observeZcodeGoSilentForkFrame(WORKSPACE, compactionFrame(S));
    backdateZcodeGoSilentForkArmedAtForTest(S, 6_000);

    await checkArmedSessionsAndTrigger();
    assert.equal(notified.length, 0, "not quiet 不 notify（armed 保留待重试）");

    quiet = true;
    await checkArmedSessionsAndTrigger();
    assert.equal(notified.length, 1, "quiet 后重试 notify");
    assert.equal(notified[0]?.sessionId, S);
    assert.equal(notified[0]?.workspacePath, WORKSPACE.workspacePath);

    // notify 后 armed 清空：再次触发不再 notify
    await checkArmedSessionsAndTrigger();
    assert.equal(notified.length, 1, "armed 已清，不再重复 notify");
  });
});

test("已有 redirect 的会话：观测不 arm，armed 残留被清出", async () => {
  await withTempStateDir(async () => {
    const S = "sess_redirected_111";
    setZcodeGoSessionRedirect(S, {
      forkSessionId: "sess_redirected_f1",
      createdAt: Date.now(),
      createdBy: "auto-compaction",
    });
    const notified: unknown[] = [];
    setZcodeGoSilentForkDelegate({
      notifyArm: (params) => notified.push(params),
      checkQuiescence: async () => true,
    });

    observeZcodeGoSilentForkFrame(WORKSPACE, compactionFrame(S));
    backdateZcodeGoSilentForkArmedAtForTest(S, 6_000);
    await checkArmedSessionsAndTrigger();
    assert.equal(notified.length, 0, "redirect 在役，不重复 fork");
  });
});

test("门闩：无 latch 立即过；超时兜底放行；redirect 出现提前放行", async () => {
  await withTempStateDir(async () => {
    const S = "sess_latch_111111111";

    const t0 = Date.now();
    await waitForZcodeGoSilentForkGate(S);
    assert.ok(Date.now() - t0 < 50, "无门闩不等待");

    armZcodeGoSilentForkLatch(S, 120);
    const t1 = Date.now();
    await waitForZcodeGoSilentForkGate(S);
    assert.ok(Date.now() - t1 >= 100, "无 redirect 时等到超时兜底放行");

    armZcodeGoSilentForkLatch(S, 10_000);
    setTimeout(() => {
      setZcodeGoSessionRedirect(S, {
        forkSessionId: "sess_latch_fork_1",
        createdAt: Date.now(),
        createdBy: "auto-compaction",
      });
    }, 60);
    const t2 = Date.now();
    await waitForZcodeGoSilentForkGate(S);
    assert.ok(Date.now() - t2 < 5_000, "redirect 出现提前放行");
  });
});
