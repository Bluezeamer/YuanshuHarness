// 把浏览器的 DOM 事件换成服务端认识的 InputEvent：画面固定 1280×800，前端按显示尺寸等比缩放。
// 只在「手动操作」时挂监听（useInputCapture），旁观时一个事件都不发。
import { type RefObject, useEffect, useRef } from "react";
import type { InputEvent } from "../../../api/browser";

// 本文件的 InputEvent 是服务端认的输入事件，DOM 的同名事件用别名
type InputEvent_ = globalThis.InputEvent;

/** 与服务端 browser/engine/types.ts 一致 */
export const VIEWPORT = { width: 1280, height: 800 } as const;

const WHEEL_MAX = 10_000;
const KEY_MAX = 32;
const TEXT_MAX = 4000;

// deltaMode：0 像素、1 行、2 页；行高 16、页高 800。
const LINE_HEIGHT = 16;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** client 坐标 → 页面坐标（可能落在画面外，由调用方判断）。 */
function scalePoint(clientX: number, clientY: number, rect: Rect) {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * VIEWPORT.width,
    y: ((clientY - rect.top) / rect.height) * VIEWPORT.height,
  };
}

/** 元素上的 client 坐标 → 页面坐标（等比缩放到 1280×800）；落在元素外或元素尺寸为 0 → null。 */
export function toPagePoint(
  clientX: number,
  clientY: number,
  rect: Rect,
): { x: number; y: number } | null {
  const p = scalePoint(clientX, clientY, rect);
  if (!p) return null;
  const inside =
    p.x >= 0 && p.y >= 0 && p.x < VIEWPORT.width && p.y < VIEWPORT.height;
  return inside ? p : null;
}

const buttonOf = (button: number): "left" | "middle" | "right" | null =>
  button === 0
    ? "left"
    : button === 1
      ? "middle"
      : button === 2
        ? "right"
        : null;

// 服务端只收 1–3 的整数次点击。
const clickCountOf = (detail: number) => clamp(detail, 1, 3);

interface MouseLike {
  clientX: number;
  clientY: number;
  button: number;
  detail: number;
}

function mouseAt(
  action: "move" | "down" | "up",
  p: { x: number; y: number },
  e: MouseLike,
): InputEvent | null {
  if (action === "move") return { type: "mouse", action, x: p.x, y: p.y };
  const button = buttonOf(e.button);
  if (button === null) return null;
  return {
    type: "mouse",
    action,
    x: p.x,
    y: p.y,
    button,
    clickCount: clickCountOf(e.detail),
  };
}

export function mouseOf(
  action: "move" | "down" | "up",
  e: MouseLike,
  rect: Rect,
): InputEvent | null {
  const p = toPagePoint(e.clientX, e.clientY, rect);
  return p ? mouseAt(action, p, e) : null;
}

/** 拖到元素外松开也要发 up：坐标夹进画面范围，而不是丢掉。 */
function mouseUpClamped(e: MouseLike, rect: Rect): InputEvent | null {
  const p = scalePoint(e.clientX, e.clientY, rect);
  if (!p) return null;
  return mouseAt(
    "up",
    {
      x: clamp(p.x, 0, VIEWPORT.width - 1),
      y: clamp(p.y, 0, VIEWPORT.height - 1),
    },
    e,
  );
}

export function wheelOf(
  e: {
    clientX: number;
    clientY: number;
    deltaX: number;
    deltaY: number;
    deltaMode: number;
  },
  rect: Rect,
): InputEvent | null {
  const p = toPagePoint(e.clientX, e.clientY, rect);
  if (!p) return null;
  const unit =
    e.deltaMode === 1 ? LINE_HEIGHT : e.deltaMode === 2 ? VIEWPORT.height : 1;
  return {
    type: "wheel",
    x: p.x,
    y: p.y,
    // 服务端上限是 ±10000，超了会被整条拒绝，所以在这里夹住
    deltaX: clamp(e.deltaX * unit, -WHEEL_MAX, WHEEL_MAX),
    deltaY: clamp(e.deltaY * unit, -WHEEL_MAX, WHEEL_MAX),
  };
}

