import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { FakeWS, installApi } from "../fakes";
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
const list = () => screen.queryByRole("complementary", { name: "会话列表" });
const nav = () => screen.queryByRole("navigation", { name: "输入导航" });
const body = () => document.querySelector("[data-chat-body]") as HTMLElement;

test("R14 按 chat pane 自己的宽度：两侧固定；跨阈值默认折叠，再变宽又固定", async () => {
  await mount();
  fire(1000);
  expect(list()).toBeTruthy();
  expect(nav()).toBeTruthy();
  fire(800);
  expect(list()).toBeTruthy();
  expect(nav()).toBeNull();
  fire(500);
  expect(list()).toBeNull();
  fire(1000);
  expect(list()).toBeTruthy();
  expect(nav()).toBeTruthy();
});

test("R14 折叠后展开是悬浮：不占位，不挤压会话区", async () => {
  await mount();
  fire(500);
  const before = body().children.length;
  fireEvent.click(screen.getByRole("button", { name: "展开会话列表" }));
  expect(list()).toBeTruthy();
  expect(list()?.className).toContain("absolute");
  expect(list()?.className).toContain("inset-y-0");
  fireEvent.click(screen.getByRole("button", { name: "展开输入导航" }));
  expect(nav()?.className).toContain("absolute");
  expect(body().children.length).toBe(before + 2);
});

test("R14 手动设置后宽度变化不覆盖，刷新后仍记得", async () => {
  await mount();
  fire(1000);
  fireEvent.click(screen.getByRole("button", { name: "折叠会话列表" }));
  expect(list()).toBeNull();
  fire(1100);
  expect(list()).toBeNull();

  cleanup();
  await mount();
  fire(1100);
  expect(list()).toBeNull();

  fire(500);
  fireEvent.click(screen.getByRole("button", { name: "展开会话列表" }));
  fireEvent.click(screen.getByRole("button", { name: "固定会话列表" }));
  fire(500);
  expect(list()).toBeTruthy();
});

test("R14 悬浮展开时选择会话后自动收起", async () => {
  await mount();
  fire(500);
  fireEvent.click(screen.getByRole("button", { name: "展开会话列表" }));
  fireEvent.click(screen.getByRole("button", { name: /甲/ }));
  expect(list()).toBeNull();
});
