import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CardGrid, type CardGridItem } from "./CardGrid";

afterEach(cleanup);

const item = (
  name: string,
  over: Partial<CardGridItem> = {},
): CardGridItem => ({
  id: name,
  name,
  title: name,
  description: `${name} 的描述`,
  search: `${name}${name} 的描述`,
  ...over,
});

const mount = (items: CardGridItem[], extra = {}) => {
  const onOpen = vi.fn();
  const onAdd = vi.fn();
  render(
    <CardGrid
      items={items}
      searchLabel="搜索 Agent"
      addLabel="新建 Agent"
      onAdd={onAdd}
      onOpen={onOpen}
      emptyTitle="还没有 Agent"
      {...extra}
    />,
  );
  return { onOpen, onAdd };
};

test("点卡片标题打开，点主按钮新建", () => {
  const { onOpen, onAdd } = mount([item("coder"), item("reviewer")]);
  fireEvent.click(screen.getByRole("button", { name: "reviewer" }));
  expect(onOpen).toHaveBeenCalledWith("reviewer");
  fireEvent.click(screen.getByRole("button", { name: /新建 Agent/ }));
  expect(onAdd).toHaveBeenCalledTimes(1);
});

test("搜索只留下匹配的卡片；没有匹配时说明是搜不到而不是没有数据", () => {
  mount([item("coder"), item("reviewer")]);
  fireEvent.change(screen.getByLabelText("搜索 Agent"), {
    target: { value: "review" },
  });
  expect(screen.queryByRole("button", { name: "coder" })).toBeNull();
  expect(screen.getByRole("button", { name: "reviewer" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("搜索 Agent"), {
    target: { value: "没有这个" },
  });
  expect(screen.getByText("没有符合的结果")).toBeTruthy();
});

test("一张都没有时显示空状态与提示；菜单按钮带卡片名", () => {
  mount([], { emptyHint: "点右上角新建" });
  expect(screen.getByText("还没有 Agent")).toBeTruthy();
  expect(screen.getByText("点右上角新建")).toBeTruthy();
  cleanup();
  mount([
    item("coder", { menu: [{ id: "x", label: "复制", onSelect: () => {} }] }),
  ]);
  expect(screen.getByRole("button", { name: "coder 的操作" })).toBeTruthy();
});

test("没给 onAdd 就没有主按钮", () => {
  render(
    <CardGrid
      items={[item("coder")]}
      searchLabel="搜索"
      onOpen={() => {}}
      emptyTitle="空"
    />,
  );
  expect(screen.queryByRole("button", { name: /新建/ })).toBeNull();
});
