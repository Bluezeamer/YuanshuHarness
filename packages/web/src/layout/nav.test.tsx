import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { FakeWS, installApi, msgs, snapshot } from "../fakes";
import { Shell } from "../Shell";

const sessions = [
  { id: "s1", name: "甲", createdAt: "t", updatedAt: "t", running: false },
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

const open = async (history = msgs(0, 5)) => {
  installApi(history);
  render(<Shell sessions={sessions} onUnauthorized={() => {}} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /甲/ }));
  act(() => FakeWS.last.serve(snapshot(1, history)));
  return within(screen.getByRole("navigation", { name: "输入导航" }));
};

test("R13 只列用户消息", async () => {
  const nav = await open();
  expect(nav.getAllByRole("listitem").map((li) => li.querySelector("button") as HTMLElement).map((b) => b.getAttribute("aria-label"))).toEqual(["m0", "m2", "m4"]);
});

test("R13 过长的消息截断", async () => {
  const long = msgs(0, 1).map((m) => ({ ...m, text: "x".repeat(60) }));
  const nav = await open(long);
  const t = nav.getAllByRole("listitem")[0]?.querySelector("button")?.getAttribute("data-text") ?? "";
  expect(t.length).toBeLessThan(60);
  expect(t.endsWith("…")).toBe(true);
});

test("R13 点击滚动到该条消息", async () => {
  const nav = await open();
  const spy = vi.fn();
  Element.prototype.scrollIntoView = spy;
  fireEvent.click(nav.getByRole("button", { name: "m2" }));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.contexts[0]).toBe(document.querySelector('[data-anchor="w-2"]'));
});

test("R13 没有 chat pane 焦点时为空态", async () => {
  installApi([]);
  render(<Shell sessions={sessions} onUnauthorized={() => {}} />);
  await act(async () => {});
  expect(screen.getByText("没有可跳转的消息")).toBeTruthy();
});
