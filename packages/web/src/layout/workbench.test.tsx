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
import { SAVE_DELAY_MS } from "./useWorkbench";

const s = (id: string, name: string) => ({
  id,
  name,
  createdAt: "t",
  updatedAt: "t",
  running: false,
});
const sessions = [s("s1", "甲"), s("s2", "乙")];

beforeEach(() => {
  FakeWS.all = [];
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = async () => {
  const api = installApi([]);
  render(<Shell sessions={sessions} onUnauthorized={() => {}} />);
  await act(async () => {});
  return api;
};
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

test("R17 改动防抖后保存；刷新（重新挂载）后恢复会话绑定", async () => {
  vi.useFakeTimers();
  const api = await mount();
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  expect(api.puts).toHaveLength(0);
  await wait(SAVE_DELAY_MS + 10);
  expect(api.puts).toHaveLength(1);

  cleanup();
  render(<Shell sessions={sessions} onUnauthorized={() => {}} />);
  await act(async () => {});
  expect(screen.getByRole("heading", { name: "乙" })).toBeTruthy();
});

test("R2 分割出第二个 pane，关闭后兄弟占满", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "向右分割" }));
  expect(screen.getAllByRole("region")).toHaveLength(2);
  fireEvent.click(
    screen.getAllByRole("button", { name: "关闭" })[0] as HTMLElement,
  );
  expect(screen.getAllByRole("region")).toHaveLength(1);
});

test("R1 新建 window 后有两个 tab，可切换", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  const tabs = screen.getAllByRole("tab");
  expect(tabs).toHaveLength(2);
  expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("空 window")).toBeTruthy();
});

test("R9 未知类型的 pane 往返不丢，保存时原样写回", async () => {
  vi.useFakeTimers();
  const api = installApi([]);
  api.workbench = {
    revision: 3,
    document: {
      version: 1,
      activeWindowId: "w1",
      windows: [{ id: "w1", name: "a", tree: { kind: "leaf", paneId: "p1" } }],
      panes: { p1: { type: "future", configVersion: 7, config: { k: [1] } } },
    },
  };
  render(<Shell sessions={sessions} onUnauthorized={() => {}} />);
  await act(async () => {});
  expect(screen.getByText(/配置已保留/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  await wait(SAVE_DELAY_MS + 10);
  const saved = api.puts[0] as { panes: Record<string, unknown> };
  expect(saved.panes.p1).toEqual({
    type: "future",
    configVersion: 7,
    config: { k: [1] },
  });
});

test("R20 高版本文档只读：提示且不保存", async () => {
  vi.useFakeTimers();
  const api = installApi([]);
  api.workbench = {
    revision: 1,
    document: { version: 99, windows: [], panes: {}, activeWindowId: "" },
  };
  render(<Shell sessions={sessions} onUnauthorized={() => {}} />);
  await act(async () => {});
  expect(screen.getByText(/来自更新的版本/)).toBeTruthy();
  await wait(SAVE_DELAY_MS * 2);
  expect(api.puts).toHaveLength(0);
});

test("R21 冲突：提示，并可采用服务器版本", async () => {
  vi.useFakeTimers();
  const api = await mount();
  api.workbench = {
    revision: 5,
    document: {
      version: 1,
      activeWindowId: "w9",
      windows: [{ id: "w9", name: "别处", tree: null }],
      panes: {},
    },
  };
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  await wait(SAVE_DELAY_MS + 10);
  expect(screen.getByText(/布局已在别处修改/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "采用服务器版本" }));
  expect(screen.getByRole("tab", { name: "别处" })).toBeTruthy();
});

test("R21 冲突：以本地覆盖，用新 revision 重提", async () => {
  vi.useFakeTimers();
  const api = await mount();
  api.workbench = {
    revision: 5,
    document: {
      version: 1,
      activeWindowId: "w9",
      windows: [{ id: "w9", name: "别处", tree: null }],
      panes: {},
    },
  };
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  await wait(SAVE_DELAY_MS + 10);
  expect(api.puts).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "以本地覆盖" }));
  await act(async () => {});
  expect(api.puts).toHaveLength(1);
  expect(api.workbench.revision).toBe(6);
  expect(screen.queryByText(/布局已在别处修改/)).toBeNull();
});

test("R17 pagehide 立即冲刷，不等防抖", async () => {
  vi.useFakeTimers();
  const api = await mount();
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  expect(api.puts).toHaveLength(0);
  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });
  expect(api.puts).toHaveLength(1);
});

