import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Checkbox, Switch } from "./Switch";

afterEach(cleanup);

test("Switch 暴露 role=switch 与 aria-checked，点击回传取反值", () => {
  const onChange = vi.fn();
  render(<Switch checked={false} onChange={onChange} aria-label="启用" />);
  const s = screen.getByRole("switch", { name: "启用" });
  expect(s.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(s);
  expect(onChange).toHaveBeenCalledWith(true);
});

test("Switch 已开启时点击回传 false；disabled 不触发", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <Switch checked onChange={onChange} aria-label="启用" />,
  );
  fireEvent.click(screen.getByRole("switch"));
  expect(onChange).toHaveBeenLastCalledWith(false);
  onChange.mockClear();
  rerender(<Switch checked onChange={onChange} disabled aria-label="启用" />);
  fireEvent.click(screen.getByRole("switch"));
  expect(onChange).not.toHaveBeenCalled();
});

test("Checkbox 勾选态切换：未选 -> true，已选 -> false", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <Checkbox checked={false} onChange={onChange}>
      全选
    </Checkbox>,
  );
  const c = screen.getByRole("checkbox", { name: "全选" });
  expect(c.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(c);
  expect(onChange).toHaveBeenLastCalledWith(true);
  rerender(
    <Checkbox checked onChange={onChange}>
      全选
    </Checkbox>,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  expect(onChange).toHaveBeenLastCalledWith(false);
});

test("Checkbox 半选暴露 aria-checked=mixed，点击视为全选", () => {
  const onChange = vi.fn();
  render(
    <Checkbox checked="mixed" onChange={onChange} aria-label="选择本页" />,
  );
  const c = screen.getByRole("checkbox", { name: "选择本页" });
  expect(c.getAttribute("aria-checked")).toBe("mixed");
  fireEvent.click(c);
  expect(onChange).toHaveBeenCalledWith(true);
});
