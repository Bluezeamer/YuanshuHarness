// user 通道走尾部注入：只注入一次、内容来自预设、display 不污染历史。
import { expect, test } from "vitest";
import { userPromptExtension } from "./user-prompt.js";

/** 最小 pi 扩展宿主：只关心 before_agent_start 的注册与返回值 */
function fakePi() {
  const handlers: (() => unknown)[] = [];
  const pi = {
    on: (event: string, fn: () => unknown) => {
      if (event === "before_agent_start") handlers.push(fn);
    },
  };
  return {
    pi,
    fire: () => handlers.map((h) => h()),
  };
}

test("首轮注入 user 通道内容，第二轮不再注入", () => {
  const { pi, fire } = fakePi();
  let text: string | null = "开头提醒";
  const factory = userPromptExtension(() => text);
  factory(pi as never);
  const results = fire();
  expect(results[0]).toMatchObject({
    message: {
      customType: "yuanshu.user_prompt",
      content: "开头提醒",
      display: false,
    },
  });
  text = "变了";
  expect(fire()[0]).toBeUndefined();
});

test("没有内容时不注入，且不算用掉机会", () => {
  const { pi, fire } = fakePi();
  let text: string | null = null;
  userPromptExtension(() => text)(pi as never);
  expect(fire()[0]).toBeUndefined();
  text = "后来才有";
  expect(fire()[0]).toMatchObject({ message: { content: "后来才有" } });
});

test("空白内容视为没有", () => {
  const { pi, fire } = fakePi();
  userPromptExtension(() => "   ")(pi as never);
  expect(fire()[0]).toBeUndefined();
});
