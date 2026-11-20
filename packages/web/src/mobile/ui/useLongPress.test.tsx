import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useLongPress } from "./useLongPress";

const onLong = vi.fn();
const onClick = vi.fn();

function Row() {
  const press = useLongPress(onLong);
  return (
    <div data-testid="row" {...press}>
      <button type="button" onClick={onClick}>
        行
      </button>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  onLong.mockClear();
  onClick.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const touch = (el: Element, x = 10, y = 10) =>
  fireEvent.pointerDown(el, { pointerType: "touch", clientX: x, clientY: y });

test("触屏按住 500 毫秒触发；随后那一下点击被吞掉，下一次点击照常", () => {
  const { getByTestId, getByText } = render(<Row />);
  touch(getByTestId("row"));
  act(() => vi.advanceTimersByTime(499));
  expect(onLong).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(onLong).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(getByTestId("row"));
  fireEvent.click(getByText("行"));
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.click(getByText("行"));
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("没按够就抬起、或手指移出 8 像素（要滚动了）都取消；鼠标不触发", () => {
  const { getByTestId } = render(<Row />);
  touch(getByTestId("row"));
  act(() => vi.advanceTimersByTime(300));
  fireEvent.pointerUp(getByTestId("row"));
  act(() => vi.advanceTimersByTime(500));
  expect(onLong).not.toHaveBeenCalled();

  touch(getByTestId("row"), 10, 10);
  fireEvent.pointerMove(getByTestId("row"), { clientX: 10, clientY: 30 });
  act(() => vi.advanceTimersByTime(600));
  expect(onLong).not.toHaveBeenCalled();

  fireEvent.pointerDown(getByTestId("row"), { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(600));
  expect(onLong).not.toHaveBeenCalled();
});

test("长按触发后抬手的 touchend 被取消默认行为（不再补发鼠标事件，抽屉遮罩不会被误点）；没触发时不动", () => {
  const { getByTestId } = render(<Row />);
  const row = getByTestId("row");
  touch(row);
  act(() => vi.advanceTimersByTime(500));
  expect(fireEvent.touchEnd(row)).toBe(false);
  touch(row);
  expect(fireEvent.touchEnd(row)).toBe(true);
});

test("长按时系统自己的菜单被挡掉", () => {
  const { getByTestId } = render(<Row />);
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  getByTestId("row").dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
});
