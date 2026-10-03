/* 冒烟测试：zcodeGoSubagentRecovery 检测→静置→核验→sendText 续跑全流程（模拟 agent）。 */
import { initZCodeGoSubagentRecovery, observeZcodeGoSubagentRecoveryFrame, disposeZCodeGoSubagentRecovery } from "../../packages/services/src/zcode-agent/zcodeGoSubagentRecovery.js";

const calls: string[] = [];
let childSnapshotSent = false;
const agent = {
  async subscribeConversationV4(params: { sessionId: string }) {
    calls.push(`subscribe:${params.sessionId}`);
    // 首次订阅触发子会话快照（末轮 failed、空闲）
    if (!childSnapshotSent) {
      childSnapshotSent = true;
      queueMicrotask(() =>
        observeZcodeGoSubagentRecoveryFrame(
          { workspacePath: "/tmp/ws" },
          {
            topic: `conversation/${params.sessionId}`,
            payload: {
              kind: "snapshot",
              snapshot: {
                sessionId: params.sessionId,
                control: { phase: "completedSuccess" },
                rows: {
                  window: [
                    { rowId: 1, kind: "turnHeader", state: "failed" },
                    { rowId: 2, kind: "userInput", text: "task" },
                  ],
                },
              },
            },
          },
        ),
      );
    }
    return { ack: { subscriptionId: "sub-1" } };
  },
  async unsubscribeConversationV4(params: { sessionId: string }) {
    calls.push(`unsubscribe:${params.sessionId}`);
    return {};
  },
  async sendConversationCommandV4(params: { sessionId: string; envelope: { type: string; payload: { text: string } } }) {
    calls.push(`send:${params.sessionId}:${params.envelope.type}`);
    return { status: "accepted" };
  },
};

initZCodeGoSubagentRecovery(agent as never, { logger: { info: (_t, m, e) => console.log("INFO", m, JSON.stringify(e)), warn: (_t, m, e) => console.log("WARN", m, JSON.stringify(e)), debug: (_t, m, e) => console.log("DEBUG", m, JSON.stringify(e)) } });

const parent = "sess_parent0000000000000000000000";
const child = "sess_child00000000000000000000000";

// 1) 连接类失败子智能体行（delta）→ 应入队
observeZcodeGoSubagentRecoveryFrame(
  { sessionId: parent, workspacePath: "/tmp/ws" },
  {
    topic: `conversation/${parent}`,
    payload: {
      kind: "deltas",
      deltas: [
        {
          op: "row.upserted",
          row: { rowId: 9, kind: "subagent", status: "failed", childSessionId: child, summaryText: "ZCode Protocol client connection closed", endedAt: 1000 },
        },
      ],
    },
  },
);

// 2) 非连接类失败 → 应跳过
observeZcodeGoSubagentRecoveryFrame(
  { sessionId: parent, workspacePath: "/tmp/ws" },
  {
    topic: `conversation/${parent}`,
    payload: {
      kind: "deltas",
      deltas: [
        { op: "row.upserted", row: { rowId: 10, kind: "subagent", status: "failed", childSessionId: "sess_other0000000000000000000", summaryText: "model refused", endedAt: 1001 } },
      ],
    },
  },
);

// 3) 同一条失败快照重放 → 不应重复入队
observeZcodeGoSubagentRecoveryFrame(
  { sessionId: parent, workspacePath: "/tmp/ws" },
  { topic: `conversation/${parent}`, payload: { kind: "snapshot", snapshot: { sessionId: parent, control: { phase: "completedSuccess" }, rows: { window: [{ rowId: 9, kind: "subagent", status: "failed", childSessionId: child, summaryText: "ZCode Protocol client connection closed", endedAt: 1000 }] } } } },
);

// 4) 快照重放在静置窗口过后出现 → 也不应再次触发（handled 水位）
setTimeout(() => {
  observeZcodeGoSubagentRecoveryFrame(
    { sessionId: parent, workspacePath: "/tmp/ws" },
    { topic: `conversation/${parent}`, payload: { kind: "snapshot", snapshot: { sessionId: parent, control: { phase: "completedSuccess" }, rows: { window: [{ rowId: 9, kind: "subagent", status: "failed", childSessionId: child, summaryText: "ZCode Protocol client connection closed", endedAt: 1000 }] } } } },
  );
}, 31_000);

setTimeout(() => {
  console.log("\n=== calls ===");
  for (const c of calls) console.log(c);
  const sent = calls.filter((c) => c.startsWith(`send:${child}`));
  const subscribed = calls.filter((c) => c === `subscribe:${child}`);
  const unsubscribed = calls.filter((c) => c === `unsubscribe:${child}`);
  const ok =
    subscribed.length === 1 &&
    unsubscribed.length === 1 &&
    sent.length === 1 &&
    !calls.some((c) => c.includes("sess_other"));
  console.log(ok ? "\nSMOKE PASS" : "\nSMOKE FAIL");
  disposeZCodeGoSubagentRecovery();
  process.exit(ok ? 0 : 1);
}, 40_000);
