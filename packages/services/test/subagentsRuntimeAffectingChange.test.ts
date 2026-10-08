import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

/**
 * subagent 配置变更 → runtime 回收通知的契约。
 *
 * 背景：runtime 进程在 bootstrap 一次性读入 subagent profiles 与模型覆盖
 * （launcher 闭包冻结，无热更新通道）。用户改完 subagents 默认模型后，
 * 已有 runtime 继续用旧模型派发，重启应用才生效——host 靠本回调立即回收
 * 闲置进程，让下一次派发读到新配置。
 *
 * 运行：npx tsx --test packages/services/test/subagentsRuntimeAffectingChange.test.ts
 */

function createFixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "zg-subagents-notify-"));
  let notified = 0;
  const service = createSubagentsService({
    homeDir,
    onRuntimeAffectingChange: () => {
      notified += 1;
    },
  });
  return {
    homeDir,
    service,
    count: () => notified,
    async [Symbol.asyncDispose || Symbol.for("Symbol.asyncDispose")]() {
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

test("setBuiltInModelOverride 落盘后触发 runtime 回收通知", async () => {
  const fx = createFixture();
  try {
    await fx.service.setBuiltInModelOverride({
      agentName: "general-purpose",
      modelSelection: { providerId: "p1", modelId: "m1" },
    });
    assert.equal(fx.count(), 1);
    // 清除（回默认）同样算变更。
    await fx.service.setBuiltInModelOverride({
      agentName: "general-purpose",
      modelSelection: null,
    });
    assert.equal(fx.count(), 2);
  } finally {
    await fx[Symbol.asyncDispose]();
  }
});

test("setPluginAgentModelOverride 落盘后触发通知", async () => {
  const fx = createFixture();
  try {
    await fx.service.setPluginAgentModelOverride({
      agentId: "plugin:demo:helper",
      modelSelection: { providerId: "p1", modelId: "m1" },
    });
    assert.equal(fx.count(), 1);
  } finally {
    await fx[Symbol.asyncDispose]();
  }
});

test("create/update/delete/setEnabled 均触发通知", async () => {
  const fx = createFixture();
  try {
    const { agent } = await fx.service.createAgent({
      config: {
        name: "my-helper",
        description: "test agent",
        systemPrompt: "You are a helper.",
      },
      provider: "zai",
      scope: "user",
    });
    assert.equal(fx.count(), 1);

    await fx.service.updateAgent({
      agentId: agent.id,
      config: {
        name: "my-helper",
        description: "updated",
        systemPrompt: "You are a helper v2.",
      },
      provider: "zai",
      scope: "user",
      oldFilePath: agent.path,
    });
    assert.equal(fx.count(), 2);

    await fx.service.setEnabled({ agentId: agent.id, enabled: false });
    assert.equal(fx.count(), 3);

    await fx.service.deleteAgent({ agentId: agent.id, filePath: agent.path });
    assert.equal(fx.count(), 4);
  } finally {
    await fx[Symbol.asyncDispose]();
  }
});

test("读取路径不触发通知", async () => {
  const fx = createFixture();
  try {
    await fx.service.list({ workspacePath: "/tmp/ws" });
    assert.equal(fx.count(), 0);
  } finally {
    await fx[Symbol.asyncDispose]();
  }
});
