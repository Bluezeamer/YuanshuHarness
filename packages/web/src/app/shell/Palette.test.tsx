import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PaletteCommand } from "./commands";
import { Palette } from "./Palette";

afterEach(cleanup);

const cmds = (run = vi.fn()): PaletteCommand[] => [
  { id: "new", kind: "action", label: "新建会话", key: "Ctrl+N", run },
  { id: "rail", kind: "view", label: "折叠 / 展开会话栏", run },
  { id: "ws-a", kind: "workspace", label: "官网", note: "3 个对话", run },
  { id: "ses-a", kind: "session", label: "补齐 webhook", run },
];

const box = () => screen.getByRole("combobox", { name: "搜索命令" });
const rows = () => screen.getAllByRole("option");

test("关闭时不渲染；打开后按分类分组，快捷键提示显示", () => {
  const { rerender } = render(
    <Palette open={false} onClose={() => {}} commands={cmds()} />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<Palette open onClose={() => {}} commands={cmds()} />);
  expect(screen.getByRole("group", { name: "操作" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "视图" })).toBeTruthy();
  expect(screen.getByText("Ctrl+N")).toBeTruthy();
  // 不搜索时不列会话；工作区行带对话数
  expect(rows()).toHaveLength(3);
  expect(screen.getByText("3 个对话")).toBeTruthy();
  expect(screen.queryByText("补齐 webhook")).toBeNull();
  expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
});

test("lead 指定的分类排最前（总览入口让工作区打头）", () => {
  render(
    <Palette open onClose={() => {}} commands={cmds()} lead="workspace" />,
  );
  expect(rows()[0]?.textContent).toContain("官网");
});

test("输入过滤；无匹配给空态；清空后恢复", () => {
  render(<Palette open onClose={() => {}} commands={cmds()} />);
  fireEvent.change(box(), { target: { value: "webhook" } });
  expect(rows()).toHaveLength(1);
  fireEvent.change(box(), { target: { value: "不存在" } });
  expect(screen.getByText("没有匹配的命令")).toBeTruthy();
  fireEvent.change(box(), { target: { value: "" } });
  expect(rows()).toHaveLength(3);
});

test("↑↓ 循环移动光标；Enter 先关闭再执行光标行", () => {
  const run = vi.fn();
  const onClose = vi.fn();
  render(<Palette open onClose={onClose} commands={cmds(run)} />);
  fireEvent.keyDown(box(), { key: "ArrowDown" });
  expect(rows()[1]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(box(), { key: "ArrowUp" });
  fireEvent.keyDown(box(), { key: "ArrowUp" });
  expect(rows()[2]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(1);
});

test("过滤后光标回到第一项；点击某行执行它", () => {
  const run = vi.fn();
  render(<Palette open onClose={() => {}} commands={cmds(run)} />);
  fireEvent.keyDown(box(), { key: "ArrowDown" });
  fireEvent.change(box(), { target: { value: "会话" } });
  expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(rows()[0] as HTMLElement);
  expect(run).toHaveBeenCalledTimes(1);
});

test("没有匹配时 Enter 不执行也不关闭；Esc 关闭", () => {
  const run = vi.fn();
  const onClose = vi.fn();
  render(<Palette open onClose={onClose} commands={cmds(run)} />);
  fireEvent.change(box(), { target: { value: "不存在" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(run).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

test("再次打开时查询被清空", () => {
  const { rerender } = render(
    <Palette open onClose={() => {}} commands={cmds()} />,
  );
  fireEvent.change(box(), { target: { value: "webhook" } });
  rerender(<Palette open={false} onClose={() => {}} commands={cmds()} />);
  rerender(<Palette open onClose={() => {}} commands={cmds()} />);
  expect((box() as HTMLInputElement).value).toBe("");
  expect(rows()).toHaveLength(3);
});
