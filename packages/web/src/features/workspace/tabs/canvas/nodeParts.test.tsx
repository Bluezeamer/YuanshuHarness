import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { NodeBody } from "./nodeParts";

afterEach(cleanup);

/** jsdom 没有布局：把滚动条的几何写进去（offsetWidth 与 clientWidth 之差就是滚动条宽，zoom 是画布缩放） */
function mount(bar: number, zoom = 1) {
  const outer = vi.fn();
  const { container } = render(
    <div>
      <NodeBody>内容</NodeBody>
    </div>,
  );
  const wrap = container.firstElementChild as HTMLElement;
  wrap.addEventListener("mousedown", outer);
  const body = wrap.firstElementChild as HTMLElement;
  Object.defineProperty(body, "offsetWidth", { value: 100 });
  Object.defineProperty(body, "clientWidth", { value: 100 - bar });
  body.getBoundingClientRect = () =>
    ({ left: 0, right: 100 * zoom, width: 100 * zoom }) as DOMRect;
  const press = (clientX: number) =>
    body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX }));
  return { body, outer, press };
}

test("按在滚动条上不冒泡（库就不会把它当成拖卡片 / 平移画布）；按在内容上照常冒泡", () => {
  const { outer, press } = mount(8);
  press(96); // 滚动条在 92..100
  expect(outer).not.toHaveBeenCalled();
  press(50);
  expect(outer).toHaveBeenCalledTimes(1);
});

test("滚动条的宽度要换成屏幕像素：缩放 0.5 时它在屏幕上只有 4px（96..100 → 48..50）", () => {
  const { outer, press } = mount(8, 0.5);
  press(49);
  expect(outer).not.toHaveBeenCalled();
  press(45); // 落在内容上（滚动条从 46 开始）
  expect(outer).toHaveBeenCalledTimes(1);
});

test("没有滚动条（内容放得下）：右缘照常冒泡，卡片仍能从那里拖", () => {
  const { outer, press } = mount(0);
  press(99);
  expect(outer).toHaveBeenCalledTimes(1);
});

test("带 cv-nbody cv-scroll 两个类", () => {
  const { body } = mount(8);
  expect(body.className).toBe("cv-nbody cv-scroll");
});

test("中键按下 preventDefault（不让浏览器显示自动滚动的标识），而且仍冒泡（画布照常能被中键拖动）；左键不阻止默认行为", () => {
  const { body, outer } = mount(0);
  const mid = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 1,
  });
  body.dispatchEvent(mid);
  expect(mid.defaultPrevented).toBe(true);
  expect(outer).toHaveBeenCalledTimes(1);
  const left = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  body.dispatchEvent(left);
  expect(left.defaultPrevented).toBe(false);
});

test("内容比它高时给所在节点打 data-scroll（缩放感应带据此让开滚动条），放得下就没有", () => {
  const { container } = render(
    <div className="cv-node">
      <NodeBody>内容</NodeBody>
    </div>,
  );
  const node = container.firstElementChild as HTMLElement;
  expect(node.hasAttribute("data-scroll")).toBe(false);
  cleanup();
  const tall = render(<div className="cv-node" />);
  const host = tall.container.firstElementChild as HTMLElement;
  const proto = HTMLElement.prototype;
  const sh = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const ch = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get: () => 300,
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get: () => 100,
  });
  try {
    tall.unmount();
    const r = render(
      <div className="cv-node">
        <NodeBody>内容</NodeBody>
      </div>,
    );
    expect(
      (r.container.firstElementChild as HTMLElement).hasAttribute(
        "data-scroll",
      ),
    ).toBe(true);
    r.unmount();
  } finally {
    if (sh) Object.defineProperty(proto, "scrollHeight", sh);
    else Reflect.deleteProperty(proto, "scrollHeight");
    if (ch) Object.defineProperty(proto, "clientHeight", ch);
    else Reflect.deleteProperty(proto, "clientHeight");
  }
  void host;
});
