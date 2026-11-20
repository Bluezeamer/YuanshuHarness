import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SidebarController } from "./controller";
import type { Sess } from "./model";
import { SessionRows } from "./SessionRows";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const parent: Sess = {
  id: "p",
  title: "整理接口文档",
  status: "running",
  unread: "result",
  ago: ["3", "分钟"],
  no: "#0042",
  dir: "build-box:/srv/web",
  createdAt: new Date(2026, 10, 6, 9, 30).toISOString(),
  updatedAt: new Date(2026, 10, 7, 14, 5).toISOString(),
};
const kid: Sess = {
  id: "k",
  title: "整理接口文档 · 分支1",
  status: "idle",
  parent: "p",
  ago: ["1", "小时"],
};

const c = {
  currentSession: null,
  selection: null,
  viewing: new Set<string>(),
  drag: null,
  pickSession: vi.fn(),
  pinSession: vi.fn(),
  archiveSessions: vi.fn(),
  refreshContext: vi.fn(),
} as unknown as SidebarController;

const rowOf = (name: RegExp) =>
  screen.getByRole("button", { name }).closest(".u-hc") as HTMLElement;

const hover = (row: HTMLElement) => {
  fireEvent.pointerEnter(row);
  act(() => vi.advanceTimersByTime(500));
  return screen.queryByRole("tooltip");
};

test("悬停会话行：卡片给出完整标题与行里没有的事实", () => {
  render(<SessionRows list={[parent, kid]} c={c} />);
  const card = hover(rowOf(/执行中/));
  expect(card?.textContent).toContain("整理接口文档");
  for (const t of [
    "执行中 · 有新结果",
    "build-box:/srv/web",
    "2026-11-06 09:30",
    "2026-11-07 14:05",
    "#0042",
  ])
    expect(card?.textContent).toContain(t);
  expect(card?.textContent).not.toContain("来源");
});

test("fork 行的卡片写明从哪个会话分出", () => {
  render(<SessionRows list={[parent, kid]} c={c} />);
  const card = hover(rowOf(/分支1/));
  expect(card?.textContent).toContain("从「整理接口文档」分出");
});

test("行上不再挂原生 title，免得和卡片叠在一起", () => {
  render(<SessionRows list={[parent]} c={c} />);
  expect(
    screen.getByRole("button", { name: /整理接口文档/ }).getAttribute("title"),
  ).toBeNull();
});

test("悬停按钮：刷新上下文与归档，点归档只归这一个会话；已归档的行两个都没有", () => {
  render(<SessionRows list={[parent]} c={c} />);
  fireEvent.click(screen.getByRole("button", { name: "归档" }));
  expect(c.archiveSessions).toHaveBeenCalledWith(["p"]);
  expect(screen.getByRole("button", { name: "刷新上下文" })).toBeTruthy();
  cleanup();
  render(<SessionRows list={[{ ...parent, archived: true }]} c={c} />);
  expect(screen.queryByRole("button", { name: "归档" })).toBeNull();
  expect(screen.queryByRole("button", { name: "刷新上下文" })).toBeNull();
});
