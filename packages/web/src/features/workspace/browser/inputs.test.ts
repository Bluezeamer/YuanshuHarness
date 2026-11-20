import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, createRef, type RefObject, useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  keyOf,
  mouseOf,
  staleModifiers,
  toPagePoint,
  useInputCapture,
  VIEWPORT,
  wheelOf,
} from "./inputs";

// 画面按 640×400 显示（正好一半），坐标换算才有区分度。
const rect = { left: 100, top: 50, width: 640, height: 400 };

const mouse = (over: Record<string, unknown> = {}) => ({
  clientX: 420,
  clientY: 250,
  button: 0,
  detail: 1,
  ...over,
});

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("画面尺寸与服务端一致", () => {
  expect(VIEWPORT).toEqual({ width: 1280, height: 800 });
});

test("toPagePoint：等比缩放到 1280×800；元素外与零尺寸给 null", () => {
  // 元素正中 → 画面正中
  expect(toPagePoint(420, 250, rect)).toEqual({ x: 640, y: 400 });
  // 左上角
  expect(toPagePoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
  // 右下边缘之外
  expect(toPagePoint(740, 250, rect)).toBeNull();
  expect(toPagePoint(420, 450, rect)).toBeNull();
  expect(toPagePoint(99, 250, rect)).toBeNull();
  // 元素还没布局
  expect(toPagePoint(420, 250, { ...rect, width: 0 })).toBeNull();
});

test("mouseOf：move 不带按键与点击次数；down/up 带；点击次数夹在 1–3", () => {
  expect(mouseOf("move", mouse(), rect)).toEqual({
    type: "mouse",
    action: "move",
    x: 640,
    y: 400,
  });
  expect(mouseOf("down", mouse({ button: 2, detail: 7 }), rect)).toEqual({
    type: "mouse",
    action: "down",
    x: 640,
    y: 400,
    button: "right",
    clickCount: 3,
  });
  expect(mouseOf("up", mouse({ button: 1, detail: 0 }), rect)).toEqual({
    type: "mouse",
    action: "up",
    x: 640,
    y: 400,
    button: "middle",
    clickCount: 1,
  });
  // 元素外不发
  expect(mouseOf("down", mouse({ clientX: 1000 }), rect)).toBeNull();
});

test("wheelOf：deltaMode 换算成像素，夹到 ±10000", () => {
  const at = (deltaY: number, deltaMode: number) => ({
    clientX: 420,
    clientY: 250,
    deltaX: 0,
    deltaY,
    deltaMode,
  });
  const deltaY = (ev: unknown) => (ev as { deltaY: number }).deltaY;
  expect(wheelOf(at(3, 0), rect)).toEqual({
    type: "wheel",
    x: 640,
    y: 400,
    deltaX: 0,
    deltaY: 3,
  });
  // 行 ×16
  expect(deltaY(wheelOf(at(2, 1), rect))).toBe(32);
  // 页 ×800
  expect(deltaY(wheelOf(at(1, 2), rect))).toBe(800);
  // 超上限夹住，否则服务端整条拒绝
  expect(deltaY(wheelOf(at(999_999, 0), rect))).toBe(10_000);
  expect(deltaY(wheelOf(at(-999_999, 0), rect))).toBe(-10_000);
  const deltaX = (ev: unknown) => (ev as { deltaX: number }).deltaX;
  const sideways = (x: number) => ({ ...at(0, 0), deltaX: x });
  expect(deltaX(wheelOf(sideways(999_999), rect))).toBe(10_000);
  expect(deltaX(wheelOf(sideways(-999_999), rect))).toBe(-10_000);
  expect(wheelOf({ ...at(0, 0), clientX: 0 }, rect)).toBeNull();
});

test("keyOf：组词期间、Ctrl/Meta 组合、超长键名不发；其余原样", () => {
  const key = (over: Record<string, unknown> = {}) => ({
    key: "a",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...over,
  });
  expect(keyOf("down", key())).toEqual({
    type: "key",
    action: "down",
    key: "a",
  });
  expect(keyOf("up", key({ key: " " }))).toEqual({
    type: "key",
    action: "up",
    key: " ",
  });
  // 输入法组词中
  expect(keyOf("down", key({ isComposing: true }))).toBeNull();
  expect(keyOf("down", key({ key: "Process" }))).toBeNull();
  // 组合键留在本地
  expect(keyOf("down", key({ ctrlKey: true }))).toBeNull();
  expect(keyOf("down", key({ metaKey: true }))).toBeNull();
  // Alt 照发
  expect(keyOf("down", key({ altKey: true }))).not.toBeNull();
  // 超过 32 个字符
  expect(keyOf("down", key({ key: "x".repeat(33) }))).toBeNull();
  expect(keyOf("down", key({ key: "x".repeat(32) }))).not.toBeNull();
});

/** 挂上输入捕获：容器是 640×400，放在 (100,50)；sink 是输入法的落脚点（容器里的 textarea）。 */
function capture(enabled = true) {
  const send = vi.fn();
  const ref = createRef<HTMLDivElement>();
  const view = render(createElement(Capture, { ref, enabled, send }));
  const el = ref.current as HTMLDivElement;
  const sink = el.querySelector("textarea") as HTMLTextAreaElement;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect);
  return { send, el, view, sink };
}

