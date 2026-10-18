import { containsPane, paneIds, remove, repair, split } from "./tree";
import type { LayoutDoc, LayoutWindow, PaneEntry, TreeNode } from "./types";

export const DOC_VERSION = 1;

let counter = 0;
export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function emptyWindow(name: string): LayoutWindow {
  return { id: newId("w"), name, tree: null };
}

export function defaultDoc(): LayoutDoc {
  const w = emptyWindow("window 1");
  return { version: DOC_VERSION, windows: [w], activeWindowId: w.id, panes: {} };
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

export const renameWindow = (d: LayoutDoc, id: string, name: string): LayoutDoc =>
  mapWindow(d, id, (w) => ({ ...w, name }));

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
    return { ...w, tree: split(w.tree, target, at?.dir ?? "h", paneId, at?.before) };
  });
}

export function setTree(d: LayoutDoc, windowId: string, tree: TreeNode | null): LayoutDoc {
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
      [paneId]: { ...e, config, configVersion: configVersion ?? e.configVersion },
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
  return { doc: { ...d, windows, activeWindowId: active }, repaired };
}

// 已存布局：套用到新 window 时所有 pane 分配新 paneId，配置（含会话绑定）保留。
export function instantiate(
  d: LayoutDoc,
  saved: { name: string; tree: TreeNode | null; panes: Record<string, PaneEntry> },
): LayoutDoc {
  const map = new Map<string, string>();
  const rewrite = (n: TreeNode): TreeNode => {
    if (n.kind === "leaf") {
      const id = newId("p");
      map.set(n.paneId, id);
      return { kind: "leaf", paneId: id };
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
