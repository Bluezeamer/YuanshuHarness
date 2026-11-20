import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SidebarController } from "./controller";
import { MiniRail } from "./MiniRail";

afterEach(cleanup);

test("收起的左轨也能新建工作区、进设置、展开（窄屏上没有别的入口）", () => {
  const c = {
    sections: [],
    newWorkspace: vi.fn(),
    openSettings: vi.fn(),
  } as unknown as SidebarController;
  const onExpand = vi.fn();
  render(<MiniRail c={c} onExpand={onExpand} />);
  fireEvent.click(screen.getByRole("button", { name: "新建工作区" }));
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(screen.getByRole("button", { name: "展开左轨" }));
  expect(c.newWorkspace).toHaveBeenCalledOnce();
  expect(c.openSettings).toHaveBeenCalledOnce();
  expect(onExpand).toHaveBeenCalledOnce();
});
