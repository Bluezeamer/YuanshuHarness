// 一段里的卡片结构：直接挂在段下面的卡片（总是注入），或放进「分组」。
// 分组是一个 switch：每张卡片带一个条件，自上而下取第一张成立的；条件为 null 是「否则」保底。
// 现在只有一种条件：模型。Cond 带 kind，以后加别的条件在 holds 里扩。
import { isObject } from "../lib/validate.js";

/** 条件的输入：会话此刻用的模型 */
export interface ModelRef {
  provider: string;
  model: string;
}

/** providers = 整个供应商（含将来新增的模型）；models = 具体模型，写成 "供应商id/模型id" */
export interface Cond {
  kind: "model";
  providers: string[];
  models: string[];
}

export interface GroupCase {
  cardId: string;
  when: Cond | null;
}

export type PromptItem =
  | { kind: "card"; cardId: string }
  | { kind: "group"; id: string; name: string; cards: GroupCase[] };

export const holds = (c: Cond, m: ModelRef | null): boolean =>
  m !== null &&
  (c.providers.includes(m.provider) ||
    c.models.includes(`${m.provider}/${m.model}`));

/** 分组里这个模型下选中的那张；都不成立又没有保底就是 undefined */
export const winnerOf = (
  cards: readonly GroupCase[],
  m: ModelRef | null,
): GroupCase | undefined =>
  cards.find((c) => c.when === null || holds(c.when, m));

/** 在这个模型下参与拼接的卡片 id，按顺序 */
export function cardIdsOf(
  items: readonly PromptItem[],
  m: ModelRef | null,
): string[] {
  return items.flatMap((it) => {
    if (it.kind === "card") return [it.cardId];
    const w = winnerOf(it.cards, m);
    return w ? [w.cardId] : [];
  });
}

/** 出现过的全部卡片 id（不论条件） */
export const allCardIds = (items: readonly PromptItem[]): string[] =>
  items.flatMap((it) =>
    it.kind === "card" ? [it.cardId] : it.cards.map((c) => c.cardId),
  );

const ITEM_MAX = 500;
const LIST_MAX = 500;
const NAME_MAX = 100;

const idList = (v: unknown): string[] | null =>
  Array.isArray(v) &&
  v.length <= LIST_MAX &&
  v.every((x) => typeof x === "string" && x !== "" && x.length <= 200)
    ? (v as string[])
    : null;

function parseCond(v: unknown): Cond | null | "bad" {
  if (v === null) return null;
  if (!isObject(v) || v.kind !== "model") return "bad";
  const providers = idList(v.providers);
  const models = idList(v.models);
  return providers && models ? { kind: "model", providers, models } : "bad";
}

/** 解析并校验一段的 items；返回错误说明时带上位置，给接口直接回给用户 */
export function parseItems(raw: unknown): PromptItem[] | string {
  if (!Array.isArray(raw) || raw.length > ITEM_MAX) return "items 不是数组";
  const out: PromptItem[] = [];
  for (const it of raw) {
    if (!isObject(it)) return "items 里有非法条目";
    if (it.kind === "card") {
      if (typeof it.cardId !== "string" || it.cardId === "")
        return "卡片条目缺 cardId";
      out.push({ kind: "card", cardId: it.cardId });
      continue;
    }
    if (it.kind !== "group") return "items 里有未知类型";
    const name = typeof it.name === "string" ? it.name.trim() : "";
    if (
      typeof it.id !== "string" ||
      it.id === "" ||
      name === "" ||
      name.length > NAME_MAX ||
      !Array.isArray(it.cards) ||
      it.cards.length > ITEM_MAX
    )
      return "分组缺 id / 名称或名称过长";
    const cards: GroupCase[] = [];
    for (const c of it.cards) {
      if (!isObject(c) || typeof c.cardId !== "string" || c.cardId === "")
        return `分组「${name}」里有非法卡片`;
      const when = parseCond(c.when);
      if (when === "bad") return `分组「${name}」里有非法条件`;
      cards.push({ cardId: c.cardId, when });
    }
    out.push({ kind: "group", id: it.id, name, cards });
  }
  return out;
}
