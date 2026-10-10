import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearZcodeGoSessionRedirect,
  getZcodeGoSessionRedirect,
  listZcodeGoSessionRedirects,
  lookupZcodeGoOriginalSession,
  resolveZcodeGoSessionId,
  resolveZcodeGoSessionIdForRead,
  resolveZcodeGoSessionIdForSend,
  setZcodeGoSessionRedirect,
  translateConversationTopicForRouteLookup,
  resetZcodeGoSessionRedirectCacheForTest,
} from "../src/zcode-agent/zcodeGoSessionRedirect.js";

/**
 * zcode-go 静默 fork：redirect map 契约。
 * - 原会话是稳定键：resolve 命中返回活跃 fork，未命中原样返回；
 * - 反查（帧回写/索引 syncer 用）：fork → 原会话；
 * - 轮换 = 同键再 set（链长恒 1）；清除即回退直连；
 * - 文件损坏/缺失 → 空表不阻塞任何调用方。
 * 运行：ZCODE_GO_STATE_DIR_OVERRIDE 指向临时目录 + tsx --test。
 */

test("set/resolve/反查/轮换/清除 全链", () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-redirect-"));
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = dir;
  resetZcodeGoSessionRedirectCacheForTest();
  try {
    const S = "sess_original00000";
    const S1 = "sess_fork111111111";
    const S2 = "sess_fork222222222";

    assert.equal(resolveZcodeGoSessionId(S), S, "未命中原样返回");
    assert.equal(lookupZcodeGoOriginalSession(S1), null);
    assert.equal(getZcodeGoSessionRedirect(S), null);

    setZcodeGoSessionRedirect(S, { forkSessionId: S1, createdAt: 1, createdBy: "manual" });
    assert.equal(resolveZcodeGoSessionId(S), S1);
    assert.equal(lookupZcodeGoOriginalSession(S1), S);
    assert.equal(getZcodeGoSessionRedirect(S)?.forkSessionId, S1);
    assert.equal(listZcodeGoSessionRedirects().length, 1);

    // 轮换：同键覆盖（链长恒 1，无需递归）
    setZcodeGoSessionRedirect(S, { forkSessionId: S2, createdAt: 2, createdBy: "auto-compaction" });
    assert.equal(resolveZcodeGoSessionId(S), S2);
    assert.equal(lookupZcodeGoOriginalSession(S1), null, "旧 fork 不再是活跃端");
    assert.equal(lookupZcodeGoOriginalSession(S2), S);

    clearZcodeGoSessionRedirect(S);
    assert.equal(resolveZcodeGoSessionId(S), S, "清除后回退直连");
    assert.equal(listZcodeGoSessionRedirects().length, 0);
  } finally {
    delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    resetZcodeGoSessionRedirectCacheForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件缺失/损坏 → 空表，不阻塞调用方", () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-redirect-broken-"));
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = dir;
  writeFileSync(join(dir, "session-redirect.json"), "{broken json", "utf8");
  resetZcodeGoSessionRedirectCacheForTest();
  try {
    assert.equal(resolveZcodeGoSessionId("sess_x"), "sess_x");
    assert.equal(lookupZcodeGoOriginalSession("sess_y"), null);
    assert.deepEqual(listZcodeGoSessionRedirects(), []);
    // 写操作在损坏文件上应重建为空表后成功
    setZcodeGoSessionRedirect("sess_a", {
      forkSessionId: "sess_b",
      createdAt: 3,
      createdBy: "manual",
    });
    assert.equal(resolveZcodeGoSessionId("sess_a"), "sess_b");
  } finally {
    delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    resetZcodeGoSessionRedirectCacheForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("路由查找翻译：renderer 视角 topic → runtime fork topic；无 redirect 恒等", () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-redirect-translate-"));
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = dir;
  resetZcodeGoSessionRedirectCacheForTest();
  try {
    const S = "sess_route0000000001";
    const F = "sess_forkR0000000001";
    const F2 = "sess_forkR0000000002";

    // 无 redirect：恒等（冷打开等场景零行为变化）
    assert.equal(translateConversationTopicForRouteLookup(`conversation/${S}`), `conversation/${S}`);
    // 非 conversation topic 原样
    assert.equal(
      translateConversationTopicForRouteLookup("sessions-index/ws"),
      "sessions-index/ws",
    );
    // 非 sess_ 前缀原样
    assert.equal(translateConversationTopicForRouteLookup("conversation/other"), "conversation/other");

    // redirect 建立后翻译到 fork
    setZcodeGoSessionRedirect(S, { forkSessionId: F, createdAt: 1, createdBy: "auto-compaction" });
    assert.equal(translateConversationTopicForRouteLookup(`conversation/${S}`), `conversation/${F}`);
    // fork 自身不受影响
    assert.equal(translateConversationTopicForRouteLookup(`conversation/${F}`), `conversation/${F}`);

    // 轮换：翻译跟随最新 fork（链长恒 1）
    setZcodeGoSessionRedirect(S, { forkSessionId: F2, createdAt: 2, createdBy: "auto-compaction" });
    assert.equal(translateConversationTopicForRouteLookup(`conversation/${S}`), `conversation/${F2}`);

    // 清除后回退恒等
    clearZcodeGoSessionRedirect(S);
    assert.equal(translateConversationTopicForRouteLookup(`conversation/${S}`), `conversation/${S}`);
  } finally {
    delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    resetZcodeGoSessionRedirectCacheForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hover 表项按域翻译：send 域→端点；read/subscribe 域→原会话本体", () => {
  const dir = mkdtempSync(join(tmpdir(), "zg-redirect-hover-"));
  process.env.ZCODE_GO_STATE_DIR_OVERRIDE = dir;
  resetZcodeGoSessionRedirectCacheForTest();
  try {
    const F = "sess_hoverfork0000001"; // fork 对外 ID（全量档案）
    const EP = "sess_hoverendp0000001"; // 精简活跃端点
    setZcodeGoSessionRedirect(F, {
      forkSessionId: EP,
      createdAt: 1,
      createdBy: "manual",
      hover: true,
    });
    // send 域：翻译到精简端点
    assert.equal(resolveZcodeGoSessionId(F), EP);
    // read/subscribe 域：保持 F 本体（全量档案渐进补齐）
    assert.equal(resolveZcodeGoSessionIdForRead(F), F);
    // 非 hover 表项：read 域照旧翻译（silent fork 语义不变）
    const S = "sess_silentfk0000001";
    const SF = "sess_silentfkF000001";
    setZcodeGoSessionRedirect(S, { forkSessionId: SF, createdAt: 2, createdBy: "auto-compaction" });
    assert.equal(resolveZcodeGoSessionIdForRead(S), SF);
    assert.equal(resolveZcodeGoSessionIdForSend(S), SF);
  } finally {
    delete process.env.ZCODE_GO_STATE_DIR_OVERRIDE;
    resetZcodeGoSessionRedirectCacheForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});
