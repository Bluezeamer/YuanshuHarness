// 布局运行时：真 LayoutApi 的错误映射、Provider 对 store 的同步与释放、几个 hook。

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  createLayoutApi,
  LayoutProvider,
  type LayoutProviderProps,
  useAnchorSession,
  useHostName,
  useLayoutDirectories,
  useLayoutState,
  useLayoutStore,
  useLayoutStoreOptional,
} from "./layoutContext";
import { emptyLayout } from "./model/layoutDoc";
import type { LayoutState, LayoutStore } from "./store/layoutStore";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("真 api.get：成功返回文档；各类失败映射成统一的失败种类", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const api = createLayoutApi("tok");

  fetchMock.mockResolvedValueOnce(json({ revision: 4, document: { a: 1 } }));
  expect(await api.get("w 1")).toEqual({
    ok: true,
    data: { revision: 4, document: { a: 1 } },
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/w%201/layout");

  const cases: [Response | Error, string][] = [
    [json({}, 401), "unauthorized"],
    [json({}, 403), "forbidden"],
    [json({}, 429), "rate_limited"],
    [json({}, 500), "server"],
    [new Response("not json", { status: 200 }), "server"],
    [new Error("offline"), "network"],
  ];
  for (const [res, kind] of cases) {
    if (res instanceof Error) fetchMock.mockRejectedValueOnce(res);
    else fetchMock.mockResolvedValueOnce(res);
    expect(await api.get("w1")).toMatchObject({ ok: false, kind });
  }
});

test("真 api.put：路径、请求体、keepalive 透传，409 带回当前值", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const api = createLayoutApi("tok");

  fetchMock.mockResolvedValueOnce(json({ revision: 5 }));
  expect(await api.put("w1", 4, { v: 1 }, true)).toEqual({
    ok: true,
    revision: 5,
  });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/v1/workspaces/w1/layout");
  expect(init.method).toBe("PUT");
  expect(init.keepalive).toBe(true);
  expect(JSON.parse(String(init.body))).toEqual({
    baseRevision: 4,
    document: { v: 1 },
  });

  fetchMock.mockResolvedValueOnce(json({ revision: 9, document: null }, 409));
  expect(await api.put("w1", 4, {})).toEqual({
    ok: false,
    kind: "conflict",
    current: { revision: 9, document: null },
  });
});

function fakeStore(over: Partial<LayoutState> = {}) {
  let state: LayoutState = {
    workspaceId: null,
    doc: emptyLayout(),
    status: "ready",
    error: null,
    dirty: false,
    revision: 0,
    ...over,
  };
  const subs = new Set<() => void>();
  const calls: string[] = [];
  let anchor: string | null = null;
  const store = {
    getState: () => state,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    setWorkspace: async (id: string | null) => {
      calls.push(`workspace:${id}`);
    },
    setDirectories: (ws: unknown, d: unknown) => {
      calls.push(`dirs@${ws}:${d === null ? "null" : JSON.stringify(d)}`);
    },
    setSessions: (ws: unknown, s: unknown) => {
      calls.push(
        `sessions@${ws}:${s === null ? "null" : (s as { id: string }[]).map((x) => x.id).join(",")}`,
      );
    },
    flush: async (keepalive?: boolean) => {
      calls.push(`flush:${keepalive === true}`);
    },
    dispose: () => {
      calls.push("dispose");
    },
    anchorSession: () => anchor,
  } as unknown as LayoutStore;
  return {
    store,
    calls,
    setAnchor: (a: string | null) => {
      anchor = a;
      state = { ...state, doc: { ...state.doc } };
      for (const cb of [...subs]) cb();
    },
  };
}

// 目录、会话、主机清单要保持稳定引用，否则每次渲染都会重新同步给 store
const DIRS = [{ host: "server", path: "/w" }];
const SESSIONS = [{ id: "a", updatedAt: "t", archived: false }];
const HOSTS = [{ id: "gpu", name: "GPU 机" }];

const props = (
  over: Partial<Omit<LayoutProviderProps, "children">> = {},
): Omit<LayoutProviderProps, "children"> => ({
  workspaceId: "w1",
  directories: DIRS,
  sessions: SESSIONS,
  hosts: HOSTS,
  ...over,
});

