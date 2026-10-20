import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Shell } from "../Shell";

const s = (id: string, name: string | null, running = false) => ({
  id,
  name,
  createdAt: "t",
  updatedAt: "2026-10-20T08:05:00",
  running,
});
const noop = () => {};
const SESSIONS = [s("s1", "甲", true), s("s2", "乙"), s("s3", null)];
const mount = () => render(<Shell sessions={SESSIONS} onUnauthorized={noop} />);
const rail = () => screen.getByRole("complementary", { name: "会话列表" });
const openOverview = () =>
  fireEvent.click(screen.getByRole("button", { name: /^会话总览\d/ }));

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
});
afterEach(cleanup);

test("rail 按序列出全部会话，空名显示未命名，状态点带名称", () => {
  mount();
  const items = within(rail())
    .getAllByRole("listitem")
    .map((li) => li.textContent);
  expect(items).toEqual(["01甲", "02乙", "03未命名会话"]);
  expect(within(rail()).getByRole("img", { name: "运行中" })).toBeTruthy();
});

test("点会话设为活动并记住；刷新后恢复，会话已不存在时当作没选", () => {
  mount();
  fireEvent.click(within(rail()).getByRole("button", { name: /乙/ }));
  expect(
    within(rail())
      .getByRole("button", { name: /乙/ })
      .getAttribute("aria-current"),
  ).toBe("true");
  expect(localStorage.getItem("yuanshu.activeSession")).toBe("s2");

  cleanup();
  mount();
  expect(
    within(rail())
      .getByRole("button", { name: /乙/ })
      .getAttribute("aria-current"),
  ).toBe("true");

  cleanup();
  localStorage.setItem("yuanshu.activeSession", "gone");
  mount();
  expect(rail().querySelector("[aria-current]")).toBeNull();
});

test("会话总览：悬浮面板列全量会话，点行切换并收起", () => {
  mount();
  expect(screen.queryByRole("region", { name: "会话总览" })).toBeNull();
  openOverview();
  const panel = screen.getByRole("region", { name: "会话总览" });
  expect(within(panel).getAllByRole("listitem")).toHaveLength(3);

  fireEvent.click(within(panel).getByRole("button", { name: /乙/ }));
  expect(screen.queryByRole("region", { name: "会话总览" })).toBeNull();
  expect(
    within(rail())
      .getByRole("button", { name: /乙/ })
      .getAttribute("aria-current"),
  ).toBe("true");
});

test("会话总览：Esc、点面板外、再点按钮都能收起，焦点回到按钮", () => {
  mount();
  const trigger = () => screen.getByRole("button", { name: /^会话总览\d/ });
  const isOpen = () => !!screen.queryByRole("region", { name: "会话总览" });

  openOverview();
  act(() => {
    fireEvent.keyDown(window, { key: "Escape" });
  });
  expect(isOpen()).toBe(false);
  expect(document.activeElement).toBe(trigger());

  openOverview();
  fireEvent.pointerDown(document.body);
  expect(isOpen()).toBe(false);

  openOverview();
  fireEvent.pointerDown(trigger());
  fireEvent.click(trigger());
  expect(isOpen()).toBe(false);
});

test("会话总览的「详情」进入会话深挖页 /sessions/:id", () => {
  mount();
  openOverview();
  fireEvent.click(screen.getByRole("link", { name: "进入 乙 详情" }));
  expect(location.pathname).toBe("/sessions/s2");
  expect(screen.getByRole("region", { name: "乙" })).toBeTruthy();
});
