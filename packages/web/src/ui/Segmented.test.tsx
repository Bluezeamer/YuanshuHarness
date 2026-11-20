import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Segmented, Tri, type TriValue } from "./Segmented";

afterEach(cleanup);

const OPTIONS = [
  { value: "a", label: "甲" },
  { value: "b", label: "乙", disabled: true },
  { value: "c", label: "丙" },
] as const;

test("Segmented 是 radiogroup，选中项 aria-checked 且是唯一的 Tab 停靠点", () => {
  render(
    <Segmented
      aria-label="排序"
      options={OPTIONS}
      value="c"
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("radiogroup", { name: "排序" })).toBeTruthy();
  const [a, , c] = screen.getAllByRole("radio");
  expect(c?.getAttribute("aria-checked")).toBe("true");
  expect(c?.getAttribute("tabindex")).toBe("0");
  expect(a?.getAttribute("tabindex")).toBe("-1");
});

test("Segmented 方向键在启用项间循环并移动焦点，跳过 disabled", () => {
  const Host = () => {
    const [v, setV] = useState<"a" | "b" | "c">("a");
    return (
      <Segmented
        aria-label="排序"
        options={OPTIONS}
        value={v}
        onChange={setV}
      />
    );
  };
  render(<Host />);
  const group = screen.getByRole("radiogroup");
  fireEvent.keyDown(group, { key: "ArrowRight" });
  const radios = screen.getAllByRole("radio");
  expect(radios[2]?.getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(radios[2]);
  fireEvent.keyDown(group, { key: "ArrowRight" });
  expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(group, { key: "ArrowLeft" });
  expect(radios[2]?.getAttribute("aria-checked")).toBe("true");
});

test("Segmented 点击触发 onChange，disabled 整组不响应", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <Segmented
      aria-label="排序"
      options={OPTIONS}
      value="a"
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "丙" }));
  expect(onChange).toHaveBeenCalledWith("c");
  onChange.mockClear();
  rerender(
    <Segmented
      aria-label="排序"
      options={OPTIONS}
      value="a"
      onChange={onChange}
      disabled
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "丙" }));
  expect(onChange).not.toHaveBeenCalled();
});

test("Tri 提供 自动/开/关 三段并回传取值", () => {
  const onChange = vi.fn<(v: TriValue) => void>();
  render(<Tri aria-label="developer 角色" value="auto" onChange={onChange} />);
  expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual([
    "自动",
    "开",
    "关",
  ]);
  fireEvent.click(screen.getByRole("radio", { name: "关" }));
  expect(onChange).toHaveBeenCalledWith("off");
});
