// 预设「段列表」的保存校验：整份提交、整份校验，通过了才落库。
import { isObject, str } from "../lib/validate.js";
import { allCardIds, parseItems } from "../prompt/items.js";
import type { Channel, PromptNode, SlotKind } from "../store/prompt-presets.js";

/** pi 的段名约束：小写字母开头，只含小写字母/数字/下划线/连字符；preamble 保留 */
const TAG_RE = /^[a-z][a-z0-9_-]*$/;
const RESERVED_TAGS = new Set(["preamble"]);
const NODE_MAX = 100;

export const checkTag = (tag: string): string | null => {
  if (!TAG_RE.test(tag))
    return "段名只能用小写字母开头，含小写字母、数字、下划线或连字符";
  if (RESERVED_TAGS.has(tag)) return "preamble 是 pi 的保留段名";
  return null;
};

export type ParsedNode = Omit<PromptNode, "presetId" | "position">;

/** flat：只要一段、无段名、无分组（AGENTS.md 的两种预设拼出来是固定文本） */
export interface ParseOptions {
  flat?: boolean;
}

const SLOT_KINDS: SlotKind[] = ["custom", "system", "system_content"];

/** 返回规范化后的段列表；不合法时返回一句可以直接给用户看的说明。 */
export function parseNodes(
  raw: unknown,
  cardExists: (id: string) => boolean,
  opts: ParseOptions = {},
): ParsedNode[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > NODE_MAX)
    return "段列表为空或过长";
  if (opts.flat && raw.length !== 1) return "这份预设只能有一段";
  const out: ParsedNode[] = [];
  const ids = new Set<string>();
  const tags = new Set<string>();
  const groupIds = new Set<string>();
  const usedCards = new Set<string>();
  for (const r of raw) {
    if (!isObject(r)) return "段格式不对";
    const id = str(r.id, 200);
    const title = str(r.title, 100);
    if (!id || !title) return "段缺 id 或名称";
    if (ids.has(id)) return "段 id 重复";
    ids.add(id);

    let tag: string | null = null;
    if (r.tag !== null) {
      if (typeof r.tag !== "string") return "段名不对";
      const err = checkTag(r.tag);
      if (err) return err;
      if (tags.has(r.tag)) return `段名重复：${r.tag}`;
      tags.add(r.tag);
      tag = r.tag;
    }

    const items = parseItems(r.items ?? []);
    if (typeof items === "string") return items;
    if (opts.flat) {
      if (tag !== null) return "这份预设的段没有段名";
      if (r.slotKind !== "custom") return "这份预设的段只能是自定义段";
      if (items.some((it) => it.kind === "group")) return "这份预设不能有分组";
    }
    const builtin = r.builtin === true;
    if (builtin && items.length > 0)
      return `「${title}」不是可编辑的段，不能放卡片`;
    for (const cardId of allCardIds(items)) {
      if (!cardExists(cardId)) return `引用了不存在的卡片：${cardId}`;
      if (usedCards.has(cardId)) return "同一张卡片在一份预设里只能出现一次";
      usedCards.add(cardId);
    }
    for (const it of items) {
      if (it.kind !== "group") continue;
      if (groupIds.has(it.id)) return "分组 id 重复";
      groupIds.add(it.id);
    }

    out.push({
      id,
      tag,
      title,
      slotKind: SLOT_KINDS.includes(r.slotKind as SlotKind)
        ? (r.slotKind as SlotKind)
        : "custom",
      channel: (r.channel === "user" ? "user" : "system") satisfies Channel,
      builtin,
      items,
    });
  }
  const firstUser = out.findIndex((n) => n.channel === "user");
  if (
    firstUser >= 0 &&
    out.slice(firstUser).some((n) => n.channel === "system")
  )
    return "user 段必须排在所有 system 之后";
  return out;
}
