import {
  act,
  cleanup,
  fireEvent,
  render,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { FakeWS, installApi } from "../fakes";
import { Shell } from "../Shell";

beforeEach(() => {
  FakeWS.all = [];
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const chat = { type: "chat", configVersion: 1, config: { sessionId: null } };

// 一个 tab 组 [a, b]（选中 b），旁边一个独立 pane c。
const mount = async () => {
  const api = installApi([]);
  api.workbench = {
    revision: 1,
    document: {
      version: 1,
      activeWindowId: "w1",
      windows: [
        {
          id: "w1",
          name: "a",
          tree: {
            kind: "split",
            dir: "h",
            ratios: [0.5, 0.5],
            children: [
              { kind: "leaf", paneId: "b", tabs: ["a", "b"] },
              { kind: "leaf", paneId: "c" },
            ],
          },
        },
      ],
      panes: { a: chat, b: chat, c: chat },
    },
  };
  render(<Shell sessions={[]} onUnauthorized={() => {}} />);
  await act(async () => {});
};
const node = (id: string) =>
  document.querySelector(`[data-pane-id="${id}"]`) as HTMLElement;
const strip = () => document.querySelector("[data-tabstrip]") as HTMLElement;

test("R9a 组里只有选中项可见，其余 tab 仍挂载但不可见", async () => {
  await mount();
  expect(node("b").style.visibility).toBe("visible");
  expect(node("a").style.visibility).toBe("hidden");
  expect(node("a").hasAttribute("inert")).toBe(true);
  expect(strip().querySelectorAll("[role=tab]")).toHaveLength(2);
});

test("R9a 切换 tab：只换可见项，DOM 节点不被替换", async () => {
  await mount();
  const [a, b] = [node("a"), node("b")];
  fireEvent.click(strip().querySelector('[data-tab-id="a"]') as HTMLElement);
  expect(node("a")).toBe(a);
  expect(node("b")).toBe(b);
  expect(a.style.visibility).toBe("visible");
  expect(b.style.visibility).toBe("hidden");
});

test("R9a 关闭组内一个 tab：剩一个时退回普通 pane，标签栏消失，另一个保持挂载", async () => {
  await mount();
  const a = node("a");
  const close = strip().querySelectorAll("button")[1] as HTMLElement; // b 的 ×
  fireEvent.click(close);
  expect(strip()).toBeNull();
  expect(node("b")).toBeNull();
  expect(node("a")).toBe(a);
  expect(a.style.visibility).toBe("visible");
});
