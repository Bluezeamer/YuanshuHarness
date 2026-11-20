import { describe, expect, test } from "vitest";
import type { StudioNode } from "../../../../api/studio";
import { evalItems, renderAll, whereIs } from "./eval";
import {
  addGroup,
  addSegment,
  insertCards,
  moveCard,
  moveGroup,
  removeGroup,
  replaceCard,
  setWhen,
  shiftSegment,
} from "./tree";

const seg = (id: string, over: Partial<StudioNode> = {}): StudioNode => ({
  id,
  tag: id,
  title: id,
  slotKind: "custom",
  channel: "system",
  builtin: false,
  items: [],
  ...over,
});
const modelCond = (providers: string[], models: string[] = []) => ({
  kind: "model" as const,
  providers,
  models,
});

describe("求值与渲染", () => {
  const items: StudioNode["items"] = [
    { kind: "card", cardId: "a" },
    {
      kind: "group",
      id: "g",
      name: "g",
      cards: [
        { cardId: "b", when: modelCond(["p"]) },
        { cardId: "c", when: null },
      ],
    },
  ];
  test("分组取第一张成立的，没有模型时只有「否则」", () => {
    expect(evalItems(items, { provider: "p", model: "x" }).cards).toEqual([
      "a",
      "b",
    ]);
    expect(evalItems(items, { provider: "q", model: "x" }).cards).toEqual([
      "a",
      "c",
    ]);
    expect(evalItems(items, null).cards).toEqual(["a", "c"]);
  });

  test("头部段是裸文本，其余包标签，user 通道分开", () => {
    const out = renderAll(
      [
        seg("h", { tag: null, items: [{ kind: "card", cardId: "a" }] }),
        seg("r", { items: [{ kind: "card", cardId: "b" }] }),
        seg("u", { channel: "user", items: [{ kind: "card", cardId: "c" }] }),
      ],
      null,
      (id) => id.toUpperCase(),
    );
    expect(out.system).toBe("A\n\n<r>\nB\n</r>");
    expect(out.user).toBe("C");
  });

  test("头部段不管排在哪都在最前", () => {
    const out = renderAll(
      [
        seg("r", { items: [{ kind: "card", cardId: "b" }] }),
        seg("h", { tag: null, items: [{ kind: "card", cardId: "a" }] }),
      ],
      null,
      (id) => id.toUpperCase(),
    );
    expect(out.system).toBe("A\n\n<r>\nB\n</r>");
  });

  test("卡片位置写到分组", () => {
    expect(whereIs([seg("s", { title: "段", items })], "c")).toBe("段 › g");
  });
});

const groupIdOf = (t: StudioNode[]): string => {
  const g = t[0]?.items[0];
  if (g?.kind !== "group") throw new Error("第一条不是分组");
  return g.id;
};

describe("树的编辑", () => {
  const base = [seg("s1"), seg("s2")];

  test("分组：拖进去才属于它，删分组卡片留在原位", () => {
    let t = addGroup(base, "s1");
    const gid = groupIdOf(t);
    t = insertCards(t, ["a", "b"], { seg: "s1", group: gid, before: null });
    t = setWhen(t, gid, "a", modelCond(["p"]));
    const g = t[0]?.items[0];
    expect(g?.kind === "group" && g.cards.map((c) => c.cardId)).toEqual([
      "a",
      "b",
    ]);
    t = removeGroup(t, gid);
    expect(t[0]?.items).toEqual([
      { kind: "card", cardId: "a" },
      { kind: "card", cardId: "b" },
    ]);
  });

  test("卡片能在段与分组之间挪，挪走后原处不留", () => {
    let t = insertCards(base, ["a"], { seg: "s1", group: null, before: null });
    t = moveCard(t, "a", { seg: "s2", group: null, before: null });
    expect(t[0]?.items).toEqual([]);
    expect(t[1]?.items).toEqual([{ kind: "card", cardId: "a" }]);
  });

  test("同一分组里重排：条件跟着卡片走；从段里拖进分组才是空条件", () => {
    let t = addGroup(base, "s1");
    const gid = groupIdOf(t);
    t = insertCards(t, ["a", "b"], { seg: "s1", group: gid, before: null });
    t = setWhen(t, gid, "a", modelCond(["p"]));
    t = setWhen(t, gid, "b", null);
    t = moveCard(t, "b", { seg: "s1", group: gid, before: "c:a" });
    const g = t[0]?.items[0];
    expect(g?.kind === "group" && g.cards).toEqual([
      { cardId: "b", when: null },
      { cardId: "a", when: modelCond(["p"]) },
    ]);
  });

  test("复制再替换：位置与条件原样保留", () => {
    let t = addGroup(base, "s1");
    const gid = groupIdOf(t);
    t = insertCards(t, ["a"], { seg: "s1", group: gid, before: null });
    t = setWhen(t, gid, "a", modelCond(["p"]));
    t = replaceCard(t, "a", "a2");
    const g = t[0]?.items[0];
    expect(g?.kind === "group" && g.cards).toEqual([
      { cardId: "a2", when: modelCond(["p"]) },
    ]);
  });

  test("分组可以拖到别的条目前面", () => {
    let t = addGroup(base, "s1");
    const gid = groupIdOf(t);
    t = insertCards(t, ["a"], { seg: "s1", group: null, before: null });
    t = moveGroup(t, gid, { seg: "s1", before: null });
    expect(t[0]?.items.map((i) => i.kind)).toEqual(["card", "group"]);
    t = moveGroup(t, gid, { seg: "s1", before: "c:a" });
    expect(t[0]?.items.map((i) => i.kind)).toEqual(["group", "card"]);
  });

  test("新段：system 插在 user 之前；上下移不越过通道分界", () => {
    const withUser = [seg("a"), seg("u", { channel: "user" })];
    const t = addSegment(withUser, {
      id: "n",
      tag: "n",
      title: "n",
      channel: "system",
    });
    expect(t.map((s) => s.id)).toEqual(["a", "n", "u"]);
    expect(shiftSegment(t, "n", 1).map((s) => s.id)).toEqual(["a", "n", "u"]);
    expect(shiftSegment(t, "n", -1).map((s) => s.id)).toEqual(["n", "a", "u"]);
  });
});
