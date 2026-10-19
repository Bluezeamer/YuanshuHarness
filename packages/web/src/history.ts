import type { ChatEntry, Page, Result } from "./api";

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      args: string;
      result?: string;
      isError?: boolean;
      // 运行中的实时输出，仅来自 tool.updated，不属于历史。
      live?: string;
    };

export interface Known {
  role: string;
  text: string;
  blocks?: Block[];
}

// 已加载的更早历史：index 连续递增；nextBefore 是继续往前翻的游标，null 表示已到最早。
export interface Loaded {
  older: ChatEntry[];
  nextBefore: string | null;
}

export type HistoryResult = ({ ok: true } & Loaded) | { ok: false };

// 快照带窗口第一条的序位 startIndex，与 REST 的 index 同一套：窗口之前的历史就是页里 index < startIndex 的部分，
// 不需要比对内容。页若没覆盖到 startIndex - 1（服务端落后，或快照已过时），重取而不是猜。
export async function loadOlder(
  fetchTail: () => Promise<Result<Page>>,
  startIndex: number,
  tries = 3,
): Promise<HistoryResult> {
  for (let i = 0; i < tries; i++) {
    const r = await fetchTail();
    if (!r.ok) return { ok: false };
    const older = r.data.messages.filter((m) => m.index < startIndex);
    if (startIndex === 0) return { ok: true, older: [], nextBefore: null };
    if (older[older.length - 1]?.index !== startIndex - 1) continue;
    return { ok: true, older, nextBefore: r.data.nextBefore };
  }
  return { ok: false };
}

// 重新对齐后的合并：已加载的历史是累积的，不能被新页替换（resync/重连后中间不会少消息）。
// 两段在 index 上相接或重叠才合并，重叠处以新页为准；中间有缺口（断开期间新增超过一页）
// 时拼不出连续序列，改用新页，更早的部分由"加载更早"补回。
export function afterTail(prev: Loaded, fresh: Loaded): Loaded {
  const first = (l: Loaded) => l.older[0]?.index ?? 0;
  const last = (l: Loaded) => l.older[l.older.length - 1]?.index ?? -1;
  if (prev.older.length === 0 || fresh.older.length === 0) {
    return prev.older.length === 0 ? fresh : prev;
  }
  if (first(fresh) > last(prev) + 1 || first(prev) > last(fresh) + 1)
    return fresh;

  const byIndex = new Map(prev.older.map((m) => [m.index, m]));
  for (const m of fresh.older) byIndex.set(m.index, m);
  const older = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return {
    older,
    nextBefore: first(prev) < first(fresh) ? prev.nextBefore : fresh.nextBefore,
  };
}

// 点"加载更早"后的拼接。请求期间游标已变（已被重新对齐替换）说明这页接不上，丢弃。
export function afterEarlier(prev: Loaded, cursor: string, page: Page): Loaded {
  if (prev.nextBefore !== cursor) return prev;
  const firstIndex = prev.older[0]?.index ?? Number.POSITIVE_INFINITY;
  return {
    older: [
      ...page.messages.filter((m) => m.index < firstIndex),
      ...prev.older,
    ],
    nextBefore: page.nextBefore,
  };
}
