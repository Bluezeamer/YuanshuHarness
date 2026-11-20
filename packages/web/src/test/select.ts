import { fireEvent, screen } from "@testing-library/react";

// 测试里操作 ui/Select 的辅助：自绘下拉没有原生 select 的 value / options，统一读 data-value。

/** 点开下拉，按 value 选中一项 */
export function choose(trigger: HTMLElement, value: string): void {
  fireEvent.click(trigger);
  const opt = screen
    .getAllByRole("option")
    .find((o) => o.getAttribute("data-value") === value);
  if (!opt) throw new Error(`下拉里没有 value=${value} 的选项`);
  fireEvent.click(opt);
}

/** 下拉当前的 value */
export const selectedValue = (trigger: HTMLElement): string =>
  trigger.getAttribute("data-value") ?? "";

/** 点开下拉读出所有选项的 value 与是否禁用，再关上 */
export function optionsOf(
  trigger: HTMLElement,
): { value: string; disabled: boolean }[] {
  fireEvent.click(trigger);
  const out = screen.getAllByRole("option").map((o) => ({
    value: o.getAttribute("data-value") ?? "",
    disabled: (o as HTMLButtonElement).disabled,
  }));
  fireEvent.click(trigger);
  return out;
}
