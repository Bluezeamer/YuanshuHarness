// 窗口树的解析与修复：任意输入 → 合法的窗口 / 窗格 / 标签，永不抛。
// 布局文档的版本规则与序列化在 layoutDoc.ts，这里只负责 windows 这一段的修复。

import { leaves, removeLeaf, type Tree } from "../../../ui/tiling/tree";
import { MAX_PANES } from "./l2";
import { hasHost, isHostType, isTabType } from "./tabKinds";
import type { L2Node, Pane, Tab, TabAfx, Window, WindowState } from "./types";

/** 与服务端 PUT 布局文档的 bodyLimit 一致 */
export const MAX_DOC_BYTES = 256 * 1024;

const MAX_DEPTH = 16;
const MAX_STR = 4096;

// ── 修复 ──

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_STR ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** 任意嵌套的分割树：叶子由 parseLeaf 认，坏节点丢弃，空分支消失，单孩子分支提升 */
function parseTree<L extends object>(
  raw: unknown,
  parseLeaf: (o: Obj) => L | null,
  depth = 0,
): Tree<L> | null {
  if (!isObj(raw) || depth > MAX_DEPTH) return null;
  if (!Array.isArray(raw.children)) return parseLeaf(raw);
  const src: unknown[] = Array.isArray(raw.sizes) ? raw.sizes : [];
  const children: Tree<L>[] = [];
  const sizes: number[] = [];
  raw.children.forEach((c: unknown, i: number) => {
    const kid = parseTree(c, parseLeaf, depth + 1);
    if (!kid) return;
    children.push(kid);
    const s = num(src[i]);
    sizes.push(s !== undefined && s > 0 ? s : 1);
  });
  const only = children[0];
  if (!only) return null;
  if (children.length === 1) return only;
  return { dir: raw.dir === "col" ? "col" : "row", sizes, children };
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= MAX_STR ? v : undefined;

// id 列表：只留字符串，最多 256 个
const ids = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string").slice(0, 256);
  return out.length ? out : undefined;
};

function parseAfx(raw: unknown): TabAfx | undefined {
  if (!isObj(raw)) return undefined;
  const a: TabAfx = {};
  if (raw.subAll === true) a.subAll = true;
  const subOpen = ids(raw.subOpen);
  if (subOpen) a.subOpen = subOpen;
  const subSeen = ids(raw.subSeen);
  if (subSeen) a.subSeen = subSeen;
  const filter = str(raw.filter);
  if (filter) a.filter = filter;
  if (raw.mode === "struct" || raw.mode === "json") a.mode = raw.mode;
  const q = str(raw.q);
  if (q) a.q = q;
  const w = num(raw.w);
  if (w !== undefined && w > 0) a.w = w;
  if (isObj(raw.cv)) {
    const stack = Array.isArray(raw.cv.stack)
      ? raw.cv.stack
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .slice(-50)
      : [];
    const at = num(raw.cv.at);
    if (stack.length > 0 && at !== undefined)
      a.cv = {
        stack,
        at: Math.min(Math.max(0, Math.trunc(at)), stack.length - 1),
      };
  }
  if (isObj(raw.fold)) {
    const fold = Object.fromEntries(
      Object.entries(raw.fold)
        .filter((kv): kv is [string, boolean] => typeof kv[1] === "boolean")
        .slice(0, 64),
    );
    if (Object.keys(fold).length) a.fold = fold;
  }
  return Object.keys(a).length ? a : undefined;
}

/** 全文档 id 去重：已占用或缺失的 id 换一个新的 */
export interface IdPool {
  seen: Set<string>;
  n: number;
}
export const newIdPool = (): IdPool => ({ seen: new Set(), n: 0 });
function claim(pool: IdPool, raw: unknown, prefix: "t" | "p" | "w"): string {
  const id = str(raw);
  if (id && !pool.seen.has(id)) {
    pool.seen.add(id);
    return id;
  }
  let g = "";
  do g = `${prefix}x${(++pool.n).toString(36)}`;
  while (pool.seen.has(g));
  pool.seen.add(g);
  return g;
}

