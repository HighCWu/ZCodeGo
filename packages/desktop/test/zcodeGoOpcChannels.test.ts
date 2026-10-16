import { describe, expect, it } from "vitest";
import {
  parseTelegramUpdatesBody,
  selectAllowedTexts,
  type TelegramUpdate,
} from "../src/main/zcodeGoOpcChannels.js";

const UPDATE: TelegramUpdate = {
  update_id: 42,
  message: { text: "修复登录页样式", chat: { id: 12345 } },
};

describe("parseTelegramUpdatesBody", () => {
  it("标准响应解析出 updates", () => {
    const body = JSON.stringify({ ok: true, result: [UPDATE] });
    expect(parseTelegramUpdatesBody(body)).toEqual([UPDATE]);
  });

  it("坏 JSON / ok:false 返回 null（调用方保 offset）", () => {
    expect(parseTelegramUpdatesBody("not json")).toBeNull();
    expect(parseTelegramUpdatesBody(JSON.stringify({ ok: false }))).toBeNull();
  });
});

describe("selectAllowedTexts（deny-by-default）", () => {
  it("allowFrom 命中才放行文本消息", () => {
    expect(selectAllowedTexts([UPDATE], [12345])).toEqual([
      { chatId: "12345", text: "修复登录页样式", updateId: UPDATE.update_id },
    ]);
  });

  it("allowFrom 空数组 = 拒绝一切（deny-by-default）", () => {
    expect(selectAllowedTexts([UPDATE], [])).toEqual([]);
  });

  it("非白名单 chat / 无文本消息被过滤", () => {
    const other: TelegramUpdate = {
      update_id: 43,
      message: { text: "x", chat: { id: 999 } },
    };
    const noText: TelegramUpdate = {
      update_id: 44,
      message: { chat: { id: 12345 } },
    };
    expect(selectAllowedTexts([UPDATE, other, noText], [12345])).toHaveLength(
      1,
    );
  });
});
