import { afterEach, expect, test, vi } from "vitest";
import { flushLocal, localKey } from "../../../app/localState";
import { emptyLayout } from "../model/layoutDoc";
import type { LayoutState, LayoutStore } from "../store/layoutStore";
import { parseFilesView } from "./files/viewState";
import { parsePreviewView } from "./preview/viewState";
import {
  readTabView,
  reconcileTabViews,
  sweepStaleTabViews,
  watchLiveTabs,
  writeTabView,
} from "./tabView";

const keep = (v: unknown) => v;

afterEach(() => {
  flushLocal();
  vi.useRealTimers();
});

test("按（工作区，标签 id）存取：别的工作区、别的标签互不串", () => {
  writeTabView("w1", "t1", { a: 1 });
  writeTabView("w1", "t2", { a: 2 });
  writeTabView("w2", "t1", { a: 3 });
  expect(readTabView("w1", "t1", keep)).toEqual({ a: 1 });
  expect(readTabView("w1", "t2", keep)).toEqual({ a: 2 });
  expect(readTabView("w2", "t1", keep)).toEqual({ a: 3 });
  expect(readTabView("w1", "t9", keep)).toBeNull();
});

test("防抖写：读之前会先落下；坏记录当没有", () => {
  writeTabView("w1", "t1", { a: 1 });
  expect(readTabView("w1", "t1", keep)).toEqual({ a: 1 });
  localStorage.setItem(localKey("tab.view", "w1", "t3"), "{oops");
  expect(readTabView("w1", "t3", keep)).toBeNull();
});

test("对账：这个工作区里不在文档里的标签记录删掉，在的与别的工作区的不动", () => {
  writeTabView("w1", "t1", { a: 1 });
  writeTabView("w1", "t2", { a: 2 });
  writeTabView("w2", "t2", { a: 3 });
  reconcileTabViews("w1", new Set(["t1"]));
  expect(readTabView("w1", "t1", keep)).not.toBeNull();
  expect(readTabView("w1", "t2", keep)).toBeNull();
  expect(readTabView("w2", "t2", keep)).not.toBeNull();
});

test("对账也拦住还在防抖里的写：关标签前一刻的滚动不会在它被删后又冒出来", () => {
  vi.useFakeTimers();
  writeTabView("w1", "t5", { a: 1 });
  reconcileTabViews("w1", new Set());
  vi.advanceTimersByTime(1000);
  expect(readTabView("w1", "t5", keep)).toBeNull();
});

test("启动清理：30 天没动的删，近的留着", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 3600_000;
  for (const [id, age] of [
    ["old", 31],
    ["new", 29],
  ] as const)
    localStorage.setItem(
      localKey("tab.view", "w1", id),
      JSON.stringify({ savedAt: now - age * day, v: { a: 1 } }),
    );
  sweepStaleTabViews(now);
  expect(readTabView("w1", "old", keep)).toBeNull();
  expect(readTabView("w1", "new", keep)).not.toBeNull();
});

/** 只实现 watchLiveTabs 用到的两个方法 */
function fakeStore(): {
  store: LayoutStore;
  set(patch: Partial<LayoutState>): void;
} {
  let state = {
    workspaceId: null,
    doc: emptyLayout(),
    status: "idle",
  } as unknown as LayoutState;
  const ls = new Set<() => void>();
  return {
    store: {
      getState: () => state,
      subscribe: (cb: () => void) => {
        ls.add(cb);
        return () => ls.delete(cb);
      },
    } as unknown as LayoutStore,
    set: (patch) => {
      state = { ...state, ...patch };
      for (const l of ls) l();
    },
  };
}

const docWith = (...tabIds: string[]) =>
  ({
    version: 4,
    windows: {
      active: 0,
      list: [
        {
          id: "w1",
          focus: "p1",
          root: {
            pid: "p1",
            host: null,
            active: tabIds[0] ?? "",
            tabs: tabIds.map((id) => ({ id, type: "files" })),
          },
        },
      ],
    },
  }) as unknown as LayoutState["doc"];

test("watchLiveTabs：载入完成时扫一次孤儿；之后有标签消失才扫；没载入完不动", () => {
  writeTabView("ws", "t1", { a: 1 });
  writeTabView("ws", "t2", { a: 2 });
  writeTabView("ws", "t3", { a: 3 });
  const { store, set } = fakeStore();
  const off = watchLiveTabs(store);

  set({ workspaceId: "ws", status: "loading", doc: docWith() });
  expect(readTabView("ws", "t1", keep)).not.toBeNull();

  set({ status: "ready", doc: docWith("t1", "t2") });
  expect(readTabView("ws", "t3", keep)).toBeNull();
  expect(readTabView("ws", "t2", keep)).not.toBeNull();

  // 关掉 t2：它的记录立刻没有，新标签再拿到 t2 这个 id 时是干净的
  set({ doc: docWith("t1") });
  expect(readTabView("ws", "t2", keep)).toBeNull();
  writeTabView("ws", "t2", { a: 9 });
  set({ doc: docWith("t1", "t2") });
  expect(readTabView("ws", "t2", keep)).toEqual({ a: 9 });

  off();
  set({ doc: docWith() });
  expect(readTabView("ws", "t1", keep)).not.toBeNull();
});

test("文件管理器视图状态：坏的当没有，字段类型不对退回默认", () => {
  for (const v of [null, "x", 3, {}, { at: 1 }])
    expect(parseFilesView(v)).toBeNull();
  expect(parseFilesView({ at: "/w" })).toEqual({
    view: "files",
    hidden: false,
    at: "/w",
    sel: [],
    picked: false,
    scroll: 0,
  });
  expect(
    parseFilesView({
      at: "/w",
      view: "git",
      hidden: true,
      sel: ["a", 1, null],
      picked: true,
      scroll: -5,
    }),
  ).toEqual({
    view: "git",
    hidden: true,
    at: "/w",
    sel: ["a"],
    picked: true,
    scroll: 0,
  });
});

test("预览视图状态：坏的当没有，模式只认 preview，其余当编辑", () => {
  for (const v of [null, "x", {}, { at: 2 }])
    expect(parsePreviewView(v)).toBeNull();
  expect(
    parsePreviewView({ at: "/a", mode: "preview", caret: 12, top: 300 }),
  ).toEqual({
    at: "/a",
    mode: "preview",
    caret: 12,
    top: 300,
  });
  expect(
    parsePreviewView({ at: "/a", mode: "x", caret: -1, top: "y" }),
  ).toEqual({
    at: "/a",
    mode: "edit",
    caret: 0,
    top: 0,
  });
});
