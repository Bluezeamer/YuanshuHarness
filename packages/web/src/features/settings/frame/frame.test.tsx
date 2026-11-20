import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { clearToasts, Empty, ToastHost } from "../../../ui";
import { ProvidersIcon } from "../../../ui/icons";
import { useBindDirty, useLeaveGuard } from "./leave";
import { SaveBar } from "./SaveBar";
import { SettingsLayout } from "./SettingsLayout";
import type { SettingsRoute } from "./types";
import { useDraft } from "./useDraft";

afterEach(() => {
  cleanup();
  clearToasts();
  history.replaceState(null, "", "/");
});

// 一个带草稿的页面：改一下就脏，保存结果由 saveResult 决定。
let saveResult: string | null = null;
const saved = vi.fn();
function Editor() {
  const d = useDraft({ text: "原值" }, async (draft) => {
    saved(draft);
    return saveResult;
  });
  useBindDirty(d);
  const guard = useLeaveGuard();
  const [switched, setSwitched] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => guard(() => setSwitched(true))}>
        同页切换
      </button>
      {switched && <span>已切换</span>}
      <input
        aria-label="文本"
        value={d.draft.text}
        onChange={(e) => d.setDraft({ text: e.target.value })}
      />
      <SaveBar
        dirty={d.dirty}
        saving={d.saving}
        onSave={() => void d.save()}
        onDiscard={d.discard}
      />
    </div>
  );
}

const routes: SettingsRoute[] = [
  { path: "alpha", label: "甲页", icon: ProvidersIcon, element: <Editor /> },
  {
    path: "beta",
    label: "乙页",
    icon: ProvidersIcon,
    element: <Empty title="乙页占位" />,
  },
];

const mount = (page?: string) =>
  render(
    <>
      <SettingsLayout routes={routes} page={page} />
      <ToastHost />
    </>,
  );
const type = (v: string) =>
  fireEvent.change(screen.getByLabelText("文本"), { target: { value: v } });
const click = async (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
// 确认框打开时页面里也有「保存」，所以确认框里的按钮单独取
const clickInDialog = async (name: string) =>
  act(async () => {
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name }),
    );
  });

test("导航按注册表渲染，当前页高亮并带 aria-current；没有页头与面包屑", () => {
  mount("beta");
  const nav = screen.getByRole("navigation", { name: "设置分区" });
  const links = nav.querySelectorAll("a");
  expect([...links].map((a) => a.textContent)).toEqual(["甲页", "乙页"]);
  expect(links[0]?.getAttribute("href")).toBe("/settings/alpha");
  expect(links[1]?.getAttribute("aria-current")).toBe("page");
  expect(links[0]?.getAttribute("aria-current")).toBeNull();
  expect(screen.getByText("乙页占位")).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "面包屑" })).toBeNull();
  expect(screen.queryByText("全部更改已保存")).toBeNull();
});

test("缺省显示第一项；页面名只作读屏用的一级标题", () => {
  mount();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("甲页");
});

test("点击导航项走前端路由，不整页刷新", () => {
  mount("alpha");
  fireEvent.click(screen.getByRole("link", { name: "乙页" }));
  expect(location.pathname).toBe("/settings/beta");
});

test("返回工作区回到 /", () => {
  history.replaceState(null, "", "/settings/alpha");
  mount("alpha");
  fireEvent.click(screen.getByRole("button", { name: "返回工作区" }));
  expect(location.pathname).toBe("/");
});