/** 键盘：返回要发的 key 事件；不发的（输入法组词中、Ctrl/Meta 组合、超长键名）返回 null。 */
export function keyOf(
  action: "down" | "up",
  e: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    isComposing: boolean;
  },
): InputEvent | null {
  // 输入法组词期间 DOM 的 key 是 "Process"，等 compositionend 整段插入
  if (e.isComposing || e.key === "Process") return null;
  // 快捷键留在本地（粘贴走 paste 事件），不转发给页面
  if (e.ctrlKey || e.metaKey) return null;
  if ([...e.key].length > KEY_MAX) return null;
  return { type: "key", action, key: e.key };
}

/**
 * 本地按着的 Shift / Alt 里，其实已经松开的：Server 端 Playwright 的键盘是有状态的，Alt 按下后一直算按着，
 * 之后的点击就成了 Alt+点击（Chromium 里是「下载链接」）。keyup 常常丢（Alt+Tab、输入法切换让焦点离开），
 * 所以每个自带修饰键状态的事件都对一次账，没松的才算按着。
 */
export function staleModifiers(
  held: ReadonlySet<string>,
  e: { shiftKey: boolean; altKey: boolean },
): string[] {
  return [...held].filter((k) => (k === "Shift" ? !e.shiftKey : !e.altKey));
}

// 每一帧最多发一条 move；没有 requestAnimationFrame（老环境 / 测试）时退回定时器。
const raf = (cb: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number);

const cancelRaf = (id: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id);
};

/**
 * 手动操作时的输入捕获：给容器挂鼠标 / 滚轮 / 键盘 / 输入法 / 粘贴监听，换成 InputEvent 发出去。
 * 输入法只对可编辑元素生效（焦点在普通 div 上，拼音会被当成一个个英文字母），所以键盘焦点交给 sink：
 * 一个看不见的 textarea，点击时摆到鼠标位置（输入法的候选框跟着它），组词结果从它那里取走再清空。
 * 复制：选区在服务端的页面里，本地的 sink 是空的，按复制键只能请 Server 取选中的文字（copy），写剪贴板由调用方做。
 * send / copy 走 ref，调用方每次渲染传新函数也不会重挂监听。
 */