test("R1 双击 tab 重命名，名字可重复", async () => {
  vi.stubGlobal("prompt", () => "同名");
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  const tabs = screen.getAllByRole("tab");
  fireEvent.doubleClick(tabs[0] as HTMLElement);
  fireEvent.doubleClick(tabs[1] as HTMLElement);
  expect(screen.getAllByRole("tab", { name: "同名" })).toHaveLength(2);
});

const split2 = async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "向右分割" }));
  return screen.getByRole("separator");
};

test("R23 分割线：role、方向、数值，可聚焦", async () => {
  const sep = await split2();
  expect(sep.getAttribute("aria-orientation")).toBe("vertical");
  expect(sep.getAttribute("aria-valuenow")).toBe("50");
  expect(sep.tabIndex).toBe(0);
});

test("R23 分割线方向键步长 2%，到最小尺寸为止", async () => {
  const sep = await split2();
  fireEvent.keyDown(sep, { key: "ArrowRight" });
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
    "52",
  );
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
    "48",
  );
  for (let i = 0; i < 40; i++)
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
  expect(
    Number(screen.getByRole("separator").getAttribute("aria-valuenow")),
  ).toBeGreaterThanOrEqual(5);
});

test("R2 拖动分割线按容器像素换算比例，pane 不重挂载", async () => {
  const sep = await split2();
  const layer = document.querySelector("[data-pane-layer]") as HTMLElement;
  layer.getBoundingClientRect = () =>
    ({
      width: 1000,
      height: 500,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  const node = document.querySelector("[data-pane-id]");
  fireEvent.pointerDown(sep, { clientX: 500, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(screen.getByRole("separator"), {
    clientX: 600,
    clientY: 100,
    pointerId: 1,
  });
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
    "60",
  );
  fireEvent.pointerUp(screen.getByRole("separator"), { pointerId: 1 });
  fireEvent.pointerMove(screen.getByRole("separator"), {
    clientX: 800,
    clientY: 100,
    pointerId: 1,
  });
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
    "60",
  );
  expect(document.querySelector("[data-pane-id]")).toBe(node);
});

test("R6 Alt+方向键按位置移动焦点 pane", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "向右分割" }));
  const regions = () => screen.getAllByRole("region");
  const focusedLabel = () =>
    document
      .querySelector("[data-pane-id][data-focused='true']")
      ?.getAttribute("data-pane-id");
  const right = focusedLabel();
  fireEvent.keyDown(regions()[0] as HTMLElement, {
    key: "ArrowLeft",
    altKey: true,
  });
  const left = focusedLabel();
  expect(left).not.toBe(right);
  fireEvent.keyDown(regions()[0] as HTMLElement, {
    key: "ArrowRight",
    altKey: true,
  });
  expect(focusedLabel()).toBe(right);
});

test("R24 pane 总数达到 12 后新建前提示，但不阻止", async () => {
  await mount();
  for (let i = 0; i < 12; i++)
    fireEvent.click(
      screen.getAllByRole("button", { name: "向右分割" })[0] as HTMLElement,
    );
  expect(screen.getAllByRole("region")).toHaveLength(13);
  expect(screen.getByRole("status").textContent).toMatch(/12|13/);
});

const mountDoc = async (document: unknown) => {
  const api = installApi([]);
  api.workbench = { revision: 1, document };
  render(<Shell sessions={sessions} onUnauthorized={() => {}} />);
  await act(async () => {});
  return api;
};
const chat = (sessionId: string | null) => ({
  type: "chat",
  configVersion: 1,
  config: { sessionId },
});
const boundIds = () =>
  [...document.querySelectorAll("[data-pane-id]")].map((n) =>
    n.getAttribute("data-pane-id"),
  );

test("R17 保存失败（5xx 或网络）：提示且本地改动保留，下次改动后重试成功则提示消失", async () => {
  for (const status of [500, "network"] as const) {
    cleanup();
    vi.useFakeTimers();
    const api = await mount();
    api.putStatus = status;
    fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
    await wait(SAVE_DELAY_MS + 10);
    expect(screen.getByRole("alert").textContent).toMatch(/保存失败/);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    api.putStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
    await wait(SAVE_DELAY_MS + 10);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.puts).toHaveLength(1);
    vi.useRealTimers();
  }
});

