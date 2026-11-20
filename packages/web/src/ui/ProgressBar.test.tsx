import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ProgressBar } from "./ProgressBar";

afterEach(cleanup);

test("确定进度：aria 值与填充宽度跟随 value", () => {
  render(<ProgressBar value={42} label="上传进度 a.txt" />);
  const bar = screen.getByRole("progressbar", { name: "上传进度 a.txt" });
  expect(bar.getAttribute("aria-valuemin")).toBe("0");
  expect(bar.getAttribute("aria-valuemax")).toBe("100");
  expect(bar.getAttribute("aria-valuenow")).toBe("42");
  expect(bar.hasAttribute("data-indeterminate")).toBe(false);
  expect((bar.firstElementChild as HTMLElement).style.width).toBe("42%");
});

test("不确定进度：不报数值，标记 data-indeterminate", () => {
  const { container } = render(
    <ProgressBar value={null} label="传输进度" className="ws-xfer-bar" />,
  );
  const bar = container.querySelector(".u-progress.ws-xfer-bar") as HTMLElement;
  expect(bar.getAttribute("aria-valuenow")).toBeNull();
  expect(bar.hasAttribute("data-indeterminate")).toBe(true);
  expect((bar.firstElementChild as HTMLElement).style.width).toBe("");
});
