import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { INITIAL_BROWSER } from "./model";
import { engineState, FakeSocket, limitsView, pageView } from "./testkit";
import { useBrowser } from "./useBrowser";

// useBrowser 走缺省建连方式，所以替换全局 WebSocket。
class GlobalFake extends FakeSocket {
  constructor(url: string) {
    super(url);
  }
}

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal("WebSocket", GlobalFake);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("workspaceId 为 null：给初始状态，不连", () => {
  const { result } = renderHook(() => useBrowser(null));
  expect(result.current.state).toEqual(INITIAL_BROWSER);
  expect(result.current.store).toBeNull();
  expect(FakeSocket.all).toHaveLength(0);
});

test("状态从事件流来；同一工作区多次 acquire 共用一条连接", () => {
  const a = renderHook(() => useBrowser("w"));
  const b = renderHook(() => useBrowser("w"));
  expect(FakeSocket.all).toHaveLength(1);
  expect(a.result.current.store).toBe(b.result.current.store);
  expect(a.result.current.store).not.toBeNull();

  act(() => FakeSocket.last.open());
  act(() =>
    FakeSocket.last.serve({
      type: "snapshot",
      engine: engineState(),
      pages: [pageView({ id: "p1" })],
      limits: limitsView,
    }),
  );
  expect(a.result.current.state.pages.map((p) => p.id)).toEqual(["p1"]);
  expect(b.result.current.state.link).toBe("live");

  // 关掉一个：连接还在；两个都关掉才断
  const sock = FakeSocket.last;
  a.unmount();
  expect(sock.closed).toBe(false);
  b.unmount();
  expect(sock.closed).toBe(true);
});

test("换工作区：新工作区的任何一次渲染都拿不到旧工作区的 store", () => {
  const seen: Array<{ wid: string; store: unknown }> = [];
  const h = renderHook(
    ({ wid }: { wid: string }) => {
      const r = useBrowser(wid);
      seen.push({ wid, store: r.store });
      return r;
    },
    { initialProps: { wid: "w1" } },
  );
  const first = h.result.current.store;
  const firstSock = FakeSocket.last;
  h.rerender({ wid: "w2" });
  expect(h.result.current.store).not.toBe(first);
  expect(h.result.current.store).not.toBeNull();
  expect(seen.filter((s) => s.wid === "w2").map((s) => s.store)).not.toContain(
    first,
  );
  // 旧工作区的连接随之释放
  expect(firstSock.closed).toBe(true);
  expect(FakeSocket.all).toHaveLength(2);
});
