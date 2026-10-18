import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { FakeWS, installApi } from "../fakes";
import { Shell } from "../Shell";

beforeEach(() => {
  FakeWS.all = [];
  localStorage.clear();
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const rect = (l: number, t: number, w: number, h: number) =>
  ({
    left: l,
    top: t,
    right: l + w,
    bottom: t + h,
    width: w,
    height: h,
    x: l,
    y: t,
  }) as DOMRect;

// 左 pane 占 0-500，右 pane 占 500-1000；高 400。tab 在顶部。
function fakeGeometry(ids: { left: string; right: string }) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const pid = this.getAttribute("data-pane-id");
      if (pid === ids.left) return rect(0, 50, 500, 400);
      if (pid === ids.right) return rect(500, 50, 500, 400);
      if (this.getAttribute("role") === "tab") {
        const idx = [...document.querySelectorAll('[role="tab"]')].indexOf(
          this,
        );
        return rect(idx * 100, 0, 100, 40);
      }
      return rect(0, 0, 0, 0);
    },
  );
}

async function twoPanes() {
  installApi([]);
  render(<Shell sessions={[]} onUnauthorized={() => {}} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "向右分割" }));
  const regions = screen.getAllByRole("region");
  const ids = regions.map((r) => r.getAttribute("data-pane-id") as string);
  return { regions, ids };
}

const header = (region: HTMLElement) =>
  region.querySelector("header") as HTMLElement;
const orderIn = () =>
  [...document.querySelectorAll("[data-pane-id]")]
    .filter((e) => !(e as HTMLElement).hasAttribute("inert"))
    .map((e) => e.getAttribute("data-pane-id"));
const move = (x: number, y: number) =>
  act(() => {
    fireEvent.pointerMove(window, { clientX: x, clientY: y });
  });
const up = () => act(() => void fireEvent.pointerUp(window));

test("R5 拖到另一个 pane 的左边缘：插到它前面，并显示落点预览", async () => {
  const { regions, ids } = await twoPanes();
  const [a, b] = ids as [string, string];
  fakeGeometry({ left: a, right: b });
  fireEvent.pointerDown(header(regions[1] as HTMLElement), {
    clientX: 700,
    clientY: 60,
    button: 0,
  });
  move(10, 200);
  const prev = document.querySelector("[data-drop-preview]") as HTMLElement;
  expect(prev.getAttribute("data-drop-preview")).toBe("edge");
  up();
  expect(document.querySelector("[data-drop-preview]")).toBeNull();
  // b 被移到 a 之前：树里的顺序是 b, a。
  const layer = document.querySelector("[data-pane-layer]") as HTMLElement;
  const left = (id: string) =>
    parseFloat(
      (layer.querySelector(`[data-pane-id="${id}"]`) as HTMLElement).style.left,
    );
  expect(left(b)).toBeLessThan(left(a));
});

test("R5 拖到上边缘：垂直分割", async () => {
  const { regions, ids } = await twoPanes();
  const [a, b] = ids as [string, string];
  fakeGeometry({ left: a, right: b });
  fireEvent.pointerDown(header(regions[1] as HTMLElement), {
    clientX: 700,
    clientY: 60,
    button: 0,
  });
  move(250, 55);
  up();
  const layer = document.querySelector("[data-pane-layer]") as HTMLElement;
  const el = (id: string) =>
    layer.querySelector(`[data-pane-id="${id}"]`) as HTMLElement;
  expect(el(b).style.top).toBe("0%");
  expect(el(a).style.top).toBe("50%");
});

test("R5 松手前按 Esc 取消，pane 回到原位", async () => {
  const { regions, ids } = await twoPanes();
  const [a, b] = ids as [string, string];
  fakeGeometry({ left: a, right: b });
  const before = orderIn();
  fireEvent.pointerDown(header(regions[1] as HTMLElement), {
    clientX: 700,
    clientY: 60,
    button: 0,
  });
  move(10, 200);
  expect(document.querySelector("[data-drop-preview]")).toBeTruthy();
  act(() => void fireEvent.keyDown(window, { key: "Escape" }));
  expect(document.querySelector("[data-drop-preview]")).toBeNull();
  up();
  expect(orderIn()).toEqual(before);
});

test("R5 落到 window 标签：pane 移到那个 window，原 window 的兄弟占满", async () => {
  const { regions, ids } = await twoPanes();
  const [a, b] = ids as [string, string];
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  fireEvent.click(screen.getAllByRole("tab")[0] as HTMLElement);
  fakeGeometry({ left: a, right: b });
  fireEvent.pointerDown(header(regions[1] as HTMLElement), {
    clientX: 700,
    clientY: 60,
    button: 0,
  });
  move(150, 20); // 第二个 tab（100-200）
  expect(
    (document.querySelector("[data-drop-preview]") as HTMLElement).dataset
      .dropPreview,
  ).toBe("window");
  up();
  const layer = document.querySelector("[data-pane-layer]") as HTMLElement;
  const el = (id: string) =>
    layer.querySelector(`[data-pane-id="${id}"]`) as HTMLElement;
  expect(el(a).style.width).toBe("100%");
  expect(el(b).style.visibility).toBe("hidden");
});

