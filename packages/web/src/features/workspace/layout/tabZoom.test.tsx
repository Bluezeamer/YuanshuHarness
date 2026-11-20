import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { flushLocal } from "../../../app/localState";
import { LayoutProvider } from "../layoutContext";
import type { LayoutDoc } from "../model/layoutDoc";
import { createLayoutStore } from "../store/layoutStore";
import { readTabZoom, reconcileTabViews } from "../tabs/tabView";
import { TerminalGuardProvider } from "../tabs/terminal/wiring";
import { L2View } from "./L2View";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// 窗格里一个对话标签、一个终端标签（都接 Ctrl+滚轮缩放）、一个画布标签（不接）
const doc = (active: string): LayoutDoc => ({
  version: 4,
  windows: {
    list: [
      {
        id: "w1",
        focus: "p1",
        root: {
          pid: "p1",
          host: "server",
          tabs: [
            { id: "t1", type: "chat", ctab: "chat", sid: "a" },
            { id: "t2", type: "term", host: "server" },
            { id: "t3", type: "canvas", host: "server" },
          ],
          active,
        },
      },
    ],
    active: 0,
  },
});

async function mount(active: string) {
  const store = createLayoutStore({
    api: {
      get: async () => ({
        ok: true,
        data: { revision: 0, document: doc(active) },
      }),
      put: async (_id, rev) => ({ ok: true, revision: rev + 1 }),
    },
    debounceMs: 10_000,
    notify: () => {},
  });
  await store.setWorkspace("ws1");
  const view = render(
    <LayoutProvider
      store={store}
      workspaceId="ws1"
      directories={[{ host: "server", path: "/w" }]}
      sessions={[
        { id: "a", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
      ]}
      hosts={[{ id: "server", name: "Server" }]}
    >
      <TerminalGuardProvider>
        <L2View />
      </TerminalGuardProvider>
    </LayoutProvider>,
  );
  await act(async () => {});
  return view;
}

const body = () =>
  document.querySelector<HTMLElement>(".ws-tabbody") as HTMLElement;
const zoomOf = () => body().style.getPropertyValue("--tab-zoom");
const wheel = (init: WheelEventInit) =>
  act(() => void fireEvent.wheel(body(), init));

test("对话标签：Ctrl+滚轮放大缩小（每格 10%），出现比例角标，点一下回到 100%", async () => {
  await mount("t1");
  expect(zoomOf()).toBe("");
  expect(screen.queryByRole("button", { name: "100%" })).toBeNull();

  wheel({ ctrlKey: true, deltaY: -100 });
  wheel({ ctrlKey: true, deltaY: -100 });
  expect(zoomOf()).toBe("1.2");
  expect(screen.getByRole("button", { name: "120%" })).toBeTruthy();
  wheel({ ctrlKey: true, deltaY: 100 });
  expect(zoomOf()).toBe("1.1");

  fireEvent.click(screen.getByRole("button", { name: "110%" }));
  expect(zoomOf()).toBe("");
});

test("没按 Ctrl 的滚轮不动比例；范围 70%–200%；浏览器的页面缩放被拦住", async () => {
  await mount("t1");
  wheel({ deltaY: -100 });
  expect(zoomOf()).toBe("");
  for (let i = 0; i < 30; i++) wheel({ ctrlKey: true, deltaY: -100 });
  expect(zoomOf()).toBe("2");
  for (let i = 0; i < 40; i++) wheel({ ctrlKey: true, deltaY: 100 });
  expect(zoomOf()).toBe("0.7");
  expect(
    fireEvent.wheel(body(), { ctrlKey: true, deltaY: 100, cancelable: true }),
  ).toBe(false);
});

test("终端标签也接 Ctrl+滚轮：比例进标签（终端据此改 xterm 字号），出现角标", async () => {
  await mount("t2");
  wheel({ ctrlKey: true, deltaY: -100 });
  expect(zoomOf()).toBe("1.1");
  expect(screen.getByRole("button", { name: "110%" })).toBeTruthy();
});

test("没有可缩放内容的标签（画布）：Ctrl+滚轮不接管，页面也不出角标", async () => {
  await mount("t3");
  expect(
    fireEvent.wheel(body(), { ctrlKey: true, deltaY: -100, cancelable: true }),
  ).toBe(true);
  expect(zoomOf()).toBe("");
});

test("比例按标签存浏览器本地：重新挂载仍是它；标签没了就清掉记录", async () => {
  const first = await mount("t1");
  wheel({ ctrlKey: true, deltaY: -100 });
  flushLocal();
  expect(readTabZoom("ws1", "t1")).toBe(1.1);
  first.unmount();

  await mount("t1");
  expect(zoomOf()).toBe("1.1");

  reconcileTabViews("ws1", new Set(["t2"]));
  expect(readTabZoom("ws1", "t1")).toBeNull();
});
