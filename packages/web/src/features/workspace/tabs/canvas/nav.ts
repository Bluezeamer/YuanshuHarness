// canvas 标签里的浏览历史：标签主区显示一块画布或一篇笔记（View），点树、点 [[链接]] 都往历史里压一条，
// 返回 / 前进在条目间走。纯函数，不碰 store 与界面。

export type View =
  | { kind: "board"; name: string }
  | { kind: "note"; path: string };

export interface Nav {
  stack: readonly View[];
  /** 当前条目在 stack 里的位置 */
  at: number;
}

const MAX = 50;

export const sameView = (a: View, b: View): boolean =>
  a.kind === b.kind &&
  (a.kind === "board"
    ? a.name === (b as typeof a).name
    : a.path === (b as typeof a).path);

export const startNav = (view: View): Nav => ({ stack: [view], at: 0 });

/** 存进标签记录的形态（TabAfx.cv）：每条 `board:<名>` / `note:<路径>`。窗格里切走标签会卸载组件，靠它还原 */
export interface SavedNav {
  stack: string[];
  at: number;
}

export const saveNav = (nav: Nav): SavedNav => ({
  stack: nav.stack.map((v) =>
    v.kind === "board" ? `board:${v.name}` : `note:${v.path}`,
  ),
  at: nav.at,
});

/** 读回来；认不出的条目丢掉，一条都不剩返回 null */
export function loadNav(saved: SavedNav | undefined): Nav | null {
  if (!saved) return null;
  const stack: View[] = [];
  let at = -1;
  saved.stack.forEach((s, i) => {
    const view: View | null = s.startsWith("board:")
      ? { kind: "board", name: s.slice("board:".length) }
      : s.startsWith("note:")
        ? { kind: "note", path: s.slice("note:".length) }
        : null;
    if (!view) return;
    if (i === saved.at) at = stack.length;
    stack.push(view);
  });
  if (stack.length === 0) return null;
  return { stack, at: at >= 0 ? at : stack.length - 1 };
}

export const currentOf = (nav: Nav): View => nav.stack[nav.at] as View;

/** 打开一个新的视图：和当前的一样就不变；否则丢掉「前进」的部分、接在当前之后。 */
export function pushView(nav: Nav, view: View): Nav {
  if (sameView(currentOf(nav), view)) return nav;
  const stack = [...nav.stack.slice(0, nav.at + 1), view].slice(-MAX);
  return { stack, at: stack.length - 1 };
}

export const canBack = (nav: Nav): boolean => nav.at > 0;
export const canForward = (nav: Nav): boolean => nav.at < nav.stack.length - 1;

export const back = (nav: Nav): Nav =>
  canBack(nav) ? { ...nav, at: nav.at - 1 } : nav;
export const forward = (nav: Nav): Nav =>
  canForward(nav) ? { ...nav, at: nav.at + 1 } : nav;

/**
 * 画布 / 笔记被改名、挪走、删除之后：每个条目过一遍 map，返回新视图就换上，返回 null 就去掉。
 * 相邻重复的条目合并；当前条目被去掉时落在它前面的那个（没有就第一个）。stack 空了返回 null。
 */
export function mapViews(
  nav: Nav,
  map: (view: View) => View | null,
): Nav | null {
  const stack: View[] = [];
  let at = -1;
  nav.stack.forEach((v, i) => {
    const next = map(v);
    if (next !== null) {
      const last = stack[stack.length - 1];
      if (!last || !sameView(last, next)) stack.push(next);
    }
    if (i === nav.at) at = stack.length - 1;
  });
  if (stack.length === 0) return null;
  return { stack, at: Math.max(0, at) };
}
