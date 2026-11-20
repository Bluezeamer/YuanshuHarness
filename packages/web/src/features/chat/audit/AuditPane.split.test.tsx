// 对应原型 tests/audit.smoke.cjs 的「持久化」与「审计分栏宽度」断言，外加窄屏折叠。
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  filterShown,
  installBox,
  latest,
  loaded,
  mount,
  resizeTo,
  rows,
  setupEnv,
} from "./harness";

vi.mock("../../../api/calls", async () => (await import("./fakeapi")).api);

setupEnv();

const root = () => document.querySelector("[data-audit]") as HTMLElement;
const wVar = () => Number.parseFloat(root().style.getPropertyValue("--au-w"));
const splitter = () =>
  screen.getByRole("separator", { name: "调整调用序列宽度" });
const key = (k: string, shiftKey = false) =>
  fireEvent.keyDown(splitter(), { key: k, shiftKey });

// ── 分栏宽度 ──

test("序列与详情之间是一条可聚焦的竖向分隔条，序列在它前面、详情在它后面", async () => {
  mount();
  await loaded();
  const s = splitter();
  expect(s.getAttribute("aria-orientation")).toBe("vertical");
  expect(s.getAttribute("aria-valuemin")).toBe("216");
  expect(s.tabIndex).toBe(0);
  expect(s.previousElementSibling?.classList.contains("au-rail")).toBe(true);
  expect(s.nextElementSibling?.classList.contains("au-detail")).toBe(true);
});

test("默认宽度 248；没有存值时 afx.w 不被写入", async () => {
  mount();
  await loaded();
  expect(wVar()).toBe(248);
  expect(latest.afx?.w).toBeUndefined();
});

test("拖动实时改 --au-w 但不写 afx（不重绘），松手才落盘", async () => {
  mount();
  await loaded();
  const s = splitter();
  fireEvent.pointerDown(s, { button: 0, clientX: 400, pointerId: 1 });
  expect(s.getAttribute("data-dragging")).toBe("true");
  fireEvent.pointerMove(s, { clientX: 480, pointerId: 1 });
  expect(wVar()).toBe(328);
  expect(latest.afx?.w).toBeUndefined();
  fireEvent.pointerUp(s, { pointerId: 1 });
  expect(s.getAttribute("data-dragging")).toBeNull();
  expect(wVar()).toBe(328);
  expect(latest.afx?.w).toBe(328);
});

test("最窄 216；最宽让详情至少留 320（900 - 320 = 580）", async () => {
  mount();
  await loaded();
  const s = splitter();
  fireEvent.pointerDown(s, { button: 0, clientX: 400, pointerId: 1 });
  fireEvent.pointerMove(s, { clientX: -600, pointerId: 1 });
  fireEvent.pointerUp(s, { pointerId: 1 });
  expect(latest.afx?.w).toBe(216);
  fireEvent.pointerDown(s, { button: 0, clientX: 400, pointerId: 1 });
  fireEvent.pointerMove(s, { clientX: 5000, pointerId: 1 });
  fireEvent.pointerUp(s, { pointerId: 1 });
  expect(latest.afx?.w).toBe(580);
  expect(s.getAttribute("aria-valuenow")).toBe("580");
});

test("双击复位到 248", async () => {
  mount("s1", { w: 400 });
  await loaded();
  expect(wVar()).toBe(400);
  fireEvent.doubleClick(splitter());
  expect(wVar()).toBe(248);
  expect(latest.afx?.w).toBe(248);
});

test("方向键微调 16，Shift 48；每次直接写进 afx.w", async () => {
  mount();
  await loaded();
  key("ArrowRight");
  expect(wVar()).toBe(264);
  expect(latest.afx?.w).toBe(264);
  key("ArrowLeft");
  expect(wVar()).toBe(248);
  key("ArrowRight", true);
  expect(wVar()).toBe(296);
  expect(latest.afx?.w).toBe(296);
});

