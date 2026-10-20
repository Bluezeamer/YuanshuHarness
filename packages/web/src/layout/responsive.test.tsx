import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { FakeWS, installApi, msgs, snapshot } from "../fakes";
import { Shell } from "../Shell";

const sessions = [
  { id: "s1", name: "甲", createdAt: "t", updatedAt: "t", running: false },
];

let fire: (w: number) => void = () => {};
class FakeRO {
  constructor(private cb: ResizeObserverCallback) {
    fire = (w) =>
      act(() =>
        this.cb(
          [{ contentRect: { width: w } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        ),
      );
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  FakeWS.all = [];
  localStorage.clear();
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("ResizeObserver", FakeRO);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = async () => {
  const api = installApi([]);
  api.workbench = {
    revision: 1,
    document: {
      version: 1,
      activeWindowId: "w1",
      windows: [{ id: "w1", name: "a", tree: { kind: "leaf", paneId: "c" } }],
      panes: {
        c: { type: "chat", configVersion: 1, config: { sessionId: null } },
      },
    },
  };
  render(<Shell sessions={sessions} onUnauthorized={() => {}} />);
  await act(async () => {});
};
const nav = () => screen.queryByRole("navigation", { name: "输入导航" });
const body = () => document.querySelector("[data-chat-body]") as HTMLElement;

test("R14 按 chat pane 自己的宽度：≥400 固定，窄于 400 折叠，再变宽又固定", async () => {
  await mount();
  fire(1000);
  expect(nav()).toBeTruthy();
  fire(400);
  expect(nav()).toBeTruthy();
  fire(399);
  expect(nav()).toBeNull();
  fire(1000);
  expect(nav()).toBeTruthy();
});

test("R14 折叠后展开是悬浮：不占位，不挤压会话区", async () => {
  await mount();
  fire(300);
  const before = body().children.length;
  fireEvent.click(screen.getByRole("button", { name: "展开输入导航" }));
  expect(nav()?.className).toContain("absolute");
  expect(nav()?.className).toContain("inset-y-0");
  expect(body().children.length).toBe(before + 1);
  fireEvent.click(screen.getByRole("button", { name: "收起输入导航" }));
  expect(nav()).toBeNull();
});

test("R14 手动设置后宽度变化不覆盖，刷新后仍记得", async () => {
  await mount();
  fire(1000);
  fireEvent.click(screen.getByRole("button", { name: "折叠输入导航" }));
  expect(nav()).toBeNull();
  fire(1100);
  expect(nav()).toBeNull();

  cleanup();
  await mount();
  fire(1100);
  expect(nav()).toBeNull();

  fire(300);
  fireEvent.click(screen.getByRole("button", { name: "展开输入导航" }));
  fireEvent.click(screen.getByRole("button", { name: "固定输入导航" }));
  fire(300);
  expect(nav()).toBeTruthy();
});

test("R14 悬浮展开时点击导航项后自动收起", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: /甲/ }));
  act(() => FakeWS.last.serve(snapshot(1, msgs(0, 3))));
  fire(300);
  fireEvent.click(screen.getByRole("button", { name: "展开输入导航" }));
  fireEvent.click(screen.getByRole("button", { name: "m2" }));
  expect(nav()).toBeNull();
});
