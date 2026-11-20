import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Tree, type TreeNode, type TreeProps } from "./Tree";

afterEach(cleanup);

const f = (id: string): TreeNode => ({ id, kind: "folder" });
const i = (id: string): TreeNode => ({ id, kind: "item" });
const NODES = [f("产品"), i("产品/时间线"), f("空"), i("想法"), i("设计")];

/** 拖拽用的假 dataTransfer：记录 setData、可读 dropEffect。 */
const dt = () => {
  const data: Record<string, string> = {};
  return {
    data,
    effectAllowed: "all",
    dropEffect: "none",
    setData: (k: string, v: string) => {
      data[k] = v;
    },
    getData: (k: string) => data[k] ?? "",
    types: [] as string[],
  };
};

const show = (over: Partial<TreeProps> = {}) =>
  render(<Tree label="树" nodes={NODES} {...over} />);
const row = (id: string) =>
  document.querySelector(`[data-tree-id="${id}"]`) as HTMLElement;
const ids = () =>
  [...document.querySelectorAll("[data-tree-id]")].map((e) =>
    e.getAttribute("data-tree-id"),
  );

test("初始全部收起；点文件夹展开 / 收起（再点收起），点条目回调 onOpen，不展开文件夹", () => {
  const onOpen = vi.fn();
  show({ onOpen });
  expect(ids()).toEqual(["产品", "空", "想法", "设计"]);
  const folder = within(row("产品")).getByRole("button");
  fireEvent.click(folder);
  expect(ids()).toEqual(["产品", "产品/时间线", "空", "想法", "设计"]);
  expect(row("产品").getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(folder);
  expect(ids()).toEqual(["产品", "空", "想法", "设计"]);
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(within(row("想法")).getByRole("button"));
  expect(onOpen).toHaveBeenCalledWith(NODES[3]);
});

test("受控展开：给了 open 就按它显示，点文件夹只回调 onOpenChange；current 行高亮；query 过滤并强制展开祖先", () => {
  const onOpenChange = vi.fn();
  const { rerender } = show({
    open: new Set(["产品"]),
    onOpenChange,
    current: "想法",
  });
  expect(ids()).toContain("产品/时间线");
  fireEvent.click(within(row("产品")).getByRole("button"));
  expect(onOpenChange).toHaveBeenCalledWith(new Set());
  expect(ids()).toContain("产品/时间线");
  expect(
    row("想法").querySelector(".u-lrow")?.hasAttribute("data-current"),
  ).toBe(true);
  rerender(<Tree label="树" nodes={NODES} query="时间" />);
  expect(ids()).toEqual(["产品", "产品/时间线"]);
});

test("方向键在可见行里走、右键展开 / 进入、左键收起 / 回父级；Enter 同点击", () => {
  const onOpen = vi.fn();
  show({ onOpen });
  const tree = screen.getByRole("tree");
  fireEvent.click(within(row("产品")).getByRole("button")); // 展开并聚焦
  fireEvent.keyDown(tree, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    within(row("产品/时间线")).getByRole("button"),
  );
  fireEvent.keyDown(tree, { key: "ArrowLeft" }); // 条目：回到父级
  expect(document.activeElement).toBe(within(row("产品")).getByRole("button"));
  fireEvent.keyDown(tree, { key: "ArrowLeft" }); // 展开的文件夹：收起
  expect(ids()).toEqual(["产品", "空", "想法", "设计"]);
  fireEvent.keyDown(tree, { key: "ArrowRight" }); // 收起的文件夹：展开
  expect(ids()).toContain("产品/时间线");
  fireEvent.keyDown(tree, { key: "ArrowRight" }); // 已展开：进到第一个子行
  expect(document.activeElement).toBe(
    within(row("产品/时间线")).getByRole("button"),
  );
  fireEvent.keyDown(tree, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith(i("产品/时间线"));
});

test("F2 进入行内改名：Enter 确认回调 onRename(node, 新的最后一段)；Esc 与失焦放弃；返回字符串就留在编辑态显示错误；没改或为空不回调", async () => {
  const onRename = vi.fn(async (_n: TreeNode, name: string) =>
    name === "撞名" ? "已有同名" : null,
  );
  show({ onRename });
  const tree = screen.getByRole("tree");
  fireEvent.click(within(row("想法")).getByRole("button"));
  fireEvent.keyDown(tree, { key: "F2" });
  const input = screen.getByLabelText("新名字") as HTMLInputElement;
  expect(input.value).toBe("想法");

  fireEvent.change(input, { target: { value: "撞名" } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  expect(onRename).toHaveBeenCalledWith(NODES[3], "撞名");
  expect(screen.getByRole("alert").textContent).toBe("已有同名");
  expect(screen.queryByLabelText("新名字")).not.toBeNull();

  fireEvent.change(input, { target: { value: "  新名  " } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  expect(onRename).toHaveBeenLastCalledWith(NODES[3], "新名");
  expect(screen.queryByLabelText("新名字")).toBeNull();

  // Esc、失焦、空名、没改：都不回调
  onRename.mockClear();
  fireEvent.keyDown(tree, { key: "F2" });
  let again = screen.getByLabelText("新名字");
  fireEvent.change(again, { target: { value: "x" } });
  fireEvent.keyDown(again, { key: "Escape" });
  expect(screen.queryByLabelText("新名字")).toBeNull();
  fireEvent.keyDown(tree, { key: "F2" });
  again = screen.getByLabelText("新名字");
  fireEvent.change(again, { target: { value: "y" } });
  fireEvent.blur(again);
  expect(screen.queryByLabelText("新名字")).toBeNull();
  fireEvent.keyDown(tree, { key: "F2" });
  again = screen.getByLabelText("新名字");
  fireEvent.change(again, { target: { value: "   " } });
  fireEvent.keyDown(again, { key: "Enter" });
  expect(onRename).not.toHaveBeenCalled();
});

test("Delete 键回调 onDelete(选中的节点)，Ctrl 点击多选、Shift 点击连选；不给 onDelete 时无事发生", () => {
  const onDelete = vi.fn();
  show({ onDelete });
  const tree = screen.getByRole("tree");
  fireEvent.click(within(row("想法")).getByRole("button"));
  fireEvent.click(within(row("设计")).getByRole("button"), { ctrlKey: true });
  fireEvent.keyDown(tree, { key: "Delete" });
  expect(onDelete).toHaveBeenCalledWith([NODES[3], NODES[4]]);
  onDelete.mockClear();
  fireEvent.click(within(row("产品")).getByRole("button")); // 展开 + 选中
  fireEvent.click(within(row("想法")).getByRole("button"), { shiftKey: true });
  fireEvent.keyDown(tree, { key: "Delete" });
  expect(onDelete.mock.calls[0]?.[0].map((n: TreeNode) => n.id)).toEqual([
    "产品",
    "产品/时间线",
    "空",
    "想法",
  ]);
});

test("右键：行上给 node、空白处给 null；菜单里的 rename 动作让这一行进入行内改名", () => {
  const menu = vi.fn((node: TreeNode | null, a: { rename(): void }) => [
    {
      id: "rn",
      label: node ? "重命名" : "新建",
      onSelect: () => a.rename(),
    },
  ]);
  show({ menu, onRename: () => null });
  fireEvent.contextMenu(row("想法"), { clientX: 10, clientY: 10 });
  expect(menu).toHaveBeenLastCalledWith(NODES[3], expect.anything());
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  expect(screen.queryByLabelText("新名字")).not.toBeNull();
  cleanup();
  show({ menu });
  fireEvent.contextMenu(screen.getByRole("tree"), { clientX: 5, clientY: 5 });
  expect(menu).toHaveBeenLastCalledWith(null, expect.anything());
  expect(screen.getByRole("menuitem", { name: "新建" })).toBeTruthy();
});

test("拖到文件夹行：回调 onMove(moves, 文件夹)，并展开目标；条目行上放 = 放进它所在的文件夹", () => {
  const onMove = vi.fn();
  show({ onMove, open: undefined });
  const t = dt();
  fireEvent.dragStart(row("想法"), { dataTransfer: t });
  fireEvent.dragOver(row("空"), { dataTransfer: t });
  expect(row("空").hasAttribute("data-drop")).toBe(true);
  fireEvent.drop(row("空"), { dataTransfer: t });
  expect(onMove).toHaveBeenCalledWith([{ id: "想法", to: "空/想法" }], "空");
  expect(row("空").getAttribute("aria-expanded")).toBe("true");
  expect(row("空").hasAttribute("data-drop")).toBe(false);

  // 展开 产品 后，把 设计 放在 产品/时间线 这个条目上 = 放进 产品
  onMove.mockClear();
  fireEvent.click(within(row("产品")).getByRole("button"));
  const t2 = dt();
  fireEvent.dragStart(row("设计"), { dataTransfer: t2 });
  fireEvent.dragOver(row("产品/时间线"), { dataTransfer: t2 });
  fireEvent.drop(row("产品/时间线"), { dataTransfer: t2 });
  expect(onMove).toHaveBeenCalledWith(
    [{ id: "设计", to: "产品/设计" }],
    "产品",
  );
});

test("拖到空白 = 挪到根；本来就在根上的不算落点；拖拽期间被拖的行标 data-dragging，结束后清掉", () => {
  const onMove = vi.fn();
  show({ onMove, open: new Set(["产品"]) });
  const tree = screen.getByRole("tree");
  const t = dt();
  fireEvent.dragStart(row("产品/时间线"), { dataTransfer: t });
  expect(row("产品/时间线").hasAttribute("data-dragging")).toBe(true);
  fireEvent.dragOver(tree, { dataTransfer: t });
  expect(tree.hasAttribute("data-drop-root")).toBe(true);
  fireEvent.drop(tree, { dataTransfer: t });
  expect(onMove).toHaveBeenCalledWith(
    [{ id: "产品/时间线", to: "时间线" }],
    "",
  );
  expect(row("产品/时间线").hasAttribute("data-dragging")).toBe(false);

  onMove.mockClear();
  const t2 = dt();
  fireEvent.dragStart(row("想法"), { dataTransfer: t2 });
  fireEvent.dragOver(tree, { dataTransfer: t2 });
  expect(tree.hasAttribute("data-drop-root")).toBe(false);
  fireEvent.drop(tree, { dataTransfer: t2 });
  expect(onMove).not.toHaveBeenCalled();
});

test("不能把文件夹拖进自己或子孙；悬停在被拒绝的行上不会冒到根（不会被当成挪到根）；canDrop 拒绝的文件夹不接", () => {
  const onMove = vi.fn();
  const canDrop = vi.fn((_d: TreeNode[], folder: string) => folder !== "空");
  show({ onMove, canDrop, open: new Set(["产品"]) });
  const t = dt();
  fireEvent.dragStart(row("产品"), { dataTransfer: t });
  fireEvent.dragOver(row("产品"), { dataTransfer: t });
  fireEvent.drop(row("产品"), { dataTransfer: t });
  fireEvent.dragOver(row("产品/时间线"), { dataTransfer: t });
  fireEvent.drop(row("产品/时间线"), { dataTransfer: t });
  expect(onMove).not.toHaveBeenCalled();

  const t2 = dt();
  fireEvent.dragStart(row("想法"), { dataTransfer: t2 });
  fireEvent.dragOver(row("空"), { dataTransfer: t2 });
  fireEvent.drop(row("空"), { dataTransfer: t2 });
  expect(canDrop).toHaveBeenCalled();
  expect(onMove).not.toHaveBeenCalled();

  // 子文件夹里的条目悬停在被 canDrop 拒绝的行上：根是接受的，但事件不能冒到根去
  const t3 = dt();
  fireEvent.dragStart(row("产品/时间线"), { dataTransfer: t3 });
  fireEvent.dragOver(row("空"), { dataTransfer: t3 });
  expect(screen.getByRole("tree").hasAttribute("data-drop-root")).toBe(false);
  fireEvent.drop(row("空"), { dataTransfer: t3 });
  expect(onMove).not.toHaveBeenCalled();
});

test("多选一起拖：被选中文件夹里的子孙不单独算；没选中的行被拖时只拖它自己；onDragStartNodes 能往 dataTransfer 补载荷", () => {
  const onMove = vi.fn();
  const onDragStartNodes = vi.fn((e, nodes: TreeNode[]) => {
    e.dataTransfer.setData("x-extra", nodes.map((n) => n.id).join("|"));
  });
  show({ onMove, onDragStartNodes, open: new Set(["产品"]) });
  fireEvent.click(within(row("产品")).getByRole("button"), { ctrlKey: true });
  fireEvent.click(within(row("产品/时间线")).getByRole("button"), {
    ctrlKey: true,
  });
  fireEvent.click(within(row("想法")).getByRole("button"), { ctrlKey: true });
  const t = dt();
  fireEvent.dragStart(row("想法"), { dataTransfer: t });
  expect(onDragStartNodes).toHaveBeenCalledTimes(1);
  expect(t.data["x-extra"]).toBe("产品|想法");
  fireEvent.dragOver(row("空"), { dataTransfer: t });
  fireEvent.drop(row("空"), { dataTransfer: t });
  expect(onMove).toHaveBeenCalledWith(
    [
      { id: "产品", to: "空/产品" },
      { id: "想法", to: "空/想法" },
    ],
    "空",
  );

  onMove.mockClear();
  const t2 = dt();
  fireEvent.dragStart(row("设计"), { dataTransfer: t2 }); // 没在选中里：只拖它自己
  expect(t2.data["x-extra"]).toBe("设计");
});

test("不给 onMove 与 onDragStartNodes 时行不可拖", () => {
  show();
  expect(row("想法").getAttribute("draggable")).toBe("false");
  cleanup();
  show({ onMove: () => {} });
  expect(row("想法").getAttribute("draggable")).toBe("true");
});

test("焦点行：点行 / 方向键 / 右键都对外报告；initialFocus 挂载时选中并聚焦；行没了报告 null；current 换了焦点跟过去（初次挂载不抢 initialFocus）", () => {
  const onFocusChange = vi.fn();
  const { rerender } = show({
    initialFocus: "产品",
    current: "想法",
    onFocusChange,
  });
  expect(onFocusChange).toHaveBeenLastCalledWith("产品");
  expect(row("产品").getAttribute("aria-selected")).toBe("true");

  fireEvent.click(within(row("设计")).getByRole("button"));
  expect(onFocusChange).toHaveBeenLastCalledWith("设计");

  // 键盘：焦点在「设计」上按向上，回到「想法」
  fireEvent.keyDown(within(row("设计")).getByRole("button"), {
    key: "ArrowUp",
  });
  expect(onFocusChange).toHaveBeenLastCalledWith("想法");

  // 打开的东西换了：选中与焦点跟过去
  rerender(
    <Tree
      label="树"
      nodes={NODES}
      current="设计"
      onFocusChange={onFocusChange}
    />,
  );
  expect(onFocusChange).toHaveBeenLastCalledWith("设计");
  expect(row("设计").getAttribute("aria-selected")).toBe("true");

  // 焦点行被删掉
  rerender(
    <Tree
      label="树"
      nodes={NODES.filter((n) => n.id !== "设计")}
      current={null}
      onFocusChange={onFocusChange}
    />,
  );
  expect(onFocusChange).toHaveBeenLastCalledWith(null);
});
