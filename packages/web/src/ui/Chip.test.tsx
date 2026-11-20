import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Chip, Dot, FilterChip, Kbd } from "./Chip";

afterEach(cleanup);

test("Chip 把 tone 与 dot 写入 data 属性", () => {
  render(
    <Chip tone="live" dot data-testid="c">
      在线
    </Chip>,
  );
  const c = screen.getByTestId("c");
  expect(c.getAttribute("data-tone")).toBe("live");
  expect(c.getAttribute("data-dot")).toBe("true");
  expect(c.textContent).toBe("在线");
});

test("FilterChip 用 aria-pressed 表达选中，点击触发回调，count 单独渲染", () => {
  const onClick = vi.fn();
  render(
    <FilterChip pressed={false} count={3} onClick={onClick}>
      已启用
    </FilterChip>,
  );
  const b = screen.getByRole("button", { name: /已启用/ });
  expect(b.getAttribute("aria-pressed")).toBe("false");
  expect(b.textContent).toContain("3");
  fireEvent.click(b);
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("Dot 无 label 时对读屏隐藏，有 label 时是 img 语义", () => {
  const { rerender } = render(
    <Dot tone="live" motion="breathe" data-testid="d" />,
  );
  const d = screen.getByTestId("d");
  expect(d.getAttribute("aria-hidden")).toBe("true");
  expect(d.getAttribute("data-motion")).toBe("breathe");
  rerender(<Dot tone="danger" label="连接失败" data-testid="d" />);
  expect(screen.getByRole("img", { name: "连接失败" })).toBeTruthy();
  expect(screen.getByTestId("d").getAttribute("aria-hidden")).toBeNull();
});

test("Kbd 渲染 kbd 元素", () => {
  render(<Kbd>⌘K</Kbd>);
  expect(screen.getByText("⌘K").tagName).toBe("KBD");
});
