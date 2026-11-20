// 预设 → 提示词：每段按「直接挂的卡片 + 分组里按条件选中的那张」求出卡片，再按通道拼成最终产物。
//
// 段序规则：所有 system 段在前，user 段在后（保存时已校验，库里的顺序就是加载顺序）。
// 段名规则：identity 段（tag = null）走 customPrompt，裸文本、永远最前；其余段包 <tag>。
import type { PromptCard } from "../store/prompt-cards.js";
import type { Channel, PresetDetail } from "../store/prompt-presets.js";
import { allCardIds, cardIdsOf, type ModelRef } from "./items.js";

const bodyOf = (cards: readonly PromptCard[]): string =>
  cards
    .map((c) => c.body.trim())
    .filter(Boolean)
    .join("\n\n");

export interface ComposedPrompt {
  /** 走 customPrompt 的裸文本（identity 段） */
  preamble: string;
  /** 其余 system 段：段名 → 正文 */
  sections: Record<string, string>;
  /** user 通道正文（会话开始时注入一次） */
  userText: string;
  /** 每段的明细，用于预览与排错 */
  parts: {
    nodeId: string;
    title: string;
    tag: string | null;
    channel: Channel;
    cards: string[];
    chars: number;
  }[];
}

/**
 * 拼一份预设。条件按 model 求值；model 为 null（还没有可用模型）时只有「否则」保底的卡片成立。
 * `slotKind = system` 的段（由 pi 渲染，例如 skills）不产出正文，只在 parts 里留一条记录。
 */
export function composePreset(
  detail: PresetDetail,
  cards: readonly PromptCard[],
  model: ModelRef | null,
): ComposedPrompt {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out: ComposedPrompt = {
    preamble: "",
    sections: {},
    userText: "",
    parts: [],
  };
  const userBlocks: string[] = [];

  for (const node of detail.nodes) {
    const used =
      node.slotKind === "system"
        ? []
        : cardIdsOf(node.items, model).flatMap((id) => byId.get(id) ?? []);
    const body = bodyOf(used);
    out.parts.push({
      nodeId: node.id,
      title: node.title,
      tag: node.tag,
      channel: node.channel,
      cards: used.map((c) => c.id),
      chars: body.length,
    });
    if (body === "") continue;
    if (node.channel === "user") userBlocks.push(body);
    else if (node.tag === null)
      // identity：裸文本，不带任何标签
      out.preamble = out.preamble ? `${out.preamble}\n\n${body}` : body;
    else out.sections[node.tag] = body;
  }

  out.userText = userBlocks.join("\n\n");
  return out;
}

/** 预设用到的全部卡片 id（不论条件），取卡片正文时用 */
export const presetCardIds = (detail: PresetDetail): string[] => [
  ...new Set(detail.nodes.flatMap((n) => allCardIds(n.items))),
];
