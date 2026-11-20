// 库数据 → 布局上下文的胶水：目录映射成布局主机 id、会话变成简报、内容没变就不重复同步。

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { LibrarySession } from "../../api/sessionLibrary";
import type { Workspace } from "../../api/workspaces";
import { LayoutBridge } from "./LayoutBridge";
import { useRunStates, useSessionTitles } from "./layoutContext";
import { LibraryProvider } from "./library/LibraryProvider";
import type { LibraryState, LibraryStore } from "./library/libraryStore";
import type { LayoutStore } from "./store/layoutStore";

afterEach(cleanup);

const workspace = (id: string): Workspace =>
  ({
    id,
    archived: false,
    order: 0,
    name: id,
    directories: [
      {
        id: "d1",
        name: "w",
        path: "/w",
        environmentId: "local",
        role: "local",
      },
      {
        id: "d2",
        name: "g",
        path: "/g",
        environmentId: "gpu-1",
        role: "remote",
      },
    ],
  }) as unknown as Workspace;

const row = (id: string, over: Partial<LibrarySession> = {}): LibrarySession =>
  ({
    id,
    workspaceId: "w1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lifecycle: "active",
    ...over,
  }) as unknown as LibrarySession;

function fakeLibrary(initial: Partial<LibraryState> = {}) {
  let state: LibraryState = {
    workspaces: [workspace("w1")],
    groups: [],
    sessions: [
      row("a"),
      row("b", { lifecycle: "archived" }),
      row("x", { workspaceId: "w2" }),
    ],
    ready: true,
    live: true,
    failed: false,
    ...initial,
  };
  const subs = new Set<() => void>();
  const store = {
    getState: () => state,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    start: () => () => {},
  } as unknown as LibraryStore;
  return {
    store,
    set(patch: Partial<LibraryState>) {
      state = { ...state, ...patch };
      for (const cb of [...subs]) cb();
    },
  };
}

function fakeLayout() {
  const calls: string[] = [];
  const store = {
    getState: () => ({}),
    subscribe: () => () => {},
    setWorkspace: async (id: string | null) => void calls.push(`ws:${id}`),
    setDirectories: (ws: unknown, d: unknown) =>
      void calls.push(`dirs@${ws}:${JSON.stringify(d)}`),
    setSessions: (ws: unknown, s: unknown) =>
      void calls.push(`sessions@${ws}:${JSON.stringify(s)}`),
    flush: async () => {},
    dispose: () => {},
  } as unknown as LayoutStore;
  return { store, calls };
}

const mount = (
  lib: ReturnType<typeof fakeLibrary>,
  layout: ReturnType<typeof fakeLayout>,
) =>
  render(
    <LibraryProvider store={lib.store}>
      <LayoutBridge
        token="t"
        store={layout.store}
        hosts={[]}
        toHostId={(e) => (e === "local" ? "server" : e)}
      >
        <span />
      </LayoutBridge>
    </LibraryProvider>,
  );

test("当前工作区的目录映射成布局主机 id，会话只取这个工作区的，已归档的带标记", () => {
  const lib = fakeLibrary();
  const layout = fakeLayout();
  mount(lib, layout);
  expect(layout.calls).toEqual([
    "ws:w1",
    'dirs@w1:[{"host":"server","path":"/w"},{"host":"gpu-1","path":"/g"}]',
    'sessions@w1:[{"id":"a","updatedAt":"2026-01-01T00:00:00.000Z","archived":false},{"id":"b","updatedAt":"2026-01-01T00:00:00.000Z","archived":true}]',
  ]);
});

test("库数据还没就绪时会话给 null（布局 store 此时不收敛）", () => {
  const layout = fakeLayout();
  mount(fakeLibrary({ ready: false }), layout);
  expect(layout.calls.at(-1)).toBe("sessions@w1:null");
});

