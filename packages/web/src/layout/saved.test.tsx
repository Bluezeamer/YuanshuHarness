import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { FakeWS, installApi } from "../fakes";
import { Shell } from "../Shell";

const sessions = [
  { id: "s1", name: "甲", createdAt: "t", updatedAt: "t", running: false },
  { id: "s2", name: "乙", createdAt: "t", updatedAt: "t", running: false },
];

beforeEach(() => {
  FakeWS.all = [];
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = async () => {
  const api = installApi([]);
  render(<Shell sessions={sessions} onUnauthorized={() => {}} />);
  await act(async () => {});
  return api;
};
const flush = () => act(async () => {});
const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: "已存布局" }));
  await flush();
};
const paneIdList = () =>
  [...document.querySelectorAll("[data-pane-id]")].map((n) => n.getAttribute("data-pane-id"));

test("R22 存当前 window、套用后 paneId 全新且会话绑定保留、可删除", async () => {
  const api = await mount();
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  fireEvent.click(screen.getByRole("button", { name: "向右分割" }));
  const before = paneIdList();
  expect(before).toHaveLength(2);

  vi.spyOn(window, "prompt").mockReturnValue("我的布局");
  await open();
  fireEvent.click(screen.getByRole("button", { name: "存当前 window" }));
  await flush();
  expect(api.saved).toHaveLength(1);
  const doc = api.saved[0]?.document as { name: string; panes: Record<string, unknown> };
  expect(doc.name).toBe("我的布局");
  expect(Object.keys(doc.panes).sort()).toEqual([...before].sort() as string[]);
  expect(screen.getByText("我的布局")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "套用 我的布局" }));
  await flush();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  const after = paneIdList().filter((id) => !before.includes(id));
  expect(after).toHaveLength(2);
  expect(screen.getAllByRole("heading", { name: "乙" }).length).toBeGreaterThan(0);

  await open();
  fireEvent.click(screen.getByRole("button", { name: "删除已存布局 我的布局" }));
  await flush();
  expect(api.saved).toHaveLength(0);
  expect(screen.getByText("还没有已存布局")).toBeTruthy();
});

test("R22 取消命名不保存", async () => {
  const api = await mount();
  vi.spyOn(window, "prompt").mockReturnValue(null);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "存当前 window" }));
  await flush();
  expect(api.saved).toHaveLength(0);
});
