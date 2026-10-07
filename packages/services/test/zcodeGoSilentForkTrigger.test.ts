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

test("轮换时效：老表项 + 新 compaction arm → notify；arm 早于表项建立（重放）→ 丢弃", async () => {
  await withTempStateDir(async () => {
    const S = "sess_rotation_1111";
    // 表项建立于 60s 前（上一次 fork/轮换），现在观测到新 compaction 帧
    setZcodeGoSessionRedirect(S, {
      forkSessionId: "sess_rotation_f1",
      createdAt: Date.now() - 60_000,
      createdBy: "auto-compaction",
    });
    const notified: Array<{ sessionId: string }> = [];
    setZcodeGoSilentForkDelegate({
      notifyArm: (params) => notified.push(params),
      checkQuiescence: async () => true,
    });

    observeZcodeGoSilentForkFrame(WORKSPACE, compactionFrame(S));
    backdateZcodeGoSilentForkArmedAtForTest(S, 6_000);
    await checkArmedSessionsAndTrigger();
    assert.equal(notified.length, 1, "老表项 + 新帧 → 轮换 notify");

    // 重放场景：表项刚建立（createdAt=now），armed 回拨到表项建立前 → 丢弃
    const S2 = "sess_replay_111111";
    setZcodeGoSessionRedirect(S2, {
      forkSessionId: "sess_replay_f1",
      createdAt: Date.now(),
      createdBy: "auto-compaction",
    });
    const notified2: unknown[] = [];
    setZcodeGoSilentForkDelegate({
      notifyArm: (params) => notified2.push(params),
      checkQuiescence: async () => true,
    });
    observeZcodeGoSilentForkFrame(WORKSPACE, compactionFrame(S2));
    backdateZcodeGoSilentForkArmedAtForTest(S2, 6_000);
    await checkArmedSessionsAndTrigger();
    assert.equal(notified2.length, 0, "armed 早于表项建立（重放信号）被丢弃");
  });
});

test("门闩：无 latch 立即过；超时兜底放行；fork 身份变化提前放行（轮换语义）", async () => {
  await withTempStateDir(async () => {
    const S = "sess_latch_111111111";

    const t0 = Date.now();
    await waitForZcodeGoSilentForkGate(S);
    assert.ok(Date.now() - t0 < 50, "无门闩不等待");

    // 首 fork：latch 时无表项；同表项不动（轮换期间旧表项恒在，必须等身份变化）
    armZcodeGoSilentForkLatch(S, 120);
    const t1 = Date.now();
    await waitForZcodeGoSilentForkGate(S);
    assert.ok(Date.now() - t1 >= 100, "fork 身份未变化时等到超时兜底放行");

    // 首 fork：null → S1 提前放行
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
    assert.ok(Date.now() - t2 < 5_000, "首 fork 表项出现提前放行");

    // 轮换：S1 → S2 提前放行（旧表项在 latch 期间已存在，存在性不构成放行）
    armZcodeGoSilentForkLatch(S, 10_000);
    setTimeout(() => {
      setZcodeGoSessionRedirect(S, {
        forkSessionId: "sess_latch_fork_2",
        createdAt: Date.now(),
        createdBy: "auto-compaction",
      });
    }, 60);
    const t3 = Date.now();
    await waitForZcodeGoSilentForkGate(S);
    assert.ok(Date.now() - t3 < 5_000, "轮换表项身份变化提前放行");
  });
});