export function useInputCapture(
  el: RefObject<HTMLElement | null>,
  enabled: boolean,
  send: (ev: InputEvent) => void,
  sink: RefObject<HTMLTextAreaElement | null>,
  copy: () => void,
): void {
  const sendRef = useRef(send);
  sendRef.current = send;
  const copyRef = useRef(copy);
  copyRef.current = copy;
  // 已转发 down、还没转发 up 的 Shift / Alt；跨 enabled 切换保留，Server 那边的键盘状态也不会因此清掉。
  const held = useRef(new Set<string>());

  useEffect(() => {
    const node = el.current;
    if (!enabled || !node) return;

    const rect = () => node.getBoundingClientRect();
    // 本地已松开的修饰键补发 up（见 staleModifiers）。
    const reconcile = (e: { shiftKey: boolean; altKey: boolean }) => {
      for (const key of staleModifiers(held.current, e)) {
        held.current.delete(key);
        sendRef.current({ type: "key", action: "up", key });
      }
    };
    let frame: number | null = null;
    let pending: { clientX: number; clientY: number } | null = null;

    // mousemove 只保留最后一次位置：指针事件的频率远高于画面帧率。
    const flushMove = () => {
      if (frame !== null) {
        cancelRaf(frame);
        frame = null;
      }
      const at = pending;
      pending = null;
      if (!at) return;
      const ev = mouseOf("move", { ...at, button: 0, detail: 0 }, rect());
      if (ev) sendRef.current(ev);
    };

    const onMove = (e: MouseEvent) => {
      reconcile(e);
      pending = { clientX: e.clientX, clientY: e.clientY };
      if (frame !== null) return;
      frame = raf(() => {
        frame = null;
        flushMove();
      });
    };

    // 点击与松开前先把没发的 move 冲掉，顺序才是「移过去 → 按下」。
    const onDown = (e: MouseEvent) => {
      reconcile(e);
      flushMove();
      const box = rect();
      const input = sink.current;
      if (input) {
        input.style.left = `${e.clientX - box.left}px`;
        input.style.top = `${e.clientY - box.top}px`;
        // 默认的点击会把焦点挪到容器上，这里自己定
        e.preventDefault();
        input.focus({ preventScroll: true });
      }
      const ev = mouseOf("down", e, box);
      if (ev) sendRef.current(ev);
    };

    // 用键盘（Tab）走到画面上时也把焦点交给 sink
    const onFocus = () => sink.current?.focus({ preventScroll: true });

    const onUp = (e: MouseEvent) => {
      reconcile(e);
      flushMove();
      const ev = mouseUpClamped(e, rect());
      if (ev) sendRef.current(ev);
    };

    const onWheel = (e: WheelEvent) => {
      reconcile(e);
      e.preventDefault();
      const ev = wheelOf(e, rect());
      if (ev) sendRef.current(ev);
    };

    const onKey = (action: "down" | "up") => (e: KeyboardEvent) => {
      const ev = keyOf(action, e);
      if (!ev) return;
      if (ev.type === "key" && (ev.key === "Shift" || ev.key === "Alt")) {
        if (action === "down") held.current.add(ev.key);
        else held.current.delete(ev.key);
      }
      reconcile(e);
      e.preventDefault();
      sendRef.current(ev);
    };

    // 组词结束：整段文字一次送过去，sink 清空（它只是个中转，不留内容）。
    const onCompositionEnd = (e: CompositionEvent) => {
      if (sink.current) sink.current.value = "";
      if (!e.data) return;
      sendRef.current({ type: "text", text: e.data });
    };

    // 输入法直接上屏、没有组词的字（全角标点之类）：keydown 是 "Process"，字从 input 事件来。
    const onInput = (e: Event) => {
      const ie = e as InputEvent_;
      // 组词途中不能碰 sink 的内容：改了值输入法的候选就被打断，等 compositionend 再清
      if (ie.isComposing) return;
      if (sink.current) sink.current.value = "";
      if (ie.inputType !== "insertText" || !ie.data) return;
      sendRef.current({ type: "text", text: ie.data });
    };

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text === "") return;
      sendRef.current({ type: "text", text: text.slice(0, TEXT_MAX) });
    };

    // 本地没有选区：拦下默认复制（复制空串会冲掉用户剪贴板里原有的内容），改请页面给出选中的文字
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      copyRef.current();
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    const onKeyDown = onKey("down");
    const onKeyUp = onKey("up");

    node.addEventListener("mousemove", onMove);
    node.addEventListener("mousedown", onDown);
    // 拖出元素外再松开也要发 up，所以挂在 window 上
    window.addEventListener("mouseup", onUp);
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("keyup", onKeyUp);
    node.addEventListener("focus", onFocus);
    node.addEventListener("compositionend", onCompositionEnd);
    node.addEventListener("input", onInput);
    node.addEventListener("paste", onPaste);
    node.addEventListener("copy", onCopy);
    node.addEventListener("contextmenu", onContextMenu);

    return () => {
      if (frame !== null) cancelRaf(frame);
      pending = null;
      node.removeEventListener("mousemove", onMove);
      node.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("keyup", onKeyUp);
      node.removeEventListener("focus", onFocus);
      node.removeEventListener("compositionend", onCompositionEnd);
      node.removeEventListener("input", onInput);
      node.removeEventListener("paste", onPaste);
      node.removeEventListener("copy", onCopy);
      node.removeEventListener("contextmenu", onContextMenu);
    };
  }, [el, enabled, sink]);
}
