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
  setZcodeGoSessionRedirect,
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
