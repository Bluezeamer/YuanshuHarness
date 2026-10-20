import type { Registry } from "./registry";
import {
  addTab,
  containsPane,
  paneIds,
  remove,
  repair,
  selectTab,
  split,
  swap,
  tabGroupOf,
} from "./tree";
import type {
  LayoutDoc,
  LayoutWindow,
  PaneBinding,
  PaneEntry,
  TreeNode,
} from "./types";

// 2：叶子可带 tabs（R9a）。1 的文档没有 tabs，原样可读，读入时升到 2。
export const DOC_VERSION = 2;

let counter = 0;
export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function emptyWindow(name: string): LayoutWindow {
  return { id: newId("w"), name, tree: null };
}

export function defaultDoc(): LayoutDoc {
  const w = emptyWindow("window 1");
  return {
    version: DOC_VERSION,
    windows: [w],
    activeWindowId: w.id,
    panes: {},
  };
}

const mapWindow = (
  d: LayoutDoc,
  id: string,
  f: (w: LayoutWindow) => LayoutWindow,
): LayoutDoc => ({
  ...d,
  windows: d.windows.map((w) => (w.id === id ? f(w) : w)),
});

export const windowOf = (d: LayoutDoc, paneId: string) =>
  d.windows.find((w) => containsPane(w.tree, paneId));

export function addWindow(d: LayoutDoc): LayoutDoc {
  const w = emptyWindow(`window ${d.windows.length + 1}`);
  return { ...d, windows: [...d.windows, w], activeWindowId: w.id };
}

// 至少保留一个 window；被关闭 window 里的 pane 条目一并删除。
export function closeWindow(d: LayoutDoc, id: string): LayoutDoc {
  if (d.windows.length <= 1) return d;
  const gone = d.windows.find((w) => w.id === id);
  if (!gone) return d;
  const i = d.windows.indexOf(gone);
  const windows = d.windows.filter((w) => w.id !== id);
  const panes = { ...d.panes };
  for (const p of paneIds(gone.tree)) delete panes[p];
  const activeWindowId =
    d.activeWindowId === id
      ? (windows[Math.min(i, windows.length - 1)] as LayoutWindow).id
      : d.activeWindowId;
  return { ...d, windows, panes, activeWindowId };
}

export function setPaneBinding(
  d: LayoutDoc,
  paneId: string,
  binding: PaneBinding,
): LayoutDoc {
  const e = d.panes[paneId];
  if (!e) return d;
  return {
    ...d,
    panes: { ...d.panes, [paneId]: { ...e, binding } },
  };
}

// 跟随 <-> 钉住：钉住时记下当时的活动会话，之后切会话它不动。
export function toggleBinding(
  d: LayoutDoc,
  paneId: string,
  activeSessionId: string | null,
): LayoutDoc {
  const e = d.panes[paneId];
  if (!e) return d;
  return setPaneBinding(
    d,
    paneId,
    e.binding?.mode === "fixed"
      ? { mode: "follow" }
      : { mode: "fixed", sessionId: activeSessionId, host: null },
  );
}

// mock 的 tab 条上限，超过就让用户先关几个。
export const MAX_TABS = 8;

export interface OpenRequest {
  type: string;
  // 内容所在主机；follow 面板视为随会话走，fixed 到别的主机的面板不接收。
  host: string | null;
  // 新建实例时覆盖默认配置（文件路径、URL 等）。
  config?: unknown;
  // 命中已有实例则只切换过去，不新建 tab。
  same?: (e: PaneEntry) => boolean;
  // 无同类面板时在它旁边分屏；缺省接在最后一个 pane 后。
  anchor?: string;
}

export type OpenResult =
  | { doc: LayoutDoc; paneId: string }
  | { doc: LayoutDoc; paneId: null; reason: "full" | "unknown-type" };

