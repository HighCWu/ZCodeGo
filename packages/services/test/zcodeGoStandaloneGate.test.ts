import assert from "node:assert/strict";
import test from "node:test";
import { isZcodeGoStandaloneRuntimeEnv } from "../src/zcode-agent/zcodeAgentProcessManager.js";

/**
 * zcode-go 独立版硬隔离开关的契约：仅精确 "1" 视为开启。
 * 与构建期 ZCODE_GO_STANDALONE_IDENTITY 的严格拼写（1/0，其余硬失败）同源；
 * 运行态对非法拼写保持关闭而非抛错（env 可能来自用户 shell，fail-open 到
 * 官方链比启动即炸更安全——插件/接管行为不受影响）。
 *
 * 运行：npx tsx --test packages/services/test/zcodeGoStandaloneGate.test.ts
 * （完整隔离行为的实机验证见 scripts/e2e 与双构建 standalone 套件：agent
 * 进程 exe 必须为随包 Electron，official.json 存在也不得命中。）
 */
test("isZcodeGoStandaloneRuntimeEnv 仅精确 1 开启", () => {
  assert.equal(isZcodeGoStandaloneRuntimeEnv({ ZCODE_GO_STANDALONE: "1" }), true);
  assert.equal(isZcodeGoStandaloneRuntimeEnv({ ZCODE_GO_STANDALONE: "0" }), false);
  assert.equal(isZcodeGoStandaloneRuntimeEnv({ ZCODE_GO_STANDALONE: "true" }), false);
  assert.equal(isZcodeGoStandaloneRuntimeEnv({ ZCODE_GO_STANDALONE: "" }), false);
  assert.equal(isZcodeGoStandaloneRuntimeEnv({}), false);
});
