import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Empty } from "./Empty";
import { Loading } from "./Loading";
import { ReadBar } from "./ReadBar";

afterEach(cleanup);

test("Loading 是 status，带文字、不画空态的虚线框", () => {
  render(<Loading>正在读取供应商…</Loading>);
  const el = screen.getByRole("status");
  expect(el.textContent).toBe("正在读取供应商…");
  expect(el.className).not.toContain("u-empty");
});

test("Empty 的 tone=danger 把「读取失败」与「还没有」区分开", () => {
  render(<Empty tone="danger" title="读取供应商失败" data-testid="e" />);
  expect(screen.getByTestId("e").getAttribute("data-tone")).toBe("danger");
});

test("Empty 渲染标题、说明与操作", () => {
  render(
    <Empty
      title="还没有连接"
      description="添加后会出现在这里"
      action={<button type="button">添加</button>}
      data-testid="e"
    />,
  );
  expect(screen.getByTestId("e").textContent).toContain("还没有连接");
  expect(screen.getByText("添加后会出现在这里")).toBeTruthy();
  expect(screen.getByRole("button", { name: "添加" })).toBeTruthy();
});

test("ReadBar 暴露 meter 语义，数值被钳制在 [0,max]", () => {
  render(
    <ReadBar label="上下文占用" value={250} max={200} text="200k / 200k" />,
  );
  const m = screen.getByRole("meter", { name: "上下文占用" });
  expect(m.getAttribute("aria-valuemax")).toBe("200");
  expect(m.getAttribute("aria-valuenow")).toBe("200");
  expect(screen.getByText("200k / 200k")).toBeTruthy();
});

test("ReadBar 按占比切换 level，宽度写入 --w", () => {
  const { rerender } = render(<ReadBar label="占用" value={50} max={100} />);
  const level = () => screen.getByRole("meter").getAttribute("data-level");
  const width = () =>
    (screen.getByRole("meter") as HTMLElement).style.getPropertyValue("--w");
  expect(level()).toBe("ok");
  expect(width()).toBe("50.0%");
  rerender(<ReadBar label="占用" value={85} max={100} />);
  expect(level()).toBe("warn");
  rerender(<ReadBar label="占用" value={96} max={100} />);
  expect(level()).toBe("danger");
});
