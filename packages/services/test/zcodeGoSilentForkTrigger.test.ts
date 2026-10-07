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
 * zcode-go 静默 fork 触发器契约（帧形状对齐 wire 层真实结构）。
 * - 观测：online 增量的 timelineMarker(compact, success) → armed（complete 与
 *   fragment 分片两形态）；initial/recovery 重放与非 success 终态不 arm；
 *   delegate 未接线（CLI/server）不观测；
 * - 静默点：quiescence false 不 notify；true 才 notify（workspace 一并透传）；
 * - 轮换时效：老表项 + 新 arm → notify；arm 早于表项建立（重放）→ 丢弃；
 * - 门闩：无 latch 立即过；fork 身份变化提前放行；超时兜底放行。
 */

const WORKSPACE = { workspacePath: "/tmp/ws" };

type Wire = Parameters<typeof observeZcodeGoSilentForkFrame>[1];

/** 真实形状：complete 帧，逻辑载荷在 frame 键内（UI 行投影）。 */
function completeFrame(
  sessionId: string,
  payload: unknown,
  deliveryKind: "initial" | "online" | "recovery" = "online",
): Wire {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `lf_${Math.random().toString(36).slice(2)}`,
    logicalFrameOrdinal: 1,
    topic: `conversation/${sessionId}`,
    subscriptionId: "sub_test",
    frame: {
      topic: `conversation/${sessionId}`,
      subscriptionId: "sub_test",
      fromSeq: 0,
      toSeq: 1,
      sentAt: Date.now(),
      payload,
    },
  } as Wire;
}

/** 真实形状：fragment 分片帧（frame 的 JSON 字节切片、各片独立 base64）。 */
function fragmentFrames(sessionId: string, payload: unknown, chunks = 3): Wire[] {
  const frame = {
    topic: `conversation/${sessionId}`,
    subscriptionId: "sub_test",
    fromSeq: 0,
    toSeq: 1,
    sentAt: Date.now(),
    payload,
  };
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const logicalFrameId = `lf_${Math.random().toString(36).slice(2)}`;
  const size = Math.ceil(bytes.length / chunks);
  return Array.from({ length: chunks }, (_, i) => {
    const slice = bytes.subarray(i * size, Math.min((i + 1) * size, bytes.length));
    return {
      wireVersion: 3,
      kind: "fragment",
      deliveryKind: "online",
      logicalFrameId,
      logicalFrameOrdinal: 2,
      topic: `conversation/${sessionId}`,
      subscriptionId: "sub_test",
      fragmentIndex: i,
      fragmentCount: chunks,
      logicalBytes: bytes.length,
      checksum: "abcd1234",
      dataBase64: slice.toString("base64"),
    } as Wire;
  });
}

const compactDelta = (status: string) => ({
  kind: "deltas" as const,
  deltas: [
    {
      op: "row.appended",
      row: {
        rowId: 1,
        turnId: "t1",
        kind: "timelineMarker",
        marker: { type: "compact", origin: "auto", status },
      },
    },
  ],
});

const compactSuccessDelta = compactDelta("success");

function compactionFrame(sessionId: string): Wire {
  return completeFrame(sessionId, compactSuccessDelta);
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

test("观测判据：complete/fragment 均命中；重放/非 success/未接线 不 arm", async () => {
  await withTempStateDir(async () => {
    const notified: Array<{ sessionId: string }> = [];
    setZcodeGoSilentForkDelegate({
      notifyArm: (params) => notified.push(params),
      checkQuiescence: async () => true,
    });

    // fragment 分片（乱序送达）：完整重组后命中
    const SF = "sess_frag_111111111";
    const frags = fragmentFrames(SF, compactSuccessDelta);
    observeZcodeGoSilentForkFrame(WORKSPACE, frags[2]!);
    observeZcodeGoSilentForkFrame(WORKSPACE, frags[0]!);
    let notifiedCount = 0;
    // 仅两片（缺一片）不触发
    backdateZcodeGoSilentForkArmedAtForTest(SF, 6_000);
    await checkArmedSessionsAndTrigger();
    notifiedCount = notified.length;
    observeZcodeGoSilentForkFrame(WORKSPACE, frags[1]!);
    backdateZcodeGoSilentForkArmedAtForTest(SF, 6_000);
    await checkArmedSessionsAndTrigger();
    assert.equal(notified.length, notifiedCount + 1, "分片齐全重组后 arm 并 notify");

    // initial 投递的快照重放（历史 compact 标记）：不 arm
    const SI = "sess_replay_snap";
    observeZcodeGoSilentForkFrame(
      WORKSPACE,
      completeFrame(
        SI,
        {
          kind: "snapshot",
          snapshot: {
            rows: {
              window: [
                { rowId: 1, kind: "timelineMarker", marker: { type: "compact", origin: "auto", status: "success" } },
              ],
            },
          },
        },
        "initial",
      ),
    );
    backdateZcodeGoSilentForkArmedAtForTest(SI, 6_000);
    const before = notified.length;
    await checkArmedSessionsAndTrigger();
    assert.equal(notified.length, before, "initial 快照重放不 arm");

    // recovery 投递的增量重放：不 arm
    const SR = "sess_replay_recovery";
    observeZcodeGoSilentForkFrame(
      WORKSPACE,
      completeFrame(SR, compactSuccessDelta, "recovery"),
    );
    backdateZcodeGoSilentForkArmedAtForTest(SR, 6_000);

    // deliveryKind 缺省：按 online 处理（与 taskIndexSyncer 惯例一致）→ arm
    const SD = "sess_default_kind_11";
    const noKind = compactionFrame(SD) as { deliveryKind?: unknown };
    delete noKind.deliveryKind;
    observeZcodeGoSilentForkFrame(WORKSPACE, noKind);
    backdateZcodeGoSilentForkArmedAtForTest(SD, 6_000);

    // online 但 compact 终态非 success（cancelled/running/failed）：不 arm
    for (const status of ["cancelled", "running", "failed", "noop"]) {
      const SX = `sess_status_${status}`;
      observeZcodeGoSilentForkFrame(WORKSPACE, completeFrame(SX, compactDelta(status)));
      backdateZcodeGoSilentForkArmedAtForTest(SX, 6_000);
    }
    await checkArmedSessionsAndTrigger();
    assert.equal(notified.length, before + 1, "缺省 kind 按 online arm；recovery 不 arm；非 success 不 arm");

    // delegate 未接线（CLI/server 上下文）：完全不观测
    setZcodeGoSilentForkDelegate(null);
    const SC = "sess_cli_111111111";
    observeZcodeGoSilentForkFrame(WORKSPACE, compactionFrame(SC));
    backdateZcodeGoSilentForkArmedAtForTest(SC, 6_000);
    await checkArmedSessionsAndTrigger();
    // 恢复接线便于后续断言（通知数不变即未触发）
    const notified2: unknown[] = [];
    setZcodeGoSilentForkDelegate({
      notifyArm: (params) => notified2.push(params),
      checkQuiescence: async () => true,
    });
    await checkArmedSessionsAndTrigger();
    assert.equal(notified2.length, 0, "未接线期间观测被跳过（无遗留 armed）");
  });
});
