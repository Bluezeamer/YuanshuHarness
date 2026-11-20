import { act, cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CLOSE_DELAY_MS,
  type FloatPanel,
  useFloatPanel,
} from "./useFloatPanel";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const setup = (init: { enabled?: boolean; busy?: boolean } = {}) => {
  const panel = createRef<HTMLElement>();
  const props = { enabled: true, busy: false, ...init, panel };
  const hook = renderHook((p: typeof props) => useFloatPanel(p), {
    initialProps: props,
  });
  const at = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const cur = (): FloatPanel => hook.result.current;
  return { hook, props, at, cur };
};

test("鼠标一进触发区就展开（不等）；移出后过了延迟才收回，中途回来不收", () => {
  const { at, cur } = setup();
  act(() => cur().onPointerEnter());
  expect(cur().open).toBe(true);
  act(() => cur().onPointerLeave());
  at(CLOSE_DELAY_MS - 1);
  expect(cur().open).toBe(true);
  act(() => cur().onPointerEnter());
  at(1000);
  expect(cur().open).toBe(true);
  act(() => cur().onPointerLeave());
  at(CLOSE_DELAY_MS);
  expect(cur().open).toBe(false);
});

test("忙着不收；忙完了鼠标还在外面才开始计时收回；忙完了鼠标在里面就不收", () => {
  const { hook, props, at, cur } = setup();
  act(() => cur().onPointerEnter());
  hook.rerender({ ...props, busy: true });
  act(() => cur().onPointerLeave());
  at(5000);
  expect(cur().open).toBe(true);
  hook.rerender({ ...props, busy: false });
  at(CLOSE_DELAY_MS);
  expect(cur().open).toBe(false);

  act(() => cur().onPointerEnter());
  hook.rerender({ ...props, busy: true });
  hook.rerender({ ...props, busy: false });
  at(5000);
  expect(cur().open).toBe(true);
});

test("手动 toggle 开的不会因鼠标离开而收；再 toggle、Esc、点面板以外的地方才收；忙着时点外面不收", () => {
  const { hook, props, at, cur } = setup();
  const el = document.createElement("div");
  document.body.append(el);
  (props.panel as { current: HTMLElement | null }).current = el;
  act(() => cur().toggle());
  expect(cur().open).toBe(true);
  act(() => cur().onPointerEnter());
  act(() => cur().onPointerLeave());
  at(5000);
  expect(cur().open).toBe(true);

  hook.rerender({ ...props, busy: true });
  act(
    () =>
      void document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      ),
  );
  expect(cur().open).toBe(true);
  hook.rerender({ ...props, busy: false });
  act(
    () =>
      void el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
  );
  expect(cur().open).toBe(true);
  act(
    () =>
      void document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      ),
  );
  expect(cur().open).toBe(false);

  act(() => cur().toggle());
  act(
    () =>
      void document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  expect(cur().open).toBe(false);
  act(() => cur().toggle());
  act(() => cur().toggle());
  expect(cur().open).toBe(false);
  el.remove();
});

test("不是悬浮模式（enabled = false）：悬停不展开，已展开的立刻收起", () => {
  const { hook, props, at, cur } = setup({ enabled: false });
  act(() => cur().onPointerEnter());
  at(1000);
  expect(cur().open).toBe(false);
  hook.rerender({ ...props, enabled: true });
  act(() => cur().toggle());
  expect(cur().open).toBe(true);
  hook.rerender({ ...props, enabled: false });
  expect(cur().open).toBe(false);
});

test("手动展开后点开关按钮：按下时不当成「点了别处」，click 的 toggle 才把它收起（不会先收再开）", () => {
  const { props, cur } = setup();
  const el = document.createElement("div");
  const btn = document.createElement("button");
  btn.setAttribute("data-float-toggle", "");
  document.body.append(el, btn);
  (props.panel as { current: HTMLElement | null }).current = el;
  act(() => cur().toggle());
  expect(cur().open).toBe(true);
  act(
    () =>
      void btn.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      ),
  );
  expect(cur().open).toBe(true);
  act(() => cur().toggle());
  expect(cur().open).toBe(false);
  el.remove();
  btn.remove();
});

test("悬停展开着时点按钮：改成手动展开（鼠标离开不收），再点才收起", () => {
  const { at, cur } = setup();
  act(() => cur().onPointerEnter());
  expect(cur()).toMatchObject({ open: true, manual: false });
  act(() => cur().toggle());
  expect(cur()).toMatchObject({ open: true, manual: true });
  act(() => cur().onPointerLeave());
  at(5000);
  expect(cur().open).toBe(true);
  act(() => cur().toggle());
  expect(cur().open).toBe(false);
});