test("库数据重取后内容没变：不重复同步；会话真有变化才同步", async () => {
  const lib = fakeLibrary();
  const layout = fakeLayout();
  mount(lib, layout);
  layout.calls.length = 0;

  // 重取：全是新对象，内容一样
  await act(async () => {
    lib.set({
      workspaces: [workspace("w1")],
      sessions: [
        row("a"),
        row("b", { lifecycle: "archived" }),
        row("x", { workspaceId: "w2" }),
      ],
    });
  });
  expect(layout.calls).toEqual([]);

  // 别的工作区的会话变了：也不相干
  await act(async () => {
    lib.set({
      sessions: [
        row("a"),
        row("b", { lifecycle: "archived" }),
        row("x", { workspaceId: "w2", updatedAt: "2027-01-01T00:00:00.000Z" }),
      ],
    });
  });
  expect(layout.calls).toEqual([]);

  await act(async () => {
    lib.set({ sessions: [row("a"), row("c")] });
  });
  expect(layout.calls).toHaveLength(1);
  expect(layout.calls[0]).toContain('"id":"c"');
});

test("没有当前工作区时目录是 null", () => {
  const layout = fakeLayout();
  mount(fakeLibrary({ workspaces: [], sessions: [] }), layout);
  expect(layout.calls[0]).toBe("ws:null");
  expect(layout.calls).toContain("dirs@null:null");
});

test("库里全部会话的标题进布局上下文（含别的工作区的、已归档的），重取内容没变时标题表引用不变", async () => {
  const lib = fakeLibrary({
    sessions: [
      row("a", { title: "甲" } as Partial<LibrarySession>),
      row("b", {
        title: "乙",
        lifecycle: "archived",
      } as Partial<LibrarySession>),
      row("x", { workspaceId: "w2", title: "丙" } as Partial<LibrarySession>),
    ],
  });
  const seen: ReadonlyMap<string, string>[] = [];
  function Probe() {
    seen.push(useSessionTitles());
    return null;
  }
  render(
    <LibraryProvider store={lib.store}>
      <LayoutBridge
        token="t"
        store={fakeLayout().store}
        hosts={[]}
        toHostId={(e) => e}
      >
        <Probe />
      </LayoutBridge>
    </LibraryProvider>,
  );
  const first = seen[seen.length - 1];
  expect(Object.fromEntries(first ?? [])).toEqual({
    a: "甲",
    b: "乙",
    x: "丙",
  });

  await act(async () => {
    lib.set({
      sessions: [
        row("a", { title: "甲" } as Partial<LibrarySession>),
        row("b", {
          title: "乙",
          lifecycle: "archived",
        } as Partial<LibrarySession>),
        row("x", { workspaceId: "w2", title: "丙" } as Partial<LibrarySession>),
      ],
    });
  });
  expect(seen[seen.length - 1]).toBe(first);

  await act(async () => {
    lib.set({
      sessions: [row("a", { title: "甲改" } as Partial<LibrarySession>)],
    });
  });
  expect(seen[seen.length - 1]?.get("a")).toBe("甲改");
});

test("会话的运行状态进布局上下文：只含执行中与待处理的；状态没变时表引用不变，变了就更新", async () => {
  const withStatus = (...statuses: [string, string][]) =>
    statuses.map(([id, status]) =>
      row(id, { status } as Partial<LibrarySession>),
    );
  const lib = fakeLibrary({
    sessions: withStatus(["a", "running"], ["b", "blocked"], ["c", "idle"]),
  });
  const seen: ReadonlyMap<string, string>[] = [];
  function Probe() {
    seen.push(useRunStates());
    return null;
  }
  render(
    <LibraryProvider store={lib.store}>
      <LayoutBridge
        token="t"
        store={fakeLayout().store}
        hosts={[]}
        toHostId={(e) => e}
      >
        <Probe />
      </LayoutBridge>
    </LibraryProvider>,
  );
  const first = seen[seen.length - 1];
  expect(Object.fromEntries(first ?? [])).toEqual({
    a: "running",
    b: "blocked",
  });

  // 重取了但内容没变：沿用同一张表
  await act(async () => {
    lib.set({
      sessions: withStatus(["a", "running"], ["b", "blocked"], ["c", "idle"]),
    });
  });
  expect(seen[seen.length - 1]).toBe(first);

  // a 跑完了、c 开始跑
  await act(async () => {
    lib.set({
      sessions: withStatus(["a", "idle"], ["b", "blocked"], ["c", "running"]),
    });
  });
  expect(Object.fromEntries(seen[seen.length - 1] ?? [])).toEqual({
    b: "blocked",
    c: "running",
  });
});
