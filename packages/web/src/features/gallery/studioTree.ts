import {
  type Case,
  type Cond,
  emptyCond,
  type Item,
  type Segment,
} from "./studioData";

// 提示词树的纯函数：移动、添加、删除都返回新数组，组件只管把结果交给 state。
export interface Target {
  seg: string;
  /** null = 直接挂在段下面 */
  group: string | null;
  /** 插在这张卡片前面；null = 追加到末尾 */
  before: string | null;
}

const without = (segs: Segment[], id: string): Segment[] =>
  segs.map((s) => ({
    ...s,
    items: s.items
      .filter((it) => !(it.kind === "card" && it.id === id))
      .map((it) =>
        it.kind === "group"
          ? { ...it, cards: it.cards.filter((x) => x.id !== id) }
          : it,
      ),
  }));

const put = (list: Case[], c: Case, before: string | null): Case[] => {
  const at = before === null ? -1 : list.findIndex((x) => x.id === before);
  return at < 0 ? [...list, c] : [...list.slice(0, at), c, ...list.slice(at)];
};

export function insertCards(
  segs: Segment[],
  ids: string[],
  t: Target,
): Segment[] {
  return ids.reduce<Segment[]>(
    (acc, id) =>
      acc.map((s) => {
        if (s.id !== t.seg) return s;
        if (t.group === null) {
          const at =
            t.before === null
              ? -1
              : s.items.findIndex(
                  (it) => it.kind === "card" && it.id === t.before,
                );
          const item: Item = { kind: "card", id };
          return {
            ...s,
            items:
              at < 0
                ? [...s.items, item]
                : [...s.items.slice(0, at), item, ...s.items.slice(at)],
          };
        }
        return {
          ...s,
          items: s.items.map((it) =>
            it.kind === "group" && it.id === t.group
              ? {
                  ...it,
                  cards: put(it.cards, { id, when: emptyCond() }, t.before),
                }
              : it,
          ),
        };
      }),
    segs,
  );
}

export const moveCard = (segs: Segment[], id: string, t: Target): Segment[] =>
  id === t.before ? segs : insertCards(without(segs, id), [id], t);

export const removeCard = without;

export const addGroup = (segs: Segment[], segId: string): Segment[] =>
  segs.map((s) =>
    s.id === segId
      ? {
          ...s,
          items: [
            ...s.items,
            {
              kind: "group",
              id: `g-${Math.random().toString(36).slice(2, 7)}`,
              name: "新分组",
              cards: [],
            },
          ],
        }
      : s,
  );

export const renameGroup = (
  segs: Segment[],
  gid: string,
  name: string,
): Segment[] =>
  segs.map((s) => ({
    ...s,
    items: s.items.map((it) =>
      it.kind === "group" && it.id === gid ? { ...it, name } : it,
    ),
  }));

/** 改分组里某张卡片的条件；null = 否则（保底） */
export const setWhen = (
  segs: Segment[],
  gid: string,
  cardId: string,
  when: Cond | null,
): Segment[] =>
  segs.map((s) => ({
    ...s,
    items: s.items.map((it) =>
      it.kind === "group" && it.id === gid
        ? {
            ...it,
            cards: it.cards.map((c) => (c.id === cardId ? { ...c, when } : c)),
          }
        : it,
    ),
  }));

/** 删分组：里面的卡片留在段里，原来的位置上。 */
export const removeGroup = (segs: Segment[], gid: string): Segment[] =>
  segs.map((s) => ({
    ...s,
    items: s.items.flatMap<Item>((it) =>
      it.kind === "group" && it.id === gid
        ? it.cards.map((c) => ({ kind: "card" as const, id: c.id }))
        : [it],
    ),
  }));
