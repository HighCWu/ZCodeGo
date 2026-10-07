import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ZCODE_GO_GOAL_VERIFY_MARKER } from "@zcode/shared";

// 时序缩放必须在模块常量求值前生效（静态 import 会先于本行执行）——动态 import。
// 场景串行在一个 test 内执行：模块持进程级全局态（agent/基线表），node:test
// 顶层并发会互相 dispose 谋杀在途复核流程。
process.env.ZCODE_GO_GOAL_VERIFY_TIMING_SCALE ||= "0.02";
const {
  disposeZCodeGoGoalVerify,
  initZCodeGoGoalVerify,
  observeZcodeGoConversationFrame,
  observeZcodeGoSessionsIndexFrame,
} = await import("../src/zcode-agent/zcodeGoGoalVerify.js");
type ZcodeGoGoalVerifyAgent = import("../src/zcode-agent/zcodeGoGoalVerify.js").ZcodeGoGoalVerifyAgent;

/**
 * zcode-go goal 复核契约（帧形状对齐 wire 层真实结构）。
 *
 * 历史：两个观察函数曾直接读 wire 顶层 payload 键（永不存在）+ goal 路径误写
 * projection.target（实为 session.target）——三处叠加使整条链路自诞生起静默
 * 失效。本测试用 schema 精确形状（complete 帧 / frame 键内逻辑载荷 / 行投影）
 * 驱动全链：verified 边沿 → readSession 判 goal → 发判定 → 按「标记 tag →
 * turnId」收集回复 → false 重触发 / true 双确认 / 快照重放不触发。
 */

const WORKSPACE = { workspacePath: "/tmp/ws-goal" };

function completeFrame(topic: string, payload: unknown, deliveryKind: string): unknown {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `lf_${randomUUID()}`,
    logicalFrameOrdinal: 1,
    topic,
    subscriptionId: "sub_idx",
    frame: {
      topic,
      subscriptionId: "sub_idx",
      fromSeq: 0,
      toSeq: 1,
      sentAt: Date.now(),
      payload,
    },
  };
}

const indexDelta = (session: unknown) =>
  completeFrame(
    "sessions-index/ws",
    { kind: "deltas", deltas: [{ op: "session.upserted", session }] },
    "online",
  );

const indexSnapshot = (sessions: unknown[]) =>
  completeFrame("sessions-index/ws", { kind: "snapshot", snapshot: { sessions } }, "initial");

/** conversation complete 帧（真实形状：逻辑载荷在 frame 键内，行为 UI 投影）。 */
function conversationDeltaFrame(sessionId: string, rows: unknown[]): unknown {
  return completeFrame(
    `conversation/${sessionId}`,
    {
      kind: "deltas",
      deltas: rows.map((row) => ({ op: "row.appended", row })),
    },
    "online",
  );
}

interface AgentCalls {
  readSession: string[];
  sendText: Array<{ sessionId: string; text: string }>;
  sendGoalCommand: Array<{ sessionId: string; text: string }>;
  subscribes: string[];
}

