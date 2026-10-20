import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseRoute } from "./router";
import { Shell } from "./Shell";

const s = (id: string, name: string | null) => ({
  id,
  name,
  createdAt: "t",
  updatedAt: "t",
  running: false,
});
const noop = () => {};
const mount = () =>
  render(<Shell sessions={[s("a/1", "甲")]} onUnauthorized={noop} />);

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
});
afterEach(cleanup);

test("parseRoute：各路径与尾斜杠、编码的 id、未知路径", () => {
  expect(parseRoute("/")).toEqual({ name: "workspace" });
  expect(parseRoute("/capabilities/")).toEqual({ name: "capabilities" });
  expect(parseRoute("/settings")).toEqual({ name: "settings" });
  expect(parseRoute("/preview")).toEqual({ name: "preview" });
  expect(parseRoute("/sessions/a%2F1")).toEqual({
    name: "session",
    id: "a/1",
  });
  expect(parseRoute("/sessions/")).toEqual({ name: "notfound" });
  expect(parseRoute("/nope")).toEqual({ name: "notfound" });
});

test("topnav 四项，当前页带 aria-current", () => {
  mount();
  const nav = screen.getByRole("navigation", { name: "主导航" });
  expect(
    Array.from(nav.querySelectorAll("a")).map((a) => a.textContent),
  ).toEqual(["工作区", "能力集", "设置", "内置预览"]);
  expect(
    screen.getByRole("link", { name: "工作区" }).getAttribute("aria-current"),
  ).toBe("page");
  expect(
    screen.getByRole("link", { name: "能力集" }).getAttribute("aria-current"),
  ).toBeNull();
});

test("点击导航：路由变化，页面容器出现，回到工作区后消失", () => {
  mount();
  fireEvent.click(screen.getByRole("link", { name: "能力集" }));
  expect(location.pathname).toBe("/capabilities");
  expect(screen.getByRole("region", { name: "能力集" })).toBeTruthy();
  expect(
    screen
      .getAllByRole("tab")
      .map((t) => t.textContent)
      .slice(-4),
  ).toEqual(["Agent", "提示词块", "Skill", "MCP"]);
  expect(
    screen.getByRole("link", { name: "能力集" }).getAttribute("aria-current"),
  ).toBe("page");

  fireEvent.click(screen.getByRole("link", { name: "内置预览" }));
  expect(screen.getByRole("region", { name: "内置预览" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "能力集" })).toBeNull();

  fireEvent.click(screen.getByRole("link", { name: "工作区" }));
  expect(location.pathname).toBe("/");
  expect(screen.queryByRole("region", { name: "内置预览" })).toBeNull();
});

test("带修饰键的点击留给浏览器，不走前端路由", () => {
  mount();
  fireEvent.click(screen.getByRole("link", { name: "能力集" }), {
    ctrlKey: true,
  });
  expect(location.pathname).toBe("/");
});

test("直接打开 /sessions/:id：显示会话名与返回入口；不存在的 id 有提示", () => {
  history.replaceState(null, "", "/sessions/a%2F1");
  mount();
  expect(screen.getByRole("region", { name: "甲" })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "← 返回工作区" }));
  expect(location.pathname).toBe("/");
  expect(screen.queryByRole("region", { name: "甲" })).toBeNull();

  history.replaceState(null, "", "/sessions/zzz");
  cleanup();
  mount();
  expect(screen.getByRole("region", { name: "会话不存在" })).toBeTruthy();
});

test("未知路径显示页面不存在", () => {
  history.replaceState(null, "", "/nope");
  mount();
  expect(screen.getByRole("region", { name: "页面不存在" })).toBeTruthy();
});

test("浏览器后退（popstate）同步路由", () => {
  mount();
  fireEvent.click(screen.getByRole("link", { name: "能力集" }));
  history.replaceState(null, "", "/");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(screen.queryByRole("region", { name: "能力集" })).toBeNull();
});
