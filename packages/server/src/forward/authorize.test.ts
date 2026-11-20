// 转发出口的闸门：只认会话 Cookie。应用自己的 Authorization（比如 JWT 的 Bearer）要原样放过去，不能拿来当 Server 令牌判。
import { expect, test } from "vitest";
import { createForwardAuthorizer } from "./authorize.js";

const TOKEN = "k".repeat(40);

test("没配令牌（只允许回环监听）：一律放行", () => {
  expect(createForwardAuthorizer(undefined)({})).toBe(true);
});

test("配了令牌：Cookie 里的会话令牌对得上才放行；没有、不对、同名前缀都拒绝", () => {
  const ok = createForwardAuthorizer(TOKEN);
  expect(ok({ cookie: `ys_session=${TOKEN}` })).toBe(true);
  expect(ok({ cookie: `theme=dark; ys_session=${TOKEN}` })).toBe(true);
  expect(ok({})).toBe(false);
  expect(ok({ cookie: `ys_session=${"x".repeat(40)}` })).toBe(false);
  expect(ok({ cookie: `ys_session_other=${TOKEN}` })).toBe(false);
});

test("Authorization: Bearer 与 WebSocket 子协议里的令牌不算：对的拒绝，应用自己的 Bearer 也不影响 Cookie 判定", () => {
  const ok = createForwardAuthorizer(TOKEN);
  expect(ok({ authorization: `Bearer ${TOKEN}` })).toBe(false);
  expect(
    ok({
      upgrade: "websocket",
      "sec-websocket-protocol": `yuanshu.v1, bearer.${TOKEN}`,
    }),
  ).toBe(false);
  expect(
    ok({ authorization: "Bearer app-jwt", cookie: `ys_session=${TOKEN}` }),
  ).toBe(true);
});