test("R5 指针被系统取消（pointercancel）：遮罩撤掉，pane 不动", async () => {
  const { regions, ids } = await twoPanes();
  const [a, b] = ids as [string, string];
  fakeGeometry({ left: a, right: b });
  const before = orderIn();
  fireEvent.pointerDown(header(regions[1] as HTMLElement), {
    clientX: 700,
    clientY: 60,
    button: 0,
  });
  move(10, 200);
  expect(document.querySelector("[data-drop-preview]")).toBeTruthy();
  act(() => void fireEvent.pointerCancel(window));
  expect(document.querySelector("[data-drop-preview]")).toBeNull();
  expect(document.querySelector(".cursor-grabbing")).toBeNull();
  up();
  expect(orderIn()).toEqual(before);
});

test("R5 拖动时显示跟随鼠标的标签，禁止划选文字", async () => {
  const { regions } = await twoPanes();
  fakeGeometry({ left: "p1", right: "p2" });
  fireEvent.pointerDown(header(regions[1] as HTMLElement), {
    clientX: 700,
    clientY: 60,
    button: 0,
  });
  move(750, 100);
  const ghost = document.querySelector("[data-drag-ghost]") as HTMLElement;
  expect(ghost).toBeTruthy();
  expect(ghost.textContent).toContain("对话");
  const left = Number.parseFloat(ghost.style.left);
  const top = Number.parseFloat(ghost.style.top);
  expect(left).toBeCloseTo(750 + 14, 1);
  expect(top).toBeCloseTo(100 + 14, 1);
  expect(document.body.style.userSelect).toBe("none");
  up();
  expect(document.body.style.userSelect).toBe("");
});

test("R5 移动不足 4px 不算拖动，标题栏按钮点击不受影响", async () => {
  const { regions, ids } = await twoPanes();
  fakeGeometry({ left: ids[0] as string, right: ids[1] as string });
  fireEvent.pointerDown(header(regions[0] as HTMLElement), {
    clientX: 100,
    clientY: 60,
    button: 0,
  });
  move(102, 61);
  expect(document.querySelector("[data-drop-preview]")).toBeNull();
  up();
  expect(screen.getAllByRole("region")).toHaveLength(2);
});

// 标题栏 30px、tab 栏 30px 的几何；pane 从 y=80 开始，tab 栏在 50-80。
function chromeGeometry(left: string, right: string) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const pid = this.getAttribute("data-pane-id");
      if (pid === left) return rect(0, 80, 500, 400);
      if (pid === right) return rect(500, 80, 500, 400);
      if (this.tagName === "HEADER") {
        const p = (this.parentElement as Element).getAttribute("data-pane-id");
        return p === left ? rect(0, 80, 500, 30) : rect(500, 80, 500, 30);
      }
      if (this.hasAttribute("data-tabstrip")) return rect(0, 50, 500, 30);
      return rect(0, 0, 0, 0);
    },
  );
}

test("R9a 拖出 tab：落到整组的右边缘即平铺成两个 pane", async () => {
  const { regions, ids } = await twoPanes();
  const [a, b] = ids as [string, string];
  chromeGeometry(a, b);
  // 把 b 的标题栏拖到 a 的标题栏上：并入 tab 组。
  fireEvent.pointerDown(header(regions[1] as HTMLElement), {
    clientX: 700,
    clientY: 90,
    button: 0,
  });
  move(250, 90);
  up();
  expect(document.querySelector("[role=tablist]")).toBeTruthy();
  const tabB = document.querySelector(`[data-tab-id="${b}"]`) as HTMLElement;
  fireEvent.pointerDown(tabB, { clientX: 150, clientY: 60, button: 0 });
  fireEvent.click(screen.getAllByRole("tab")[0] as HTMLElement);
  move(495, 300);
  expect(
    (document.querySelector("[data-drop-preview]") as HTMLElement)?.dataset
      .dropPreview,
  ).toBe("edge");
  up();
  expect(screen.getAllByRole("region")).toHaveLength(2);
  const layer = document.querySelector("[data-pane-layer]") as HTMLElement;
  const el = (id: string) =>
    layer.querySelector(`[data-pane-id="${id}"]`) as HTMLElement;
  expect(el(a).style.width).toBe("50%");
  expect(el(b).style.width).toBe("50%");
});
