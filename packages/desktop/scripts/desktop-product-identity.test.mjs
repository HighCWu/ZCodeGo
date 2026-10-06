import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopProductIdentities,
  isPreviewIdentityRequested,
  isStandaloneIdentityRequested,
  resolveDesktopProductFlavor,
  resolveDesktopProductIdentity,
} from "./desktop-product-identity.mjs";

/**
 * 桌面产品身份（flavor）解析契约：standalone（zcode-go 独立完整桌面版）>
 * preview > 后端环境推导；身份开关仅认精确 "1"/"0"，其它拼写构建期硬失败。
 * 运行：node --test packages/desktop/scripts/desktop-product-identity.test.mjs
 */

test("standalone 身份优先于一切（含 preview 同时打开时）", () => {
  assert.equal(
    resolveDesktopProductFlavor({ ZCODE_GO_STANDALONE_IDENTITY: "1", ZCODE_PREVIEW_IDENTITY: "1", ZCODE_ENV: "production" }),
    "standalone",
  );
  const identity = resolveDesktopProductIdentity({ ZCODE_GO_STANDALONE_IDENTITY: "1" });
  assert.equal(identity.productName, "ZCode Go");
  assert.equal(identity.linuxExecutableName, "zcode-go");
  assert.equal(identity.appId, "dev.zcodego.app");
  assert.ok(desktopProductIdentities.standalone);
});

test("preview 与环境推导保持原语义", () => {
  assert.equal(resolveDesktopProductFlavor({ ZCODE_PREVIEW_IDENTITY: "1", ZCODE_ENV: "production" }), "preview");
  assert.equal(resolveDesktopProductFlavor({ ZCODE_ENV: "production" }), "production");
  assert.equal(resolveDesktopProductFlavor({ ZCODE_ENV: "test" }), "preview");
  assert.equal(resolveDesktopProductFlavor({}), "preview");
});

test("身份开关严格拼写：非 1/0 直接抛错（构建期拦截）", () => {
  assert.throws(() => isStandaloneIdentityRequested({ ZCODE_GO_STANDALONE_IDENTITY: "true" }), /expected 1 or 0/);
  assert.throws(() => isPreviewIdentityRequested({ ZCODE_PREVIEW_IDENTITY: "yes" }), /expected 1 or 0/);
  assert.equal(isStandaloneIdentityRequested({ ZCODE_GO_STANDALONE_IDENTITY: "0" }), false);
  assert.equal(isStandaloneIdentityRequested({}), false);
  assert.equal(isStandaloneIdentityRequested({ ZCODE_GO_STANDALONE_IDENTITY: "1" }), true);
});
