import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SidebarController } from "./controller";
import { aggregate, type Ws } from "./model";
import { WorkspaceBlock } from "./WorkspaceBlock";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const w: Ws = {
  id: "w1",
  name: "元枢",
  path: "/repo/api",
  extraDirs: 1,
  group: null,
  description: "接口与前端",
  dirs: ["/repo/api", "build-box:/srv/web"],
  sessions: [
    {
      id: "s1",
      title: "整理接口文档",
      status: "running",
      ago: ["3", "分钟"],
    },
  ],
};

const c = {
  query: "",
  open: new Set<string>(),
  archivedOpen: new Set<string>(),
  currentWorkspace: null,
  selection: null,
  groups: [],
  drag: null,
  shown: (x: Ws) => x.sessions,
  aggOf: (x: Ws) => aggregate(x.sessions),
} as unknown as SidebarController;

const head = () =>
  screen.getByRole("button", { name: /元枢/ }).closest(".u-hc") as HTMLElement;

test("悬停工作区头：卡片给出描述、对话统计与全部目录", () => {
  render(<WorkspaceBlock ws={w} index={0} c={c} />);
  fireEvent.pointerEnter(head());
  act(() => vi.advanceTimersByTime(500));
  const text = screen.getByRole("tooltip").textContent ?? "";
  for (const t of [
    "元枢",
    "接口与前端",
    "1 个 · 1 个执行中",
    "主目录/repo/api",
    "附加目录build-box:/srv/web",
  ])
    expect(text).toContain(t);
});

test("没有描述就不出正文；头上不再挂原生 title", () => {
  const { description: _, ...bare } = w;
  render(<WorkspaceBlock ws={bare} index={0} c={c} />);
  expect(
    screen.getByRole("button", { name: /元枢/ }).getAttribute("title"),
  ).toBeNull();
  fireEvent.pointerEnter(head());
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByRole("tooltip").querySelector(".u-hc-text")).toBeNull();
});
