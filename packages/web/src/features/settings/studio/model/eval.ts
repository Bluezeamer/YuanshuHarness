// 提示词树的求值与渲染（纯函数）：与服务端 prompt/items.ts + compose.ts 同一套规则，
// 编辑时改条件当场看到结果，不用等保存。
import type { ProviderView } from "../../../../api/providers";
import type {
  StudioCond,
  StudioItem,
  StudioNode,
} from "../../../../api/studio";
import { selectableProviders } from "../../../chat/tab/models";

export interface ModelRef {
  provider: string;
  model: string;
}

/** 条件与「按这个模型求值」下拉用的清单：供应商 → 模型 */
export interface ProviderChoice {
  id: string;
  name: string;
  models: string[];
}

// 与聊天里选模型同一口径：已配置凭据、最近一次测试没失败的供应商
export const providerChoices = (
  providers: readonly ProviderView[],
): ProviderChoice[] =>
  selectableProviders(providers)
    .filter((p) => p.models.length > 0)
    .map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models.map((m) => m.id),
    }));

export const modelKey = (m: ModelRef) => `${m.provider}/${m.model}`;

/** 「供应商/模型」拆回两半（只在第一个斜杠处切） */
export const parseKey = (k: string): ModelRef => {
  const i = k.indexOf("/");
  return { provider: k.slice(0, i), model: k.slice(i + 1) };
};

export const holds = (c: StudioCond, m: ModelRef | null): boolean =>
  m !== null &&
  (c.providers.includes(m.provider) || c.models.includes(modelKey(m)));

/** 条件的一句话摘要，给按钮显示；还没选任何东西返回空串 */
export function condText(
  c: StudioCond,
  providers: readonly ProviderChoice[],
): string {
  const name = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  return [
    ...c.providers.map((id) => `${name(id)}（全部）`),
    ...c.models.map((k) => parseKey(k).model),
  ].join("、");
}

export interface SegmentEval {
  /** 每个分组选中的那张；都不成立又没有保底就是 null */
  winner: Map<string, string | null>;
  /** 最终参与拼接的卡片，按顺序 */
  cards: string[];
}

/** 一段在某个模型下的求值：直接挂的卡片都要；分组里自上而下取第一张成立的。 */
export function evalItems(
  items: readonly StudioItem[],
  m: ModelRef | null,
): SegmentEval {
  const winner = new Map<string, string | null>();
  const cards: string[] = [];
  for (const it of items) {
    if (it.kind === "card") {
      cards.push(it.cardId);
      continue;
    }
    const w = it.cards.find((c) => c.when === null || holds(c.when, m));
    winner.set(it.id, w?.cardId ?? null);
    if (w) cards.push(w.cardId);
  }
  return { winner, cards };
}

/**
 * 整份预设拼出的 system 与 user 文本（与服务端 compose.ts 同一套规则）：
 * 头部段（无段名）并成裸文本、永远最前；其余 system 段包 <段名>；user 通道不包标签。
 * 由 pi 渲染 / 我们生成的段只给一行说明。
 */
export function renderAll(
  segs: readonly StudioNode[],
  m: ModelRef | null,
  bodyOf: (cardId: string) => string,
): { system: string; user: string } {
  const head: string[] = [];
  const tagged: string[] = [];
  const usr: string[] = [];
  for (const s of segs) {
    const body = s.builtin
      ? `(${s.title}由系统生成，内容不在这里展开)`
      : evalItems(s.items, m)
          .cards.map((id) => bodyOf(id).trim())
          .filter(Boolean)
          .join("\n\n");
    if (!body) continue;
    if (s.channel === "user") usr.push(body);
    else if (s.tag === null) head.push(body);
    else tagged.push(`<${s.tag}>\n${body}\n</${s.tag}>`);
  }
  return {
    system: [head.join("\n\n"), ...tagged].filter(Boolean).join("\n\n"),
    user: usr.join("\n\n"),
  };
}

/** 卡片在这份预设里的位置，给预览面板写「段 › 分组」 */
export function whereIs(
  segs: readonly StudioNode[],
  cardId: string,
): string | null {
  for (const s of segs)
    for (const it of s.items) {
      if (it.kind === "card" && it.cardId === cardId) return s.title;
      if (it.kind === "group" && it.cards.some((c) => c.cardId === cardId))
        return `${s.title} › ${it.name}`;
    }
  return null;
}

export const usedIds = (segs: readonly StudioNode[]): Set<string> =>
  new Set(
    segs.flatMap((s) =>
      s.items.flatMap((it) =>
        it.kind === "card" ? [it.cardId] : it.cards.map((c) => c.cardId),
      ),
    ),
  );

export const cardCount = (seg: StudioNode): number =>
  seg.items.reduce(
    (n, it) => n + (it.kind === "card" ? 1 : it.cards.length),
    0,
  );
