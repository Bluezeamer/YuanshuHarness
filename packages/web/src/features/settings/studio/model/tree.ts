// 提示词树的编辑（纯函数）：移动、添加、删除都返回新数组，组件只管把结果交给 state。
import type {
  StudioCond,
  StudioItem,
  StudioNode,
} from "../../../../api/studio";

export const cardKey = (id: string) => `c:${id}`;
export const groupKey = (id: string) => `g:${id}`;
export const itemKey = (it: StudioItem) =>
  it.kind === "card" ? cardKey(it.cardId) : groupKey(it.id);

export const emptyCond = (): StudioCond => ({
  kind: "model",
  providers: [],
  models: [],
});

export const newId = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export interface Target {
  seg: string;
  /** null = 直接挂在段下面 */
  group: string | null;
  /** 插在这个条目前面（cardKey / groupKey，同一容器里的）；null = 追加到末尾 */
  before: string | null;
}

const insertAt = <T>(list: T[], x: T, at: number): T[] =>
  at < 0 ? [...list, x] : [...list.slice(0, at), x, ...list.slice(at)];

const mapSeg = (
  segs: StudioNode[],
  id: string,
  f: (s: StudioNode) => StudioNode,
) => segs.map((s) => (s.id === id ? f(s) : s));

const mapGroup = (
  segs: StudioNode[],
  gid: string,
  f: (g: Extract<StudioItem, { kind: "group" }>) => StudioItem,
): StudioNode[] =>
  segs.map((s) => ({
    ...s,
    items: s.items.map((it) =>
      it.kind === "group" && it.id === gid ? f(it) : it,
    ),
  }));

/** 把卡片从所有段与分组里拿掉 */
export const removeCard = (segs: StudioNode[], cardId: string): StudioNode[] =>
  segs.map((s) => ({
    ...s,
    items: s.items
      .filter((it) => !(it.kind === "card" && it.cardId === cardId))
      .map((it) =>
        it.kind === "group"
          ? { ...it, cards: it.cards.filter((c) => c.cardId !== cardId) }
          : it,
      ),
  }));

/** 原位换成另一张卡片（位置与条件都不变）：内置卡片「复制一份再替换」用 */
export const replaceCard = (
  segs: StudioNode[],
  oldId: string,
  newId: string,
): StudioNode[] =>
  segs.map((s) => ({
    ...s,
    items: s.items.map((it) =>
      it.kind === "card"
        ? it.cardId === oldId
          ? { ...it, cardId: newId }
          : it
        : {
            ...it,
            cards: it.cards.map((c) =>
              c.cardId === oldId ? { ...c, cardId: newId } : c,
            ),
          },
    ),
  }));

export function insertCards(
  segs: StudioNode[],
  ids: string[],
  t: Target,
): StudioNode[] {
  return ids.reduce((acc, cardId) => {
    if (t.group === null)
      return mapSeg(acc, t.seg, (s) => ({
        ...s,
        items: insertAt(
          s.items,
          { kind: "card", cardId },
          t.before === null
            ? -1
            : s.items.findIndex((it) => itemKey(it) === t.before),
        ),
      }));
    return mapGroup(acc, t.group, (g) => ({
      ...g,
      cards: insertAt(
        g.cards,
        { cardId, when: emptyCond() },
        t.before === null
          ? -1
          : g.cards.findIndex((c) => cardKey(c.cardId) === t.before),
      ),
    }));
  }, segs);
}

/** 卡片挪位置：在分组之间 / 同一分组里重排时带着原来的条件走，从段里拖进分组才是空条件 */
export function moveCard(
  segs: StudioNode[],
  cardId: string,
  t: Target,
): StudioNode[] {
  if (t.before === cardKey(cardId)) return segs;
  const old = segs
    .flatMap((s) => s.items)
    .flatMap((it) => (it.kind === "group" ? it.cards : []))
    .find((c) => c.cardId === cardId);
  const moved = insertCards(removeCard(segs, cardId), [cardId], t);
  return old && t.group !== null
    ? setWhen(moved, t.group, cardId, old.when)
    : moved;
}

