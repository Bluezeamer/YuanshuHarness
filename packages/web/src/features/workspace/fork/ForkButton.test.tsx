import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ForkButton } from "./ForkButton";

afterEach(cleanup);

test("点一下就分叉，没有菜单", () => {
  const onFork = vi.fn();
  render(<ForkButton onFork={onFork} />);
  fireEvent.click(screen.getByRole("button", { name: "分叉会话" }));
  expect(onFork).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("运行中/压缩中禁用：按钮带原因提示，点击不分叉", () => {
  const onFork = vi.fn();
  render(<ForkButton disabledReason="运行中不能分叉" onFork={onFork} />);
  const trigger = screen.getByRole("button", { name: "分叉会话" });
  expect(trigger.title).toBe("运行中不能分叉");
  expect(trigger.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(trigger);
  expect(onFork).not.toHaveBeenCalled();
});

test("分叉进行中置忙：不发第二个请求", () => {
  const onFork = vi.fn();
  render(<ForkButton busy onFork={onFork} />);
  const trigger = screen.getByRole("button", { name: "正在分叉…" });
  expect(trigger.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(trigger);
  expect(onFork).not.toHaveBeenCalled();
});
