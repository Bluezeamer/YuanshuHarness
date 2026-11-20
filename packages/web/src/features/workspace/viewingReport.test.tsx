// 「我在看」的上报：布局里正在显示的会话；页面不在前台就是空。

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LayoutProvider } from "./layoutContext";
import { LibraryProvider } from "./library/LibraryProvider";
import type { LibraryState, LibraryStore } from "./library/libraryStore";
import { emptyLayout } from "./model/layoutDoc";
import type { LayoutState, LayoutStore } from "./store/layoutStore";
import { useViewingReport } from "./viewingReport";

afterEach(() => {
  cleanup();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

function Probe() {
  useViewingReport();
  return null;
}

test("上报当前窗口正在显示的会话；布局变化时更新；页面进后台时上报空，回来再报", async () => {
  const setViewing = vi.fn();
  const libraryState: LibraryState = {
    workspaces: [],
    groups: [],
    sessions: [],
    ready: true,
    live: true,
    failed: false,
  };
  const library = {
    getState: () => libraryState,
    subscribe: () => () => {},
    start: () => () => {},
    setViewing,
  } as unknown as LibraryStore;

  let state = {
    workspaceId: "w1",
    doc: emptyLayout(),
    status: "ready",
  } as unknown as LayoutState;
  let showing = ["a"];
  const subs = new Set<() => void>();
  const layout = {
    getState: () => state,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    viewing: () => showing,
    setWorkspace: async () => {},
    setDirectories: () => {},
    setSessions: () => {},
    flush: async () => {},
    dispose: () => {},
  } as unknown as LayoutStore;

  render(
    <LibraryProvider store={library}>
      <LayoutProvider
        store={layout}
        workspaceId="w1"
        directories={null}
        sessions={null}
        hosts={[]}
      >
        <Probe />
      </LayoutProvider>
    </LibraryProvider>,
  );
  expect(setViewing).toHaveBeenLastCalledWith(["a"]);

  showing = ["a", "b"];
  await act(async () => {
    state = { ...state, doc: { ...state.doc } };
    for (const cb of [...subs]) cb();
  });
  expect(setViewing).toHaveBeenLastCalledWith(["a", "b"]);

  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(setViewing).toHaveBeenLastCalledWith([]);

  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(setViewing).toHaveBeenLastCalledWith(["a", "b"]);
});