function createMockAgent(params: {
  objective: string;
  goalStatus: string;
  /** 收到判定输入后异步回帧（模拟 relay）；返回本轮判定 JSON。 */
  replyFor: (promptText: string) => { passed: boolean; reason: string };
  /** 判定输入送达时的干扰帧（旧格式标记/无关 turn）。 */
  decoy?: () => void;
}): { agent: ZcodeGoGoalVerifyAgent; calls: AgentCalls } {
  const calls: AgentCalls = { readSession: [], sendText: [], sendGoalCommand: [], subscribes: [] };
  const agent: ZcodeGoGoalVerifyAgent = {
    subscribeConversationV4: async (p) => {
      calls.subscribes.push(p.sessionId);
      return { ack: { subscriptionId: `sub_${randomUUID().slice(0, 8)}` } };
    },
    unsubscribeConversationV4: async () => ({}),
    readSession: async (p) => {
      calls.readSession.push(p.sessionId);
      return {
        session: {
          sessionId: p.sessionId,
          target: { objective: params.objective, status: params.goalStatus },
        },
      };
    },
    sendConversationCommandV4: async (p) => {
      if (p.envelope.type === "sendGoalCommand") {
        calls.sendGoalCommand.push({
          sessionId: p.sessionId,
          text: (p.envelope.payload as { text: string }).text,
        });
        return { status: "accepted" };
      }
      const text = (p.envelope.payload as { text: string }).text;
      calls.sendText.push({ sessionId: p.sessionId, text });
      // 模拟 relay：输入行（带标记）→ 干扰 → 回复行（同 turnId）延迟送达
      const turnId = `turn_${randomUUID().slice(0, 8)}`;
      setTimeout(() => {
        observeZcodeGoConversationFrame(
          WORKSPACE,
          conversationDeltaFrame(p.sessionId, [{ rowId: 1, turnId, kind: "userInput", text }]),
        );
        params.decoy?.();
        const verdict = params.replyFor(text);
        setTimeout(() => {
          observeZcodeGoConversationFrame(
            WORKSPACE,
            conversationDeltaFrame(p.sessionId, [
              {
                rowId: 2,
                turnId,
                kind: "assistantText",
                text: `${JSON.stringify(verdict)}\n(附说明)`,
              },
            ]),
          );
        }, 30);
      }, 20);
      return { status: "accepted" };
    },
  };
  return { agent, calls };
}

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "zg-goal-verify-"));
  const prev = process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = dir;
  disposeZCodeGoGoalVerify();
  try {
    return await fn();
  } finally {
    disposeZCodeGoGoalVerify();
    if (prev === undefined) delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    else process.env.ZCODE_GO_STATE_DIR_OVERRIDE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** verified 边沿 = 先以非 verified 进基线（在线增量），再在线迁移到 verified。 */
function fireVerifiedEdge(sessionId: string): void {
  observeZcodeGoSessionsIndexFrame(WORKSPACE, indexDelta({ sessionId, goalStatus: "verifying" }));
  observeZcodeGoSessionsIndexFrame(WORKSPACE, indexDelta({ sessionId, goalStatus: "verified" }));
}

test("goal 复核全链（串行三场景：重触发/双确认/重放防护）", async (t) => {
  await t.test("全链：verified 边沿 → 判定 false → 重触发 goal（真实 wire 帧形状）", async () => {
    await withEnv(async () => {
      const S = `sess_gv_${randomUUID().slice(0, 8)}`;
      const OBJECTIVE = "把构建修绿并跑通全部测试";
      const { agent, calls } = createMockAgent({
        objective: OBJECTIVE,
        goalStatus: "complete",
        replyFor: () => ({ passed: false, reason: "测试仍失败" }),
        // 干扰帧：旧格式标记（无 tag）+ 错误结论——不应被绑定
        decoy: () => {
          observeZcodeGoConversationFrame(
            WORKSPACE,
            conversationDeltaFrame(S, [
              {
                rowId: 9,
                turnId: "turn_old",
                kind: "userInput",
                text: `${ZCODE_GO_GOAL_VERIFY_MARKER} r1\n旧格式`,
              },
              {
                rowId: 10,
                turnId: "turn_old",
                kind: "assistantText",
                text: '{"passed": true, "reason": "干扰"}',
              },
            ]),
          );
        },
      });
      initZCodeGoGoalVerify(agent, { logger: { info() {}, warn() {}, debug() {} } });

      fireVerifiedEdge(S);
      for (let i = 0; i < 100 && calls.sendGoalCommand.length === 0; i += 1) await sleep(50);

      assert.ok(calls.readSession.includes(S), "边沿触发后 readSession（session.target 判 goal）");
      assert.equal(calls.sendText.length, 1, "首判判定消息已发送");
      assert.ok(
        calls.sendText[0]!.text.startsWith(`${ZCODE_GO_GOAL_VERIFY_MARKER} `),
        "判定消息带唯一 tag 标记",
      );
      assert.ok(calls.sendText[0]!.text.includes(OBJECTIVE), "判定消息包含 GOAL 原文");
      assert.equal(calls.sendGoalCommand.length, 1, "false 判定触发 sendGoalCommand 重触发");
      assert.equal(calls.sendGoalCommand[0]!.text, OBJECTIVE, "重触发携带原 objective");
      assert.ok(calls.subscribes.length >= 1, "复核订阅走 background 通道");
    });
  });

  await t.test("双确认：首判 true → r2 再判 true → 保持完成（不重触发）", async () => {
    await withEnv(async () => {
      const S = `sess_gv2_${randomUUID().slice(0, 8)}`;
      const OBJECTIVE = "发布周报";
      const { agent, calls } = createMockAgent({
        objective: OBJECTIVE,
        goalStatus: "complete",
        replyFor: (prompt) => ({
          passed: true,
          reason: prompt.includes(" r2") ? "二次确认通过" : "首判通过",
        }),
      });
      initZCodeGoGoalVerify(agent, { logger: { info() {}, warn() {}, debug() {} } });

      fireVerifiedEdge(S);
      for (let i = 0; i < 150 && calls.sendText.length < 2; i += 1) await sleep(50);
      await sleep(300);

      assert.equal(calls.sendText.length, 2, "两轮判定消息（r1 + r2）");
      assert.match(calls.sendText[0]!.text, / r1\n/, "首轮标记");
      assert.match(calls.sendText[1]!.text, / r2\n/, "二轮标记");
      assert.equal(calls.sendGoalCommand.length, 0, "双 true 不重触发");
    });
  });

  await t.test("重放防护：快照重放与无基线增量不触发复核", async () => {
    await withEnv(async () => {
      const S = `sess_gv3_${randomUUID().slice(0, 8)}`;
      const { agent, calls } = createMockAgent({
        objective: "x",
        goalStatus: "complete",
        replyFor: () => ({ passed: true, reason: "" }),
      });
      initZCodeGoGoalVerify(agent, { logger: { info() {}, warn() {}, debug() {} } });

      // 快照重放：历史 verified（无基线）
      observeZcodeGoSessionsIndexFrame(WORKSPACE, indexSnapshot([{ sessionId: S, goalStatus: "verified" }]));
      // 无基线的在线增量（首见即 verified）
      const S2 = `sess_gv4_${randomUUID().slice(0, 8)}`;
      observeZcodeGoSessionsIndexFrame(WORKSPACE, indexDelta({ sessionId: S2, goalStatus: "verified" }));
      await sleep(500);
      assert.equal(calls.readSession.length, 0, "快照重放/无基线不触发复核");

      // 基线建立后的真实迁移仍触发
      fireVerifiedEdge(S2);
      for (let i = 0; i < 100 && calls.readSession.length === 0; i += 1) await sleep(50);
      assert.ok(calls.readSession.includes(S2), "基线后的在线 verified 迁移正常触发");
    });
  });
});