test("R10 焦点不是 chat：点击会话落到本 window 内的 chat pane", async () => {
  await mountDoc({
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
            { kind: "leaf", paneId: "f" },
            { kind: "leaf", paneId: "c" },
          ],
        },
      },
    ],
    panes: {
      f: { type: "file_preview", configVersion: 1, config: {} },
      c: chat("s1"),
    },
  });
  expect(document.querySelector("[data-pane-id='f']")).toBeTruthy();
  fireEvent.focus(document.querySelector("[data-pane-id='f']") as HTMLElement);
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  expect(boundIds().sort()).toEqual(["c", "f"]);
  expect(screen.getByRole("heading", { name: "乙" })).toBeTruthy();
});

test("R10 本 window 没有 chat pane：点击会话新建一个", async () => {
  await mountDoc({
    version: 1,
    activeWindowId: "w1",
    windows: [{ id: "w1", name: "a", tree: { kind: "leaf", paneId: "f" } }],
    panes: { f: { type: "file_preview", configVersion: 1, config: {} } },
  });
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  expect(boundIds()).toHaveLength(2);
  expect(screen.getByRole("heading", { name: "乙" })).toBeTruthy();
});

test("R6 菜单：向下分割、移动到其他 window", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "向右分割" }));
  fireEvent.click(
    screen.getAllByRole("button", { name: "向下分割" })[0] as HTMLElement,
  );
  expect(screen.getAllByRole("region")).toHaveLength(3);

  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  fireEvent.click(screen.getAllByRole("tab")[0] as HTMLElement);
  const select = screen.getAllByLabelText(
    "移动到其他 window",
  )[0] as HTMLSelectElement;
  const target = select.querySelectorAll("option")[1] as HTMLOptionElement;
  fireEvent.change(select, { target: { value: target.value } });
  expect(screen.getAllByRole("region").length).toBeLessThan(
    document.querySelectorAll("[data-pane-id]").length,
  );
});

test("R21 同一 revision 不会并发提交：在途保存期间的新改动排队，不与自己 409", async () => {
  vi.useFakeTimers();
  const api = await mount();
  let release = () => {};
  api.putPause = new Promise<void>((r) => {
    release = r;
  });
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  await wait(SAVE_DELAY_MS + 10);
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  await wait(SAVE_DELAY_MS + 10);
  release();
  api.putPause = null;
  await wait(50);
  expect(screen.queryByText(/布局已在别处修改/)).toBeNull();
  expect(api.puts).toHaveLength(2);
  expect(api.workbench.revision).toBe(2);
});

test("R20 冲突返回的是更高版本文档：以本地覆盖不得覆盖它，转为只读", async () => {
  vi.useFakeTimers();
  const api = await mount();
  api.workbench = {
    revision: 5,
    document: { version: 99, windows: [], panes: {}, activeWindowId: "" },
  };
  fireEvent.click(screen.getByRole("button", { name: "新建 window" }));
  await wait(SAVE_DELAY_MS + 10);
  fireEvent.click(screen.getByRole("button", { name: "以本地覆盖" }));
  await wait(SAVE_DELAY_MS + 10);
  expect(api.puts).toHaveLength(0);
  expect(screen.getByText(/来自更新的版本/)).toBeTruthy();
});

test("R10 焦点不是 chat：优先落到最近聚焦过的 chat，而不是树里的第一个", async () => {
  await mountDoc({
    version: 1,
    activeWindowId: "w1",
    windows: [
      {
        id: "w1",
        name: "a",
        tree: {
          kind: "split",
          dir: "h",
          ratios: [0.3, 0.3, 0.4],
          children: [
            { kind: "leaf", paneId: "c1" },
            { kind: "leaf", paneId: "c2" },
            { kind: "leaf", paneId: "f" },
          ],
        },
      },
    ],
    panes: {
      c1: chat("s1"),
      c2: chat("s1"),
      f: { type: "file_preview", configVersion: 1, config: {} },
    },
  });
  const pane = (id: string) =>
    document.querySelector(`[data-pane-id='${id}']`) as HTMLElement;
  fireEvent.focus(pane("c2"));
  fireEvent.focus(pane("f"));
  fireEvent.click(screen.getByRole("button", { name: /乙/ }));
  expect(screen.getAllByRole("heading", { name: "乙" })).toHaveLength(1);
  expect(pane("c2").querySelector("h1")?.textContent).toBe("乙");
});

test("R7 chat 标题栏显示所绑定的会话名，region 的名字随之带上", async () => {
  await mountDoc({
    version: 1,
    activeWindowId: "w1",
    windows: [{ id: "w1", name: "a", tree: { kind: "leaf", paneId: "c" } }],
    panes: { c: chat("s2") },
  });
  expect(screen.getByRole("region", { name: "对话 · 乙" })).toBeTruthy();
});