/** 分组整个挪到别处（只能挂在段下面，不能套进别的分组） */
export function moveGroup(
  segs: StudioNode[],
  gid: string,
  t: { seg: string; before: string | null },
): StudioNode[] {
  const group = segs
    .flatMap((s) => s.items)
    .find((it) => it.kind === "group" && it.id === gid);
  if (!group || t.before === groupKey(gid)) return segs;
  const cleared = segs.map((s) => ({
    ...s,
    items: s.items.filter((it) => !(it.kind === "group" && it.id === gid)),
  }));
  return mapSeg(cleared, t.seg, (s) => ({
    ...s,
    items: insertAt(
      s.items,
      group,
      t.before === null
        ? -1
        : s.items.findIndex((it) => itemKey(it) === t.before),
    ),
  }));
}

/** 在同一容器里上移 / 下移一格（菜单与键盘用的路径） */
export function shiftItem(
  segs: StudioNode[],
  at: { seg: string; group: string | null; key: string },
  dir: -1 | 1,
): StudioNode[] {
  const swap = <T>(list: T[], keyOf: (x: T) => string): T[] => {
    const i = list.findIndex((x) => keyOf(x) === at.key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j] as T, next[i] as T];
    return next;
  };
  if (at.group === null)
    return mapSeg(segs, at.seg, (s) => ({
      ...s,
      items: swap(s.items, itemKey),
    }));
  return mapGroup(segs, at.group, (g) => ({
    ...g,
    cards: swap(g.cards, (c) => cardKey(c.cardId)),
  }));
}

export const addGroup = (segs: StudioNode[], segId: string): StudioNode[] =>
  mapSeg(segs, segId, (s) => ({
    ...s,
    items: [
      ...s.items,
      { kind: "group", id: newId("g"), name: "新分组", cards: [] },
    ],
  }));

export const renameGroup = (
  segs: StudioNode[],
  gid: string,
  name: string,
): StudioNode[] => mapGroup(segs, gid, (g) => ({ ...g, name }));

/** 改分组里某张卡片的条件；null = 否则（保底） */
export const setWhen = (
  segs: StudioNode[],
  gid: string,
  cardId: string,
  when: StudioCond | null,
): StudioNode[] =>
  mapGroup(segs, gid, (g) => ({
    ...g,
    cards: g.cards.map((c) => (c.cardId === cardId ? { ...c, when } : c)),
  }));

/** 删分组：里面的卡片留在段里，原来的位置上。 */
export const removeGroup = (segs: StudioNode[], gid: string): StudioNode[] =>
  segs.map((s) => ({
    ...s,
    items: s.items.flatMap<StudioItem>((it) =>
      it.kind === "group" && it.id === gid
        ? it.cards.map((c) => ({ kind: "card" as const, cardId: c.cardId }))
        : [it],
    ),
  }));

// ---- 段 ----

/** 新段：system 段插在第一个 user 段前面，user 段放最后（user 必须排在所有 system 之后） */
export function addSegment(
  segs: StudioNode[],
  seg: Omit<StudioNode, "items" | "builtin" | "slotKind">,
): StudioNode[] {
  const next: StudioNode = {
    ...seg,
    slotKind: "custom",
    builtin: false,
    items: [],
  };
  const firstUser = segs.findIndex((s) => s.channel === "user");
  return seg.channel === "user" || firstUser < 0
    ? [...segs, next]
    : insertAt(segs, next, firstUser);
}

export const removeSegment = (segs: StudioNode[], id: string): StudioNode[] =>
  segs.filter((s) => s.id !== id);

export const patchSegment = (
  segs: StudioNode[],
  id: string,
  patch: Partial<Pick<StudioNode, "title" | "tag" | "channel">>,
): StudioNode[] => mapSeg(segs, id, (s) => ({ ...s, ...patch }));

/** 段的加载顺序上移 / 下移；不越过 system 与 user 的分界 */
export function shiftSegment(
  segs: StudioNode[],
  id: string,
  dir: -1 | 1,
): StudioNode[] {
  const i = segs.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= segs.length) return segs;
  if (segs[i]?.channel !== segs[j]?.channel) return segs;
  const next = [...segs];
  [next[i], next[j]] = [next[j] as StudioNode, next[i] as StudioNode];
  return next;
}
