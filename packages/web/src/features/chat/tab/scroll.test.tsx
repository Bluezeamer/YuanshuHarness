// 贴底跟随在两种「内容变高」下都要成立：
// 1) 有 signal 的流式追加（钉住后内容再长高，浏览器随后派发的 scroll 事件不能算成用户上滑）；
// 2) 没有 signal 的迟到布局（图片/svg 载入、代码块展开）——按子元素盒高变化补滚。
// jsdom 没有布局与 ResizeObserver，这里用假观察者手动触发回调。
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStickyScroll } from "./scroll";
import { mount, sizeScroll } from "./testkit";

interface Fake {
  cb: ResizeObserverCallback;
  targets: Set<Element>;
}

const observers: Fake[] = [];

class FakeRO {
  private entry: Fake;
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, targets: new Set() };
    observers.push(this.entry);
  }
  observe(target: Element) {
    this.entry.targets.add(target);
    this.entry.cb([], this as unknown as ResizeObserver);
  }
  unobserve(target: Element) {
    this.entry.targets.delete(target);
  }
  disconnect() {
    this.entry.targets.clear();
  }
}

function fireAll() {
  for (const o of observers) o.cb([], {} as ResizeObserver);
}

/** 只触发观察了该元素的回调（子元素长高 vs 容器尺寸变化） */
function fireOn(target: Element) {
  for (const o of observers)
    if (o.targets.has(target)) o.cb([], {} as ResizeObserver);
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeRO);
});

afterEach(() => {
  vi.unstubAllGlobals();
  observers.length = 0;
});

function Probe({ sent = 0 }: { sent?: number }) {
  const { ref, onScroll, away, toBottom } = useStickyScroll(
    "s",
    undefined,
    sent,
  );
  return (
    <>
      <div data-probe ref={ref} onScroll={onScroll}>
        <div data-msg />
      </div>
      {away && (
        <button type="button" onClick={toBottom}>
          回到底部
        </button>
      )}
    </>
  );
}

const probe = () => document.querySelector("[data-probe]") as HTMLElement;
const msg = () => document.querySelector("[data-msg]") as HTMLElement;

test("容器变矮（状态条展开）仍贴底：补滚到底，不出现「回到底部」", () => {
  render(<Probe />);
  const el = probe();
  const m = { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 };
  sizeScroll(el, m);
  fireEvent.scroll(el);
  m.clientHeight = 240;
  act(() => fireOn(el));
  expect(el.scrollTop).toBe(1000);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
});

test("上滑后容器尺寸来回变化都不抢回；仍放不下时保留「回到底部」", () => {
  render(<Probe />);
  const el = probe();
  const m = { scrollHeight: 1000, clientHeight: 400, scrollTop: 120 };
  sizeScroll(el, m);
  fireEvent.scroll(el);
  expect(screen.getByRole("button", { name: "回到底部" })).toBeTruthy();

  m.clientHeight = 240;
  act(() => fireAll());
  expect(el.scrollTop).toBe(120);

  m.clientHeight = 300;
  act(() => fireAll());
  expect(el.scrollTop).toBe(120);
  expect(screen.getByRole("button", { name: "回到底部" })).toBeTruthy();
});

test("容器变高后内容放得下：收回「回到底部」，但不主动滚动", () => {
  render(<Probe />);
  const el = probe();
  const m = { scrollHeight: 300, clientHeight: 100, scrollTop: 20 };
  sizeScroll(el, m);
  fireEvent.scroll(el);
  expect(screen.getByRole("button", { name: "回到底部" })).toBeTruthy();

  m.clientHeight = 260;
  act(() => fireAll());
  expect(el.scrollTop).toBe(20);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
});

test("钉到底后内容长高（流式追加）仍继续跟随，不算用户上滑", () => {
  render(<Probe />);
  const el = probe();
  const m = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
  sizeScroll(el, m);
  fireEvent.scroll(el);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();

  // 内容又长高，scrollTop 留在原处：浏览器随后才派发 scroll 事件
  m.scrollHeight = 2000;
  fireEvent.scroll(el);
  expect(el.scrollTop).toBe(2000);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
});

test("图片载入没有新 signal：子元素长高也补滚到底", () => {
  render(<Probe />);
  const el = probe();
  const m = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
  sizeScroll(el, m);
  fireEvent.scroll(el);

  m.scrollHeight = 1800;
  act(() => fireOn(msg()));
  expect(el.scrollTop).toBe(1800);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
});

test("图片载入时用户已上滑：不抢回，保留「回到底部」", () => {
  render(<Probe />);
  const el = probe();
  const m = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
  sizeScroll(el, m);
  fireEvent.scroll(el);

  el.scrollTop = 200;
  fireEvent.scroll(el);
  expect(screen.getByRole("button", { name: "回到底部" })).toBeTruthy();

  m.scrollHeight = 1800;
  act(() => fireOn(msg()));
  expect(el.scrollTop).toBe(200);
});

test("对话流被挤矮后仍贴底", () => {
  mount({ messages: [{ role: "user", text: "hi" }] });
  const el = screen.getByRole("log", { name: "对话记录" });
  const m = { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 };
  sizeScroll(el, m);
  fireEvent.scroll(el);

  m.clientHeight = 240;
  act(() => fireOn(el));
  expect(el.scrollTop).toBe(1000);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
});

test("发送：不管之前在哪，立即回到底部并恢复跟随", () => {
  const { rerender } = render(<Probe sent={0} />);
  const el = probe();
  const m = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
  sizeScroll(el, m);
  fireEvent.scroll(el);

  el.scrollTop = 300;
  fireEvent.scroll(el);
  expect(screen.getByRole("button", { name: "回到底部" })).toBeTruthy();

  rerender(<Probe sent={1} />);
  expect(el.scrollTop).toBe(2000);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();

  // 之后内容继续长高仍跟随
  m.scrollHeight = 2600;
  fireEvent.scroll(el);
  expect(el.scrollTop).toBe(2600);
});

test("发送次数没变（别的重渲染）：不动位置", () => {
  const { rerender } = render(<Probe sent={3} />);
  const el = probe();
  const m = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
  sizeScroll(el, m);
  fireEvent.scroll(el);
  el.scrollTop = 300;
  fireEvent.scroll(el);

  rerender(<Probe sent={3} />);
  expect(el.scrollTop).toBe(300);
});

test("输入框发送成功：对话流回到底部；发送失败不动", () => {
  const h = mount(
    { messages: [{ role: "user", text: "hi" }] },
    { draft: { text: "你好" } },
  );
  const el = screen.getByRole("log", { name: "对话记录" });
  const m = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
  sizeScroll(el, m);
  fireEvent.scroll(el);
  el.scrollTop = 300;
  fireEvent.scroll(el);
  expect(screen.getByRole("button", { name: "回到底部" })).toBeTruthy();

  const box = screen.getByRole("textbox", { name: /发消息/ });
  h.box.sendResult = { ok: false, message: "连接已断开" };
  fireEvent.keyDown(box, { key: "Enter" });
  expect(el.scrollTop).toBe(300);

  h.box.sendResult = { ok: true };
  fireEvent.keyDown(box, { key: "Enter" });
  expect(el.scrollTop).toBe(2000);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
});
