import assert from "node:assert/strict";
import test from "node:test";
import { computeViewportTier } from "../src/hooks/useViewportTier.js";
import { resolveComposerAutoFocus } from "../src/v4/composer/composerAutoFocus.js";
import { shouldOfferSideSlashCommand } from "../src/slashCommandHelpers.js";

/**
 * zcode-go 移动端行为纯函数契约：
 * - viewport 分层（<768 mobile / <1024 tablet / desktop）驱动抽屉形态；
 * - composer 自动聚焦在移动视口一律 skip（防软键盘顶起整页）；
 * - /side 选中侧聊是桌面分栏概念，移动端不提供。
 * 运行：npx tsx --test packages/ui/test/zcodeGoMobileBehavior.test.ts
 * （node 环境无 window：computeViewportTier 按其 SSR 分支返回 desktop）
 */

test("computeViewportTier：SSR/无 window 分支返回 desktop", () => {
  assert.equal(computeViewportTier(), "desktop");
});

test("resolveComposerAutoFocus：三态决策", () => {
  // 未启用 → skip；移动视口 → skip（即使已启用且可编辑）
  assert.equal(resolveComposerAutoFocus({ autoFocusEnabled: false, disabled: false, isMobileViewport: false }), "skip");
  assert.equal(resolveComposerAutoFocus({ autoFocusEnabled: true, disabled: false, isMobileViewport: true }), "skip");
  // 已启用且可编辑 → focus-now；连接中（disabled）→ defer 暂存意图
  assert.equal(resolveComposerAutoFocus({ autoFocusEnabled: true, disabled: false, isMobileViewport: false }), "focus-now");
  assert.equal(resolveComposerAutoFocus({ autoFocusEnabled: true, disabled: true, isMobileViewport: false }), "defer");
});

test("shouldOfferSideSlashCommand：四条件全满足才提供", () => {
  assert.equal(
    shouldOfferSideSlashCommand({ isDraft: false, selectionSideChat: false, readOnly: false, isMobileViewport: false }),
    true,
  );
  assert.equal(
    shouldOfferSideSlashCommand({ isDraft: true, selectionSideChat: false, readOnly: false, isMobileViewport: false }),
    false,
  );
  assert.equal(
    shouldOfferSideSlashCommand({ isDraft: false, selectionSideChat: true, readOnly: false, isMobileViewport: false }),
    false,
  );
  assert.equal(
    shouldOfferSideSlashCommand({ isDraft: false, selectionSideChat: false, readOnly: true, isMobileViewport: false }),
    false,
  );
  assert.equal(
    shouldOfferSideSlashCommand({ isDraft: false, selectionSideChat: false, readOnly: false, isMobileViewport: true }),
    false,
  );
});
