import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HoverCard, PeekCard } from "./HoverCard";
import { ListRow } from "./ListRow";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const card = () => screen.queryByRole("tooltip");

function Row() {
  return (
    <HoverCard card={<PeekCard title="详情" text="全文" />}>
      <button type="button">行</button>
    </HoverCard>
  );
}

test("悬停停留约 450ms 才出现；离开就收起，卡片不接鼠标事件", () => {
  render(<Row />);
  const row = screen.getByRole("button", { name: "行" })
    .parentElement as HTMLElement;
  fireEvent.pointerEnter(row);
  wait(300);
  expect(card()).toBeNull();
  wait(200);
  expect(card()?.textContent).toContain("全文");
  expect(row.getAttribute("aria-describedby")).toBe(card()?.id);
  fireEvent.pointerLeave(row);
  expect(card()).toBeNull();
});

test("刚收起一张卡片后，另一行立即出现，不再等延迟", () => {
  render(
    <>
      <Row />
      <ListRow label="第二行" peek={<PeekCard title="第二张" />} />
    </>,
  );
  const first = screen.getByRole("button", { name: "行" })
    .parentElement as HTMLElement;
  fireEvent.pointerEnter(first);
  wait(500);
  expect(card()).not.toBeNull();
  fireEvent.pointerLeave(first);
  const second = screen
    .getByRole("button", { name: "第二行" })
    .closest(".u-hc") as HTMLElement;
  fireEvent.pointerEnter(second);
  wait(0);
  expect(card()?.textContent).toContain("第二张");
});

test("键盘聚焦出现，Esc 收起；失焦收起", () => {
  render(<Row />);
  const row = screen.getByRole("button", { name: "行" });
  fireEvent.focus(row);
  wait(500);
  expect(card()).not.toBeNull();
  fireEvent.keyDown(row, { key: "Escape" });
  expect(card()).toBeNull();
  fireEvent.focus(row);
  wait(500);
  fireEvent.blur(row);
  expect(card()).toBeNull();
});

test("按下（点行、点「⋯」）后卡片收起，直到指针离开前不再弹", () => {
  render(<Row />);
  const row = screen.getByRole("button", { name: "行" })
    .parentElement as HTMLElement;
  fireEvent.pointerEnter(row);
  wait(500);
  fireEvent.pointerDown(row);
  expect(card()).toBeNull();
  fireEvent.pointerEnter(row);
  wait(500);
  expect(card()).toBeNull();
  fireEvent.pointerLeave(row);
  fireEvent.pointerEnter(row);
  wait(500);
  expect(card()).not.toBeNull();
});

test("还没到时间就离开：不会弹；卸载后不留定时器", () => {
  const { unmount } = render(<Row />);
  const row = screen.getByRole("button", { name: "行" })
    .parentElement as HTMLElement;
  fireEvent.pointerEnter(row);
  wait(200);
  fireEvent.pointerLeave(row);
  wait(500);
  expect(card()).toBeNull();
  fireEvent.pointerEnter(row);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("ListRow 不传 peek 时不包一层，也没有卡片", () => {
  const { container } = render(<ListRow label="单行" />);
  expect(container.querySelector(".u-hc")).toBeNull();
});
