import { expect, test } from "vitest";
import { addPane, defaultDoc, MAX_TABS, openPane } from "./doc";
import { defaultRegistry } from "./panes";
import { tabGroupOf, visibleIds } from "./tree";
import type { LayoutDoc, PaneBinding, PaneEntry } from "./types";

const registry = defaultRegistry();
const hostOf = (e: PaneEntry) =>
  e.binding?.mode === "fixed" ? e.binding.host : null;

const entry = (type: string, binding?: PaneBinding): PaneEntry => ({
  ...(registry.newEntry(type) as PaneEntry),
  ...(binding ? { binding } : {}),
});

// window 里只有一个 chat（id: c）。
function withChat(): LayoutDoc {
  const d = defaultDoc();
  return addPane(d, d.activeWindowId, "c", entry("chat"));
}

const tree = (d: LayoutDoc) => d.windows[0]?.tree ?? null;

test("没有同类面板：在锚点旁分屏新建", () => {
  const r = openPane(
    withChat(),
    { type: "terminal", host: "stg-01", anchor: "c" },
    registry,
    hostOf,
  );
  expect(r.paneId).not.toBeNull();
  expect(tree(r.doc)?.kind).toBe("split");
  expect(Object.keys(r.doc.panes)).toHaveLength(2);
});

test("已有同类面板且 tabbed：加入它的 tab 组并选中新 tab", () => {
  const first = openPane(
    withChat(),
    { type: "file_preview", host: null, config: { path: "a.ts" }, anchor: "c" },
    registry,
    hostOf,
  );
  const second = openPane(
    first.doc,
    { type: "file_preview", host: null, config: { path: "b.ts" } },
    registry,
    hostOf,
  );
  const id = second.paneId as string;
  const t = tree(second.doc);
  expect(t && tabGroupOf(t, id)).toHaveLength(2);
  expect(visibleIds(t)).toContain(id);
  expect(second.doc.panes[id]?.config).toEqual({ path: "b.ts" });
});

test("same 命中已有实例：只切换，不新建 tab", () => {
  const a = openPane(
    withChat(),
    { type: "file_preview", host: null, config: { path: "a.ts" }, anchor: "c" },
    registry,
    hostOf,
  );
  const b = openPane(
    a.doc,
    { type: "file_preview", host: null, config: { path: "b.ts" } },
    registry,
    hostOf,
  );
  const same = (e: PaneEntry) => (e.config as { path: string }).path === "a.ts";
  const again = openPane(
    b.doc,
    { type: "file_preview", host: null, same },
    registry,
    hostOf,
  );
  expect(again.paneId).toBe(a.paneId);
  expect(Object.keys(again.doc.panes)).toHaveLength(3);
  expect(visibleIds(tree(again.doc))).toContain(a.paneId);
});

test("不是 tabbed 的类型已开：只切换过去，不再新建", () => {
  const a = openPane(
    withChat(),
    { type: "filediscovery", host: null, anchor: "c" },
    registry,
    hostOf,
  );
  const b = openPane(
    a.doc,
    { type: "filediscovery", host: null },
    registry,
    hostOf,
  );
  expect(b.paneId).toBe(a.paneId);
  expect(Object.keys(b.doc.panes)).toHaveLength(2);
});

test("钉住到别的主机的面板不接收：改为分屏新建", () => {
  const d0 = withChat();
  const pinned = openPane(
    d0,
    { type: "terminal", host: "prd-02", anchor: "c" },
    registry,
    hostOf,
  );
  // 手动把它钉到 prd-02。
  const id = pinned.paneId as string;
  const docPinned: LayoutDoc = {
    ...pinned.doc,
    panes: {
      ...pinned.doc.panes,
      [id]: entry("terminal", {
        mode: "fixed",
        sessionId: null,
        host: "prd-02",
      }),
    },
  };
  const r = openPane(
    docPinned,
    { type: "terminal", host: "stg-01", anchor: id },
    registry,
    hostOf,
  );
  expect(r.paneId).not.toBe(id);
  expect(tree(r.doc)?.kind).toBe("split");
});

test("同主机优先于 follow：两个终端时选主机匹配的那个", () => {
  const d0 = withChat();
  const a = openPane(
    d0,
    { type: "terminal", host: "stg-01", anchor: "c" },
    registry,
    hostOf,
  );
  const aId = a.paneId as string;
  const b = openPane(
    {
      ...a.doc,
      panes: {
        ...a.doc.panes,
        [aId]: entry("terminal", {
          mode: "fixed",
          sessionId: null,
          host: "stg-01",
        }),
      },
    },
    { type: "terminal", host: "prd-02", anchor: "c" },
    registry,
    hostOf,
  );
  // b 在另一个叶子里（stg-01 钉住的面板不接收 prd-02）。
  const bId = b.paneId as string;
  expect(bId).not.toBe(aId);
  const r = openPane(
    b.doc,
    { type: "terminal", host: "stg-01" },
    registry,
    hostOf,
  );
  const g = tree(r.doc);
  expect(g && tabGroupOf(g, aId)).not.toBeNull();
});

test(`tab 组达到 ${MAX_TABS} 个：返回 full，文档不变`, () => {
  let d = openPane(
    withChat(),
    { type: "terminal", host: null, anchor: "c" },
    registry,
    hostOf,
  ).doc;
  for (let i = 1; i < MAX_TABS; i++)
    d = openPane(d, { type: "terminal", host: null }, registry, hostOf).doc;
  const r = openPane(d, { type: "terminal", host: null }, registry, hostOf);
  expect(r.paneId).toBeNull();
  expect(r.doc).toBe(d);
  expect("reason" in r && r.reason).toBe("full");
});

test("未知类型：不改文档", () => {
  const d = withChat();
  const r = openPane(d, { type: "nope", host: null }, registry, hostOf);
  expect(r.paneId).toBeNull();
  expect(r.doc).toBe(d);
});