test("未知分区给出说明而不是白屏", () => {
  mount("nope");
  expect(screen.getByText("没有这个设置页")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("未找到");
});

test("改了才出保存条；放弃回到原值；保存成功弹绿色提示并收起保存条", async () => {
  saveResult = null;
  saved.mockClear();
  mount("alpha");
  expect(screen.queryByRole("region", { name: "保存" })).toBeNull();
  type("新值");
  expect(screen.getByRole("region", { name: "保存" })).toBeTruthy();
  await click("放弃");
  expect((screen.getByLabelText("文本") as HTMLInputElement).value).toBe(
    "原值",
  );
  expect(screen.queryByRole("region", { name: "保存" })).toBeNull();

  type("新值");
  await click("保存");
  expect(saved).toHaveBeenCalledWith({ text: "新值" });
  expect(await screen.findByText("已保存")).toBeTruthy();
});

test("保存失败：弹红色提示，草稿与保存条都留着", async () => {
  saveResult = "服务端没有响应";
  mount("alpha");
  type("新值");
  await click("保存");
  expect(await screen.findByText("保存失败：服务端没有响应")).toBeTruthy();
  expect((screen.getByLabelText("文本") as HTMLInputElement).value).toBe(
    "新值",
  );
  expect(screen.getByRole("region", { name: "保存" })).toBeTruthy();
});

test("Ctrl+S 保存，没有修改时不响应", async () => {
  saveResult = null;
  saved.mockClear();
  mount("alpha");
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  expect(saved).not.toHaveBeenCalled();
  type("新值");
  await act(async () => {
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  });
  expect(saved).toHaveBeenCalledTimes(1);
});

test("离开保护：有修改时点导航先问；取消留在原页，放弃修改才走，保存成功后走", async () => {
  saveResult = null;
  saved.mockClear();
  mount("alpha");
  history.replaceState(null, "", "/settings/alpha");
  type("新值");

  fireEvent.click(screen.getByRole("link", { name: "乙页" }));
  expect(
    screen.getByText("有未保存的修改", { selector: "h2, [role=dialog] *" }),
  ).toBeTruthy();
  expect(location.pathname).toBe("/settings/alpha");
  await clickInDialog("取消");
  expect(location.pathname).toBe("/settings/alpha");

  fireEvent.click(screen.getByRole("link", { name: "乙页" }));
  await clickInDialog("放弃修改");
  expect(location.pathname).toBe("/settings/beta");
  expect(saved).not.toHaveBeenCalled();
});

test("离开保护：选「保存」成功后才离开；失败则留在原页", async () => {
  saveResult = null;
  saved.mockClear();
  history.replaceState(null, "", "/settings/alpha");
  const { unmount } = mount("alpha");
  type("新值");
  fireEvent.click(screen.getByRole("link", { name: "乙页" }));
  await clickInDialog("保存");
  expect(saved).toHaveBeenCalledTimes(1);
  expect(location.pathname).toBe("/settings/beta");
  unmount();

  saveResult = "失败了";
  history.replaceState(null, "", "/settings/alpha");
  mount("alpha");
  type("新值");
  fireEvent.click(screen.getByRole("link", { name: "乙页" }));
  await clickInDialog("保存");
  expect(location.pathname).toBe("/settings/alpha");
});

test("离开保护：点「返回工作区」同样先问", async () => {
  history.replaceState(null, "", "/settings/alpha");
  mount("alpha");
  type("新值");
  fireEvent.click(screen.getByRole("button", { name: "返回工作区" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(location.pathname).toBe("/settings/alpha");
  await clickInDialog("放弃修改");
  expect(location.pathname).toBe("/");
});

test("页内切换（页签、编辑对象）也走 guard；放弃修改真的丢掉草稿，保存则落库后再切", async () => {
  saveResult = null;
  saved.mockClear();
  mount("alpha");
  type("新值");
  await click("同页切换");
  expect(screen.queryByText("已切换")).toBeNull();
  await clickInDialog("放弃修改");
  expect(screen.getByText("已切换")).toBeTruthy();
  expect((screen.getByLabelText("文本") as HTMLInputElement).value).toBe(
    "原值",
  );
  expect(saved).not.toHaveBeenCalled();

  type("又改了");
  await click("同页切换");
  await clickInDialog("保存");
  expect(saved).toHaveBeenCalledWith({ text: "又改了" });
});

test("没有修改时点导航直接走，不弹确认", () => {
  mount("alpha");
  fireEvent.click(screen.getByRole("link", { name: "乙页" }));
  expect(location.pathname).toBe("/settings/beta");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("settingsRoutes：八个导航项齐全，路径唯一，每项都带页面元素", async () => {
  const { settingsRoutes } = await import("../routes");
  expect(settingsRoutes.map((r) => r.path)).toEqual([
    "providers",
    "remote",
    "variables",
    "tools",
    "browser",
    "studio",
    "devices",
    "defaults",
  ]);
  expect(new Set(settingsRoutes.map((r) => r.path)).size).toBe(
    settingsRoutes.length,
  );
  for (const r of settingsRoutes) {
    expect(r.label, r.path).not.toBe("");
    expect(r.element, r.path).toBeTruthy();
  }
});

test("公开入口导出壳与注册表", async () => {
  const mod = await import("../index");
  expect(typeof mod.SettingsLayout).toBe("function");
  expect(Array.isArray(mod.settingsRoutes)).toBe(true);
});
