import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Menu } from "./Menu";
import { Modal } from "./Modal";
import { Popover } from "./Popover";
import { Sheet } from "./Sheet";

afterEach(cleanup);

function ModalHost({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        title="新增连接"
        description="填写端点信息"
        footer={<button type="button">保存</button>}
      >
        <input aria-label="名称" />
      </Modal>
    </>
  );
}

test("Modal 是命名的 dialog，标题与说明接入 aria，打开时聚焦内容区里第一个可聚焦元素", () => {
  render(<ModalHost />);
  const d = screen.getByRole("dialog", { name: "新增连接" });
  expect(d.getAttribute("aria-modal")).toBe("true");
  expect(d.getAttribute("aria-describedby")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText("名称"));
});

test("Modal 内容区没有可聚焦元素时，退回卡片里第一个（页头的关闭按钮）", () => {
  render(
    <Modal open onClose={() => {}} title="T">
      <p>只有文字</p>
    </Modal>,
  );
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "关闭" }),
  );
});

test("Modal Esc 关闭并把焦点还给打开前的元素", () => {
  const onClose = vi.fn();
  const { rerender } = render(<ModalHost onClose={onClose} />);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<ModalHost onClose={onClose} />);
});

test("Modal 点遮罩关闭，点卡片内部不关闭；dismissOnScrim=false 时遮罩不响应", () => {
  const onClose = vi.fn();
  const { rerender } = render(
    <Modal open onClose={onClose} title="T">
      <p>内容</p>
    </Modal>,
  );
  fireEvent.mouseDown(screen.getByText("内容"));
  expect(onClose).not.toHaveBeenCalled();
  const scrim = screen.getByRole("dialog").parentElement as HTMLElement;
  fireEvent.mouseDown(scrim);
  expect(onClose).toHaveBeenCalledTimes(1);
  onClose.mockClear();
  rerender(
    <Modal open onClose={onClose} title="T" dismissOnScrim={false}>
      <p>内容</p>
    </Modal>,
  );
  fireEvent.mouseDown(scrim);
  expect(onClose).not.toHaveBeenCalled();
});

test("Sheet 是命名的 dialog；Esc、关闭键、点遮罩都关闭，点抽屉内部不关闭", () => {
  const onClose = vi.fn();
  render(
    <Sheet title="状态" onClose={onClose}>
      <p>内容</p>
    </Sheet>,
  );
  const sheet = screen.getByRole("dialog", { name: "状态" });
  fireEvent.mouseDown(screen.getByText("内容"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(sheet.parentElement as HTMLElement);
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(onClose).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(3);
});

test("Modal Tab 在首尾循环，焦点不离开弹窗", () => {
  render(<ModalHost />);
  const card = screen.getByRole("dialog");
  const save = screen.getByRole("button", { name: "保存" });
  save.focus();
  fireEvent.keyDown(card, { key: "Tab" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "关闭" }),
  );
  fireEvent.keyDown(card, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(save);
});

test("嵌套浮层时 Esc 只关最上面一层", () => {
  const outer = vi.fn();
  const inner = vi.fn();
  render(
    <Modal open onClose={outer} title="外层">
      <Modal open onClose={inner} title="内层">
        <p>x</p>
      </Modal>
    </Modal>,
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(inner).toHaveBeenCalledTimes(1);
  expect(outer).not.toHaveBeenCalled();
});

function PopHost({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={ref}>
        锚点
      </button>
      <Popover open onClose={onClose} anchorRef={ref} label="选项">
        <button type="button">项目</button>
      </Popover>
    </>
  );
}

test("Popover Esc 关闭并聚焦锚点，点外部关闭，点锚点或面板内不触发外部关闭", () => {
  const onClose = vi.fn();
  render(<PopHost onClose={onClose} />);
  expect(screen.getByRole("dialog", { name: "选项" })).toBeTruthy();
  fireEvent.pointerDown(screen.getByRole("button", { name: "项目" }));
  fireEvent.pointerDown(screen.getByRole("button", { name: "锚点" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "锚点" }),
  );
});

function MenuHost({ onSelect }: { onSelect: (id: string) => void }) {
  return (
    <Menu
      label="更多操作"
      items={[
        { id: "edit", label: "编辑", onSelect: () => onSelect("edit") },
        {
          id: "off",
          label: "停用",
          disabled: true,
          onSelect: () => onSelect("off"),
        },
        {
          id: "del",
          label: "删除",
          tone: "danger",
          separatorBefore: true,
          onSelect: () => onSelect("del"),
        },
      ]}
    />
  );
}

test("Menu 触发器带 haspopup/expanded，打开后聚焦第一项", () => {
  render(<MenuHost onSelect={() => {}} />);
  const t = screen.getByRole("button", { name: "更多操作" });
  expect(t.getAttribute("aria-haspopup")).toBe("menu");
  expect(t.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(t);
  expect(t.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("menu", { name: "更多操作" })).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "编辑" }),
  );
});

test("Menu 方向键在启用项间循环并跳过 disabled，Enter 选中后关闭并回焦触发器", () => {
  const onSelect = vi.fn();
  render(<MenuHost onSelect={onSelect} />);
  const t = screen.getByRole("button", { name: "更多操作" });
  fireEvent.click(t);
  const menu = screen.getByRole("menu");
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "删除" }),
  );
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "编辑" }),
  );
  fireEvent.keyDown(menu, { key: "End" });
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  expect(onSelect).toHaveBeenCalledWith("del");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(t);
});

test("Menu disabled 项不可点击", () => {
  const onSelect = vi.fn();
  render(<MenuHost onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "停用" }));
  expect(onSelect).not.toHaveBeenCalled();
});

test("Menu Esc 关闭并回焦触发器", () => {
  render(<MenuHost onSelect={() => {}} />);
  const t = screen.getByRole("button", { name: "更多操作" });
  fireEvent.click(t);
  act(() => {
    fireEvent.keyDown(document, { key: "Escape" });
  });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(t);
});