// 最小容器：hook 只认容器、sink 与 enabled。
function Capture(props: {
  ref: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  send: (ev: unknown) => void;
  copy?: () => void;
}) {
  const { ref, enabled, send, copy = () => {} } = props;
  const sink = useRef<HTMLTextAreaElement>(null);
  useInputCapture(ref, enabled, send as never, sink, copy);
  return createElement(
    "div",
    { ref, tabIndex: 0 },
    createElement("textarea", { ref: sink }),
  );
}

test("mousemove 合并到每帧一条：只发最后一次位置", () => {
  const rafCbs: Array<() => void> = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCbs.push(() => cb(0));
    return rafCbs.length;
  });
  const { send, el } = capture();
  fireEvent.mouseMove(el, mouse({ clientX: 200 }));
  fireEvent.mouseMove(el, mouse({ clientX: 300 }));
  fireEvent.mouseMove(el, mouse({ clientX: 420 }));
  expect(rafCbs).toHaveLength(1);
  expect(send).not.toHaveBeenCalled();
  for (const cb of rafCbs) cb();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toMatchObject({ action: "move", x: 640 });
});

test("mousedown 到来前先把没发的 move 立刻发掉，并让输入法的落脚点获得焦点", () => {
  const rafCbs: Array<() => void> = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCbs.push(() => cb(0));
    return rafCbs.length;
  });
  const { send, el, sink } = capture();
  fireEvent.mouseMove(el, mouse({ clientX: 200 }));
  fireEvent.mouseDown(el, mouse({ clientX: 420 }));
  expect(send.mock.calls.map((c) => c[0])).toEqual([
    { type: "mouse", action: "move", x: 200, y: 400 },
    {
      type: "mouse",
      action: "down",
      x: 640,
      y: 400,
      button: "left",
      clickCount: 1,
    },
  ]);
  expect(document.activeElement).toBe(sink);
  // 已冲掉的 move 不会再发一遍
  for (const cb of rafCbs) cb();
  expect(send).toHaveBeenCalledTimes(2);
});

test("mouseup 到来前也先把没发的 move 发掉", () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const { send, el } = capture();
  fireEvent.mouseMove(el, mouse({ clientX: 200 }));
  fireEvent.mouseUp(el, mouse({ clientX: 420 }));
  expect(
    send.mock.calls.map((c) => (c[0] as { action: string }).action),
  ).toEqual(["move", "up"]);
});

