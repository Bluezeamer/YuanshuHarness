import { expect, test } from "vitest";
import { cardIdsOf, holds, type PromptItem, parseItems } from "./items.js";

const model = { kind: "model" as const, providers: [], models: [] };
const m = (provider: string, name: string) => ({ provider, model: name });

test("条件：整个供应商或具体模型任一成立；没有模型时都不成立", () => {
  const c = { ...model, providers: ["local"], models: ["a/x"] };
  expect(holds(c, m("local", "whatever"))).toBe(true);
  expect(holds(c, m("a", "x"))).toBe(true);
  expect(holds(c, m("a", "y"))).toBe(false);
  expect(holds(c, null)).toBe(false);
  // 模型名里带斜杠也按「供应商/模型」整串比较
  expect(holds({ ...model, models: ["a/b/c"] }, m("a", "b/c"))).toBe(true);
});

test("分组自上而下取第一张成立的；没有保底且都不成立就什么也不注入", () => {
  const items: PromptItem[] = [
    { kind: "card", cardId: "always" },
    {
      kind: "group",
      id: "g",
      name: "g",
      cards: [
        { cardId: "p", when: { ...model, providers: ["p"] } },
        { cardId: "any", when: null },
        { cardId: "never", when: null },
      ],
    },
    {
      kind: "group",
      id: "h",
      name: "h",
      cards: [{ cardId: "only", when: { ...model, providers: ["z"] } }],
    },
  ];
  expect(cardIdsOf(items, m("p", "1"))).toEqual(["always", "p"]);
  expect(cardIdsOf(items, m("q", "1"))).toEqual(["always", "any"]);
  expect(cardIdsOf(items, m("z", "1"))).toEqual(["always", "any", "only"]);
});

test("items 解析：拒绝未知条件类型与缺字段的分组", () => {
  expect(parseItems([{ kind: "card", cardId: "a" }])).toEqual([
    { kind: "card", cardId: "a" },
  ]);
  expect(typeof parseItems([{ kind: "x" }])).toBe("string");
  expect(
    typeof parseItems([
      {
        kind: "group",
        id: "g",
        name: "g",
        cards: [{ cardId: "a", when: { kind: "js" } }],
      },
    ]),
  ).toBe("string");
  expect(
    typeof parseItems([{ kind: "group", id: "g", name: " ", cards: [] }]),
  ).toBe("string");
});