// 打开路由（对齐 mock openContent）：已开则切换 / 未开则加入同类面板的 tab 组 / 没有同类面板则分屏。
export function openPane(
  d: LayoutDoc,
  req: OpenRequest,
  registry: Pick<Registry, "newEntry" | "get">,
  hostOf: (e: PaneEntry) => string | null,
): OpenResult {
  const w = d.windows.find((x) => x.id === d.activeWindowId);
  const def = registry.get(req.type);
  if (!w || !def) return { doc: d, paneId: null, reason: "unknown-type" };
  const same = paneIds(w.tree).flatMap((id) => {
    const e = d.panes[id];
    return e?.type === req.type ? [{ id, e }] : [];
  });
  const hit = req.same && same.find((c) => req.same?.(c.e));
  if (hit) return { doc: selectPaneTab(d, hit.id), paneId: hit.id };

  let best: { id: string; e: PaneEntry; score: number } | null = null;
  for (const c of same) {
    const pinned = c.e.binding?.mode === "fixed";
    const h = hostOf(c.e);
    if (pinned && req.host !== null && h !== req.host) continue;
    const score = (h === req.host ? 2 : 0) + (pinned ? 0 : 1);
    if (!best || score > best.score) best = { ...c, score };
  }

  if (best) {
    const target = selectPaneTab(d, best.id);
    if (!def.tabbed) return { doc: target, paneId: best.id };
    const group = w.tree ? tabGroupOf(w.tree, best.id) : null;
    if ((group?.length ?? 1) >= MAX_TABS)
      return { doc: d, paneId: null, reason: "full" };
    const entry = registry.newEntry(req.type);
    if (!entry) return { doc: d, paneId: null, reason: "unknown-type" };
    const id = newId("p");
    const fresh: PaneEntry = {
      ...entry,
      ...(req.config !== undefined ? { config: req.config } : {}),
      ...(best.e.binding ? { binding: best.e.binding } : {}),
    };
    const withTab = mapWindow(
      { ...d, panes: { ...d.panes, [id]: fresh } },
      w.id,
      (x) => ({ ...x, tree: x.tree ? addTab(x.tree, best.id, id) : x.tree }),
    );
    return { doc: withTab, paneId: id };
  }

  const entry = registry.newEntry(req.type);
  if (!entry) return { doc: d, paneId: null, reason: "unknown-type" };
  const id = newId("p");
  const fresh: PaneEntry =
    req.config !== undefined ? { ...entry, config: req.config } : entry;
  const at = req.anchor ? { target: req.anchor, dir: "h" as const } : undefined;
  return { doc: addPane(d, w.id, id, fresh, at), paneId: id };
}

export const renameWindow = (
  d: LayoutDoc,
  id: string,
  name: string,
): LayoutDoc => mapWindow(d, id, (w) => ({ ...w, name }));

export const selectWindow = (d: LayoutDoc, id: string): LayoutDoc =>
  d.windows.some((w) => w.id === id) ? { ...d, activeWindowId: id } : d;

// window 为空时新 pane 成为根；否则在 target 上分割。
export function addPane(
  d: LayoutDoc,
  windowId: string,
  paneId: string,
  entry: PaneEntry,
  at?: { target: string; dir: "h" | "v"; before?: boolean },
): LayoutDoc {
  const panes = { ...d.panes, [paneId]: entry };
  const next = mapWindow({ ...d, panes }, windowId, (w) => {
    const leaf: TreeNode = { kind: "leaf", paneId };
    if (!w.tree) return { ...w, tree: leaf };
    const target = at?.target ?? (paneIds(w.tree).at(-1) as string);
    return {
      ...w,
      tree: split(w.tree, target, at?.dir ?? "h", paneId, at?.before),
    };
  });
  return next;
}

export function closePane(d: LayoutDoc, paneId: string): LayoutDoc {
  const w = windowOf(d, paneId);
  if (!w) return d;
  const panes = { ...d.panes };
  delete panes[paneId];
  return mapWindow({ ...d, panes }, w.id, (x) => ({
    ...x,
    tree: remove(x.tree, paneId),
  }));
}

// 移动只改树，不动 panes 表：pane 条目与 paneId 不变，所以实例不会重挂载。
export function movePane(
  d: LayoutDoc,
  paneId: string,
  toWindowId: string,
  at?: { target: string; dir: "h" | "v"; before?: boolean },
): LayoutDoc {
  const from = windowOf(d, paneId);
  const to = d.windows.find((w) => w.id === toWindowId);
  if (!from || !to) return d;
  if (at && at.target === paneId) return d;
  const detached = mapWindow(d, from.id, (w) => ({
    ...w,
    tree: remove(w.tree, paneId),
  }));
  return mapWindow(detached, toWindowId, (w) => {
    const leaf: TreeNode = { kind: "leaf", paneId };
    if (!w.tree) return { ...w, tree: leaf };
    const target = at?.target ?? (paneIds(w.tree).at(-1) as string);
    return {
      ...w,
      tree: split(w.tree, target, at?.dir ?? "h", paneId, at?.before),
    };
  });
}