function parseTab(
  raw: unknown,
  owner: string | undefined,
  pool: IdPool,
): Tab | null {
  if (!isObj(raw) || !isTabType(raw.type)) return null;
  const type = raw.type;
  const tab: Tab = { id: claim(pool, raw.id, "t"), type };
  if (type === "chat") {
    tab.ctab = raw.ctab === "audit" ? "audit" : "chat";
    const sid = str(raw.sid) ?? owner;
    if (sid !== undefined) tab.sid = sid;
    if (raw.temp === true) tab.temp = true;
  } else if (type === "sub" || type === "job") {
    const sid = str(raw.sid) ?? owner;
    if (sid !== undefined) tab.sid = sid;
    const sub = str(raw.sub);
    if (type === "sub" && sub) tab.sub = sub;
    const job = str(raw.job);
    if (type === "job" && job) tab.job = job;
  } else {
    if (hasHost(type)) tab.host = str(raw.host) ?? "server";
    const cwd = str(raw.cwd);
    if (cwd) tab.cwd = cwd;
    if (type === "files" || type === "preview" || type === "canvas")
      tab.path = text(raw.path) ?? "";
    const canvas = str(raw.canvas);
    if (type === "canvas" && canvas) tab.canvas = canvas;
    if (type === "preview" && raw.temp === true) tab.temp = true;
    const page = str(raw.page);
    if (type === "web" && page) tab.page = page;
    const termId = str(raw.termId);
    if (type === "term" && termId) {
      tab.termId = termId;
      if (raw.termEnded === true) tab.termEnded = true;
    }
  }
  const afx = parseAfx(raw.afx);
  if (afx) tab.afx = afx;
  return tab;
}

/** 窗格：主机以第一个（或声明且存在的）主机级标签为准，其余主机的标签丢弃，保证隔离不变式 */
function parsePane(
  raw: Obj,
  owner: string | undefined,
  pool: IdPool,
): Pane | null {
  if (!Array.isArray(raw.tabs)) return null;
  const pid = claim(pool, raw.pid, "p");
  let tabs = raw.tabs.flatMap((t: unknown) => parseTab(t, owner, pool) ?? []);
  const hostTabs = tabs.filter((t) => isHostType(t.type));
  let host: string | null = null;
  if (hostTabs.length) {
    const declared = str(raw.host);
    host =
      declared && hostTabs.some((t) => t.host === declared)
        ? declared
        : (hostTabs[0]?.host ?? null);
    tabs = tabs.filter((t) => !isHostType(t.type) || t.host === host);
  }
  const first = tabs[0];
  if (!first) return null;
  const active =
    typeof raw.active === "string" && tabs.some((t) => t.id === raw.active)
      ? raw.active
      : first.id;
  return { pid, host, tabs, active };
}

function parseWindow(
  raw: unknown,
  owner: string | undefined,
  pool: IdPool,
): Window | null {
  if (!isObj(raw)) return null;
  const id = claim(pool, raw.id, "w");
  let root: L2Node | null = parseTree<Pane>(raw.root, (o) =>
    parsePane(o, owner, pool),
  );
  if (root && leaves<Pane>(root).length > MAX_PANES) {
    const keep = new Set(
      leaves<Pane>(root)
        .slice(0, MAX_PANES)
        .map((p) => p.pid),
    );
    root = removeLeaf<Pane>(root, (p) => !keep.has(p.pid));
  }
  if (!root) return null;
  const panes = leaves<Pane>(root);
  const focus =
    typeof raw.focus === "string" && panes.some((p) => p.pid === raw.focus)
      ? raw.focus
      : (panes[0]?.pid ?? "");
  return { id, root, focus };
}

/** 一份窗口状态：窗口列表 → active 夹回范围；list 解析为空返回 null */
export function parseWindowState(
  raw: unknown,
  owner: string | undefined,
  pool: IdPool,
): WindowState | null {
  if (!isObj(raw) || !Array.isArray(raw.list)) return null;
  const list = raw.list.flatMap(
    (w: unknown) => parseWindow(w, owner, pool) ?? [],
  );
  if (!list.length) return null;
  const at =
    typeof raw.active === "number" && Number.isInteger(raw.active)
      ? raw.active
      : 0;
  return { list, active: Math.min(Math.max(at, 0), list.length - 1) };
}