test("Provider 把工作区、目录与会话同步给 store，变化时再同步，卸载时释放", () => {
  const { store, calls } = fakeStore();
  const { rerender, unmount } = render(
    <LayoutProvider store={store} {...props()}>
      <span />
    </LayoutProvider>,
  );
  // 先开始载入工作区，目录与会话随后到（effect 按声明顺序）
  expect(calls).toEqual([
    "workspace:w1",
    'dirs@w1:[{"host":"server","path":"/w"}]',
    "sessions@w1:a",
  ]);

  calls.length = 0;
  rerender(
    <LayoutProvider
      store={store}
      {...props({ workspaceId: "w2", sessions: null })}
    >
      <span />
    </LayoutProvider>,
  );
  expect(calls).toEqual([
    "workspace:w2",
    'dirs@w2:[{"host":"server","path":"/w"}]',
    "sessions@w2:null",
  ]);

  calls.length = 0;
  unmount();
  expect(calls).toEqual(["dispose"]);
});

test("pagehide 与页面转入后台时立即带 keepalive 保存；卸载后不再响应", () => {
  const { store, calls } = fakeStore();
  const { unmount } = render(
    <LayoutProvider store={store} {...props()}>
      <span />
    </LayoutProvider>,
  );
  calls.length = 0;
  window.dispatchEvent(new Event("pagehide"));
  expect(calls).toEqual(["flush:true"]);

  calls.length = 0;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(calls).toEqual(["flush:true"]);

  unmount();
  calls.length = 0;
  window.dispatchEvent(new Event("pagehide"));
  expect(calls).toEqual([]);
});

test("useHostName：认识的主机给展示名，不认识的回落到 id；useLayoutStore 给同一个 store", () => {
  const { store } = fakeStore();
  let got: LayoutStore | null = null;
  function Probe() {
    const name = useHostName();
    got = useLayoutStore();
    return (
      <span data-testid="p">
        {name("gpu")}/{name("other")}
      </span>
    );
  }
  render(
    <LayoutProvider store={store} {...props()}>
      <Probe />
    </LayoutProvider>,
  );
  expect(screen.getByTestId("p").textContent).toBe("GPU 机/other");
  expect(got).toBe(store);
});

test("useLayoutDirectories：给 Provider 传入的目录清单；没拿到时是空数组", () => {
  const { store } = fakeStore();
  function Probe() {
    return <span data-testid="d">{useLayoutDirectories().length}</span>;
  }
  const { rerender } = render(
    <LayoutProvider store={store} {...props()}>
      <Probe />
    </LayoutProvider>,
  );
  expect(screen.getByTestId("d").textContent).toBe("1");
  rerender(
    <LayoutProvider store={store} {...props({ directories: null })}>
      <Probe />
    </LayoutProvider>,
  );
  expect(screen.getByTestId("d").textContent).toBe("0");
});

test("没有 Provider：useLayoutStoreOptional 是 null，useLayoutStore 抛错", () => {
  function Optional() {
    return <span data-testid="o">{String(useLayoutStoreOptional())}</span>;
  }
  render(<Optional />);
  expect(screen.getByTestId("o").textContent).toBe("null");

  function Strict() {
    useLayoutStore();
    return null;
  }
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => render(<Strict />)).toThrow("需要 <LayoutProvider>");
  err.mockRestore();
});

test("useLayoutState 读切片；useAnchorSession 随文档变化重新取", () => {
  const { store, setAnchor } = fakeStore({ workspaceId: "w1" });
  function Probe() {
    const ws = useLayoutState((s) => s.workspaceId);
    const anchor = useAnchorSession();
    return (
      <span data-testid="p">
        {ws}/{String(anchor)}
      </span>
    );
  }
  render(
    <LayoutProvider store={store} {...props()}>
      <Probe />
    </LayoutProvider>,
  );
  expect(screen.getByTestId("p").textContent).toBe("w1/null");
  act(() => setAnchor("a"));
  expect(screen.getByTestId("p").textContent).toBe("w1/a");
});