// R9a：把 paneId 并入 target 所在的 tab 组。只改树，panes 表不动，实例不重挂载。
export function moveToTab(
  d: LayoutDoc,
  paneId: string,
  target: string,
): LayoutDoc {
  const from = windowOf(d, paneId);
  const to = windowOf(d, target);
  if (!from || !to) return d;
  const group = to.tree ? tabGroupOf(to.tree, target) : null;
  if (paneId === target || group?.includes(paneId)) return d;
  const detached = mapWindow(d, from.id, (w) => ({
    ...w,
    tree: remove(w.tree, paneId),
  }));
  return mapWindow(detached, to.id, (w) => ({
    ...w,
    tree: w.tree ? addTab(w.tree, target, paneId) : w.tree,
  }));
}

// 面板头落到另一个面板中心：两个叶子互换位置，panes 表不动，实例不重挂载。
export function swapPanes(d: LayoutDoc, a: string, b: string): LayoutDoc {
  const w = windowOf(d, a);
  if (!w?.tree || windowOf(d, b) !== w) return d;
  return mapWindow(d, w.id, (x) => ({
    ...x,
    tree: x.tree ? swap(x.tree, a, b) : x.tree,
  }));
}

// 空名字表示恢复默认标题。
export function renamePane(
  d: LayoutDoc,
  paneId: string,
  name: string,
): LayoutDoc {
  const e = d.panes[paneId];
  if (!e) return d;
  const { name: _old, ...rest } = e;
  const next = name.trim() ? { ...rest, name: name.trim() } : rest;
  return { ...d, panes: { ...d.panes, [paneId]: next } };
}

export const selectPaneTab = (d: LayoutDoc, paneId: string): LayoutDoc => {
  const w = windowOf(d, paneId);
  if (!w?.tree) return d;
  const tree = selectTab(w.tree, paneId);
  return tree === w.tree ? d : mapWindow(d, w.id, (x) => ({ ...x, tree }));
};

export function setTree(
  d: LayoutDoc,
  windowId: string,
  tree: TreeNode | null,
): LayoutDoc {
  return mapWindow(d, windowId, (w) => ({ ...w, tree }));
}

export function setPaneConfig(
  d: LayoutDoc,
  paneId: string,
  config: unknown,
  configVersion?: number,
): LayoutDoc {
  const e = d.panes[paneId];
  if (!e) return d;
  return {
    ...d,
    panes: {
      ...d.panes,
      [paneId]: {
        ...e,
        config,
        configVersion: configVersion ?? e.configVersion,
      },
    },
  };
}

// 读入时修复比例，并丢弃树里引用了不存在条目的叶子以外的一切：未知类型的条目原样保留。
export function normalize(d: LayoutDoc): { doc: LayoutDoc; repaired: boolean } {
  let repaired = false;
  const windows = d.windows.map((w) => {
    if (!w.tree) return w;
    const r = repair(w.tree);
    repaired ||= r.fixed;
    return { ...w, tree: r.tree };
  });
  const active = windows.some((w) => w.id === d.activeWindowId)
    ? d.activeWindowId
    : (windows[0]?.id ?? "");
  return {
    doc: { ...d, version: DOC_VERSION, windows, activeWindowId: active },
    repaired,
  };
}

// 已存布局：套用到新 window 时所有 pane 分配新 paneId，配置（含会话绑定）保留。
export function instantiate(
  d: LayoutDoc,
  saved: {
    name: string;
    tree: TreeNode | null;
    panes: Record<string, PaneEntry>;
  },
): LayoutDoc {
  const map = new Map<string, string>();
  const rewrite = (n: TreeNode): TreeNode => {
    if (n.kind === "leaf") {
      const fresh = (old: string) => {
        const id = newId("p");
        map.set(old, id);
        return id;
      };
      if (!n.tabs) return { kind: "leaf", paneId: fresh(n.paneId) };
      const tabs = n.tabs.map(fresh);
      return {
        kind: "leaf",
        paneId: tabs[n.tabs.indexOf(n.paneId)] ?? (tabs[0] as string),
        tabs,
      };
    }
    return { ...n, children: n.children.map(rewrite) };
  };
  const tree = saved.tree ? rewrite(saved.tree) : null;
  const panes = { ...d.panes };
  for (const [oldId, newPane] of map) {
    const e = saved.panes[oldId];
    if (e) panes[newPane] = structuredClone(e);
  }
  const w: LayoutWindow = { id: newId("w"), name: saved.name, tree };
  return { ...d, panes, windows: [...d.windows, w], activeWindowId: w.id };
}
