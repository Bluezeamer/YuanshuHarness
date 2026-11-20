// LibraryProvider：注入假 store，验证切片订阅、按工作区过滤与当前工作区校正。

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { LibrarySession } from "../../../api/sessionLibrary";
import type { Workspace } from "../../../api/workspaces";
import { CURRENT_KEY } from "./currentWorkspace";
import {
  type CurrentWorkspace,
  LibraryProvider,
  type LibraryProviderProps,
  useCurrentWorkspace,
  useLibraryState,
  useWorkspaceSessions,
} from "./LibraryProvider";
import type { LibraryState, LibraryStore } from "./libraryStore";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(cleanup);

const ws = (id: string, archived = false): Workspace =>
  ({ id, archived, order: 0, name: id }) as unknown as Workspace;

const row = (id: string, workspaceId: string | null): LibrarySession =>
  ({ id, workspaceId }) as unknown as LibrarySession;

function fakeStore(initial: Partial<LibraryState> = {}) {
  let state: LibraryState = {
    workspaces: [],
    groups: [],
    sessions: [],
    ready: false,
    live: false,
    failed: false,
    ...initial,
  };
  const subs = new Set<() => void>();
  const set = (patch: Partial<LibraryState>) => {
    state = { ...state, ...patch };
    for (const cb of [...subs]) cb();
  };
  const store = {
    getState: () => state,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    start: () => () => {},
  } as unknown as LibraryStore;
  return { store, set };
}

const mount = (props: Omit<LibraryProviderProps, "children">, ui: ReactNode) =>
  render(<LibraryProvider {...props}>{ui}</LibraryProvider>);

test("Provider 挂载时启动 store，卸载时停掉", () => {
  const { store } = fakeStore();
  const calls: string[] = [];
  store.start = () => {
    calls.push("start");
    return () => calls.push("stop");
  };
  const { unmount } = mount({ store }, <span />);
  expect(calls).toEqual(["start"]);
  unmount();
  expect(calls).toEqual(["start", "stop"]);
});

test("useLibraryState 读 store 的切片", () => {
  const { store } = fakeStore({
    sessions: [row("a", "w1")],
    live: true,
  });
  function Probe() {
    const n = useLibraryState((s) => s.sessions.length);
    const live = useLibraryState((s) => s.live);
    return (
      <span data-testid="probe">
        {n}/{String(live)}
      </span>
    );
  }
  mount({ store }, <Probe />);
  expect(screen.getByTestId("probe").textContent).toBe("1/true");
});

test("useWorkspaceSessions 只返回该工作区的会话，引用稳定", () => {
  const { store, set } = fakeStore({
    sessions: [row("a", "w1"), row("b", "w2"), row("c", "w1")],
  });
  const seen: (readonly LibrarySession[])[] = [];
  function Probe({ id }: { id: string | null }) {
    const sessions = useWorkspaceSessions(id);
    seen.push(sessions);
    return (
      <span data-testid={String(id)}>
        {sessions.map((s) => s.id).join(",")}
      </span>
    );
  }
  mount(
    { store },
    <>
      <Probe id="w1" />
      <Probe id={null} />
    </>,
  );
  expect(screen.getByTestId("w1").textContent).toBe("a,c");
  expect(screen.getByTestId("null").textContent).toBe("");

  const before = seen.at(-2);
  act(() => set({ live: true }));
  expect(seen.at(-2)).toBe(before);
});

let current: CurrentWorkspace | null = null;

function CurrentProbe({ name }: { name: string }) {
  const c = useCurrentWorkspace();
  current = c;
  return <span data-testid={name}>{c.id ?? "none"}</span>;
}

test("useCurrentWorkspace：ready 之前不校正，也不动保存的值", () => {
  localStorage.setItem(CURRENT_KEY, "w9");
  const { store } = fakeStore({ workspaces: [ws("w1")] });
  mount({ store }, <CurrentProbe name="cur" />);
  expect(screen.getByTestId("cur")?.textContent).toBe("w9");
  expect(localStorage.getItem(CURRENT_KEY)).toBe("w9");
  // 页签把继承来的值记成自己的，但没被列表冲掉
  expect(sessionStorage.getItem(CURRENT_KEY)).toBe("w9");
});

test("useCurrentWorkspace：ready 后保存的 id 不存在就落到第一个未归档", () => {
  localStorage.setItem(CURRENT_KEY, "gone");
  const { store, set } = fakeStore({ workspaces: [ws("w1", true), ws("w2")] });
  mount({ store }, <CurrentProbe name="cur" />);
  expect(screen.getByTestId("cur")?.textContent).toBe("gone");

  act(() => set({ ready: true }));
  expect(screen.getByTestId("cur")?.textContent).toBe("w2");
  expect(sessionStorage.getItem(CURRENT_KEY)).toBe("w2");
  expect(localStorage.getItem(CURRENT_KEY)).toBe("w2");
});

test("useCurrentWorkspace：当前工作区被删后落到第一个", () => {
  localStorage.setItem(CURRENT_KEY, "w2");
  const { store, set } = fakeStore({
    ready: true,
    workspaces: [ws("w1"), ws("w2")],
  });
  mount({ store }, <CurrentProbe name="cur" />);
  expect(screen.getByTestId("cur")?.textContent).toBe("w2");

  act(() => set({ workspaces: [ws("w1")] }));
  expect(screen.getByTestId("cur")?.textContent).toBe("w1");
  expect(sessionStorage.getItem(CURRENT_KEY)).toBe("w1");
});

test("useCurrentWorkspace：select 写进 storage，多个组件同时看到新值", () => {
  const { store } = fakeStore({
    ready: true,
    workspaces: [ws("w1"), ws("w2")],
  });
  mount(
    { store },
    <>
      <CurrentProbe name="left" />
      <CurrentProbe name="right" />
    </>,
  );
  expect(screen.getByTestId("left").textContent).toBe("w1");

  act(() => current?.select("w2"));
  expect(screen.getByTestId("left").textContent).toBe("w2");
  expect(screen.getByTestId("right").textContent).toBe("w2");
  expect(sessionStorage.getItem(CURRENT_KEY)).toBe("w2");
  expect(localStorage.getItem(CURRENT_KEY)).toBe("w2");
});