test("宽度只写在标签的 afx 上，不碰任何全局存储", async () => {
  mount();
  await loaded();
  key("ArrowRight");
  expect(latest.afx).toEqual({ w: 264 });
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

test("存的宽度超过容器允许的最大值时按容器夹住，不挤没详情", async () => {
  mount("s1", { w: 880 });
  await loaded();
  expect(wVar()).toBe(580);
});

test("容器变窄时宽度随之夹住，afx 里存的值不被改写", async () => {
  mount("s1", { w: 560 });
  await loaded();
  expect(wVar()).toBe(560);
  resizeTo(700);
  expect(wVar()).toBe(380);
  expect(latest.afx?.w).toBe(560);
});

// ── 窄屏折叠（按容器宽度，不是视口） ──

test("窄于 620px：序列叠到详情上方，分隔条隐藏，详情仍在", async () => {
  installBox(500);
  mount();
  await loaded();
  expect(root().hasAttribute("data-narrow")).toBe(true);
  expect(screen.queryByRole("separator")).toBeNull();
  expect(rows()).toHaveLength(11);
  expect(document.querySelector(".au-detail")).toBeTruthy();
});

test("宽于等于 620px 不折叠；容器宽度变化时即时切换", async () => {
  installBox(620);
  mount();
  await loaded();
  expect(root().hasAttribute("data-narrow")).toBe(false);
  expect(splitter()).toBeTruthy();
  resizeTo(619);
  expect(root().hasAttribute("data-narrow")).toBe(true);
  expect(screen.queryByRole("separator")).toBeNull();
  resizeTo(1000);
  expect(root().hasAttribute("data-narrow")).toBe(false);
  expect(splitter()).toBeTruthy();
});

test("窄屏左栏滚到底也触发载入更早的调用", async () => {
  installBox(500);
  const { installStore } = await import("./harness");
  const { makeCall } = await import("./testkit");
  const { api } = await import("./fakeapi");
  installStore({
    s1: Array.from({ length: 120 }, (_, i) =>
      makeCall("s1", {
        seq: i + 1,
        turn: 1,
        trigger: "tool_result",
        toolName: "t",
      }),
    ),
  });
  mount();
  await screen.findByText("调用 120");
  const list = document.querySelector("[data-alist]") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    value: 20000,
  });
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    value: 400,
  });
  Object.defineProperty(list, "scrollTop", {
    configurable: true,
    value: 19550,
  });
  fireEvent.scroll(list);
  await waitFor(() => expect(rows()).toHaveLength(120));
  expect(api.listCalls).toHaveBeenCalledTimes(2);
});

// ── 筛选 / 搜索 / 视图 / 折叠都经 afx 往返 ──

test("afx 里的 filter / q / mode / w / fold 还原到界面", async () => {
  mount("s1", {
    filter: "tool",
    q: "grep",
    mode: "json",
    w: 344,
    fold: { system: true },
  });
  await screen.findByText("调用 08");
  // 工具返回触发、且摘要 / 来源工具 / 发起的工具里含 grep：07 与 08
  expect(rows()).toHaveLength(2);
  expect(filterShown()).toBe("工具返回");
  expect(
    (screen.getByRole("textbox", { name: "搜索调用记录" }) as HTMLInputElement)
      .value,
  ).toBe("grep");
  expect(wVar()).toBe(344);
  await waitFor(() =>
    expect(document.querySelector("[data-ajson]")).toBeTruthy(),
  );
  expect(
    screen.getByRole("radio", { name: "JSON" }).getAttribute("aria-checked"),
  ).toBe("true");
});

test("afx.fold 决定折叠态：显式值压过默认值", async () => {
  mount("s1", { fold: { system: true, tools: false } });
  await screen.findByText("调用 11");
  await waitFor(() => expect(document.querySelector(".au-sec")).toBeTruthy());
  expect(
    screen
      .getByRole("button", { name: /系统提示词/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    screen
      .getByRole("button", { name: /工具定义/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(document.querySelectorAll(".au-toolrow")).toHaveLength(2);
});

test("afx 里是不认识的 filter / mode：回退到全部 / 结构", async () => {
  mount("s1", { filter: "bogus", mode: "xml" as never });
  await loaded();
  expect(rows()).toHaveLength(11);
  expect(
    screen.getByRole("radio", { name: "结构" }).getAttribute("aria-checked"),
  ).toBe("true");
});
