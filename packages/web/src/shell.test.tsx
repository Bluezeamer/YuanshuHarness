import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Shell } from "./Shell";

const s = (id: string, name: string | null, running = false) => ({
  id,
  name,
  createdAt: "t",
  updatedAt: "t",
  running,
});

const noop = () => {};

afterEach(cleanup);

test("R6 按给定顺序渲染，空名显示未命名会话", () => {
  render(
    <Shell sessions={[s("1", "乙"), s("2", null)]} onUnauthorized={noop} />,
  );
  const items = screen.getAllByRole("listitem").map((li) => li.textContent);
  expect(items).toEqual(["01乙", "02未命名会话"]);
});

test("R6 空列表显示提示", () => {
  render(<Shell sessions={[]} onUnauthorized={noop} />);
  expect(screen.getByText("还没有会话")).toBeTruthy();
});

test("R7 点击选中并在主区显示名称", () => {
  render(
    <Shell sessions={[s("1", "乙"), s("2", "丙")]} onUnauthorized={noop} />,
  );
  expect(screen.getByText("选择会话")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /丙/ }));
  expect(
    screen.getByRole("button", { name: /丙/ }).getAttribute("aria-current"),
  ).toBe("true");
  expect(screen.getByRole("heading", { name: "丙" })).toBeTruthy();
  expect(screen.queryByText("选择会话")).toBeNull();
});

test("R8 状态点带可访问名称", () => {
  render(
    <Shell
      sessions={[s("1", "乙", true), s("2", "丙", false)]}
      onUnauthorized={noop}
    />,
  );
  expect(screen.getByLabelText("运行中")).toBeTruthy();
  expect(screen.getByLabelText("空闲")).toBeTruthy();
});