test("mouseup 挂在 window 上：拖出元素外松开也发 up，坐标夹进画面", () => {
  const { send, el } = capture();
  fireEvent.mouseUp(window, mouse({ clientX: 5000, clientY: 5000 }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toEqual({
    type: "mouse",
    action: "up",
    x: 1279,
    y: 799,
    button: "left",
    clickCount: 1,
  });
  send.mockClear();
  // 元素自己收到也在 window 上冒泡，只发一条
  fireEvent.mouseUp(el, mouse());
  expect(send).toHaveBeenCalledTimes(1);
});

test("wheel 被 preventDefault 后发出换算过的位移", () => {
  const { send, el } = capture();
  const ev = new WheelEvent("wheel", {
    clientX: 420,
    clientY: 250,
    deltaY: 2,
    deltaMode: 1,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
  expect(send.mock.calls[0]?.[0]).toMatchObject({ type: "wheel", deltaY: 32 });
});

test("右键不弹浏览器菜单", () => {
  const { el } = capture();
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
});

test("键盘：可发的键 preventDefault 后发出；组词与组合键不发也不拦", () => {
  const { send, el } = capture();
  const a = new KeyboardEvent("keydown", {
    key: "a",
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(a);
  expect(a.defaultPrevented).toBe(true);
  expect(send.mock.calls[0]?.[0]).toEqual({
    type: "key",
    action: "down",
    key: "a",
  });
  send.mockClear();
  const copy = new KeyboardEvent("keydown", {
    key: "c",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(copy);
  expect(copy.defaultPrevented).toBe(false);
  expect(send).not.toHaveBeenCalled();
});

test("点击把落脚点摆到鼠标位置（输入法的候选框跟着它），并阻止默认的挪焦点", () => {
  const { sink, el } = capture();
  const ev = new MouseEvent("mousedown", {
    clientX: 420,
    clientY: 250,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
  // 容器在 (100,50)
  expect(sink.style.left).toBe("320px");
  expect(sink.style.top).toBe("200px");
});

test("用键盘走到容器上：焦点交给落脚点", () => {
  const { sink, el } = capture();
  el.focus();
  expect(document.activeElement).toBe(sink);
});

test("compositionend 发整段文字，并清空落脚点", () => {
  const { send, sink } = capture();
  sink.value = "你好";
  sink.dispatchEvent(
    new CompositionEvent("compositionend", { data: "你好", bubbles: true }),
  );
  expect(send.mock.calls[0]?.[0]).toEqual({ type: "text", text: "你好" });
  expect(sink.value).toBe("");
  send.mockClear();
  sink.dispatchEvent(
    new CompositionEvent("compositionend", { data: "", bubbles: true }),
  );
  expect(send).not.toHaveBeenCalled();
});

// 输入法直接上屏的字（全角标点之类）没有组词过程，字从 input 事件来
const inputEvent = (over: Record<string, unknown>) =>
  new InputEvent("input", { bubbles: true, ...over });

test("没有组词的直接上屏：insertText 发出去并清空落脚点", () => {
  const { send, sink } = capture();
  sink.value = "，";
  sink.dispatchEvent(inputEvent({ inputType: "insertText", data: "，" }));
  expect(send.mock.calls[0]?.[0]).toEqual({ type: "text", text: "，" });
  expect(sink.value).toBe("");
});

test("组词过程中的 input 不动落脚点的内容（改了值会打断输入法）；组词外的会清", () => {
  const { sink } = capture();
  sink.value = "ni";
  sink.dispatchEvent(
    inputEvent({
      inputType: "insertCompositionText",
      data: "ni",
      isComposing: true,
    }),
  );
  expect(sink.value).toBe("ni");
  sink.dispatchEvent(
    inputEvent({ inputType: "insertFromComposition", data: "你" }),
  );
  expect(sink.value).toBe("");
});

test("组词过程中的 input 不发（等 compositionend），其它 inputType 也不发", () => {
  const { send, sink } = capture();
  sink.dispatchEvent(
    inputEvent({
      inputType: "insertCompositionText",
      data: "ni",
      isComposing: true,
    }),
  );
  sink.dispatchEvent(
    inputEvent({ inputType: "insertText", data: "x", isComposing: true }),
  );
  sink.dispatchEvent(
    inputEvent({ inputType: "insertFromComposition", data: "你" }),
  );
  sink.dispatchEvent(inputEvent({ inputType: "insertText", data: null }));
  expect(send).not.toHaveBeenCalled();
});

test("paste 发 text/plain 并截到 4000 个字符", () => {
  const { send, el } = capture();
  fireEvent.paste(el, { clipboardData: { getData: () => "粘贴的文字" } });
  expect(send.mock.calls[0]?.[0]).toEqual({ type: "text", text: "粘贴的文字" });
  send.mockClear();
  fireEvent.paste(el, { clipboardData: { getData: () => "字".repeat(4200) } });
  const pasted = send.mock.calls[0]?.[0] as { text: string };
  expect([...pasted.text]).toHaveLength(4000);
  send.mockClear();
  fireEvent.paste(el, { clipboardData: { getData: () => "" } });
  expect(send).not.toHaveBeenCalled();
  // 默认粘贴不能落到本地页面上
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { getData: () => "x" } });
  el.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
});

test("copy：在 sink 上按复制键时请页面给出选中的文字，本地不复制，也不走 send", () => {
  const send = vi.fn();
  const copy = vi.fn();
  const ref = createRef<HTMLDivElement>();
  render(createElement(Capture, { ref, enabled: true, send, copy }));
  const sink = (ref.current as HTMLDivElement).querySelector(
    "textarea",
  ) as HTMLTextAreaElement;
  const ev = new Event("copy", { bubbles: true, cancelable: true });
  sink.dispatchEvent(ev);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(ev.defaultPrevented).toBe(true);
  expect(send).not.toHaveBeenCalled();
});

test("copy：enabled 变假后摘掉监听（交还 agent 后复制键恢复本地默认）", () => {
  const send = vi.fn();
  const copy = vi.fn();
  const ref = createRef<HTMLDivElement>();
  const view = render(
    createElement(Capture, { ref, enabled: true, send, copy }),
  );
  view.rerender(createElement(Capture, { ref, enabled: false, send, copy }));
  const sink = (ref.current as HTMLDivElement).querySelector(
    "textarea",
  ) as HTMLTextAreaElement;
  const ev = new Event("copy", { bubbles: true, cancelable: true });
  sink.dispatchEvent(ev);
  expect(copy).not.toHaveBeenCalled();
  expect(ev.defaultPrevented).toBe(false);
});

test("copy：没挂输入捕获（观察态）时不拦、也不请页面", () => {
  const send = vi.fn();
  const copy = vi.fn();
  const ref = createRef<HTMLDivElement>();
  render(createElement(Capture, { ref, enabled: false, send, copy }));
  const sink = (ref.current as HTMLDivElement).querySelector(
    "textarea",
  ) as HTMLTextAreaElement;
  const ev = new Event("copy", { bubbles: true, cancelable: true });
  sink.dispatchEvent(ev);
  expect(copy).not.toHaveBeenCalled();
  expect(ev.defaultPrevented).toBe(false);
});

test("enabled 变假后摘掉监听，不再发", () => {
  const { send, el, view } = capture();
  fireEvent.mouseUp(window, mouse());
  expect(send).toHaveBeenCalledTimes(1);
  send.mockClear();
  view.rerender(
    createElement(Capture, { ref: { current: el }, enabled: false, send }),
  );
  fireEvent.mouseUp(window, mouse());
  fireEvent.mouseDown(el, mouse());
  fireEvent.wheel(el, { deltaY: 1 });
  expect(send).not.toHaveBeenCalled();
});

test("调用方每次渲染传新 send 也不会重挂监听", () => {
  const ref = createRef<HTMLDivElement>();
  const first = vi.fn();
  const second = vi.fn();
  const { rerender } = render(
    createElement(Capture, { ref, enabled: true, send: first }),
  );
  const el = ref.current as HTMLDivElement;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect);
  rerender(createElement(Capture, { ref, enabled: true, send: second }));
  fireEvent.mouseUp(window, mouse());
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

describe("修饰键对账：丢了 keyup 不能让 Server 的键盘一直按着 Alt", () => {
  test("staleModifiers：本地已松开的才算过期", () => {
    const up = { shiftKey: false, altKey: false };
    expect(staleModifiers(new Set(), up)).toEqual([]);
    expect(staleModifiers(new Set(["Alt"]), up)).toEqual(["Alt"]);
    expect(staleModifiers(new Set(["Alt", "Shift"]), up)).toEqual([
      "Alt",
      "Shift",
    ]);
    expect(
      staleModifiers(new Set(["Alt", "Shift"]), {
        shiftKey: true,
        altKey: false,
      }),
    ).toEqual(["Alt"]);
    expect(
      staleModifiers(new Set(["Alt", "Shift"]), {
        shiftKey: true,
        altKey: true,
      }),
    ).toEqual([]);
  });

  const key = (type: string, k: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent(type, {
      key: k,
      bubbles: true,
      cancelable: true,
      ...init,
    });

  test("按住 Alt 时点击不补发；Alt 的 keyup 丢了，之后的点击前先补发 up", () => {
    const { send, el } = capture();
    el.dispatchEvent(key("keydown", "Alt", { altKey: true }));
    send.mockClear();
    // 仍按着：mousedown 带着 altKey，不补发
    fireEvent.mouseDown(el, mouse({ clientX: 420, altKey: true }));
    expect(send.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(
      ["mouse"],
    );
    send.mockClear();
    // keyup 丢了（Alt+Tab）：回来后的 mousedown 不带 altKey，先补发 Alt 的 up，再发点击
    fireEvent.mouseDown(el, mouse({ clientX: 420 }));
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: "key", action: "up", key: "Alt" },
      expect.objectContaining({ type: "mouse", action: "down" }),
    ]);
    // 只补一次
    send.mockClear();
    fireEvent.mouseDown(el, mouse({ clientX: 420 }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("正常按下又松开：up 只发一次，之后的点击不再补发", () => {
    const { send, el } = capture();
    el.dispatchEvent(key("keydown", "Shift", { shiftKey: true }));
    el.dispatchEvent(key("keyup", "Shift"));
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: "key", action: "down", key: "Shift" },
      { type: "key", action: "up", key: "Shift" },
    ]);
    send.mockClear();
    fireEvent.mouseDown(el, mouse({ clientX: 420 }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("键盘与滚轮、移动、松开同样对账", () => {
    for (const fire of [
      (el: HTMLElement) => el.dispatchEvent(key("keydown", "a")),
      (el: HTMLElement) =>
        fireEvent.wheel(el, { clientX: 420, clientY: 400, deltaY: 10 }),
      (el: HTMLElement) => fireEvent.mouseMove(el, mouse({ clientX: 420 })),
      (el: HTMLElement) => fireEvent.mouseUp(el, mouse({ clientX: 420 })),
    ]) {
      const { send, el } = capture();
      el.dispatchEvent(key("keydown", "Alt", { altKey: true }));
      send.mockClear();
      fire(el);
      expect(send.mock.calls[0]?.[0]).toEqual({
        type: "key",
        action: "up",
        key: "Alt",
      });
      cleanup();
    }
  });
});
