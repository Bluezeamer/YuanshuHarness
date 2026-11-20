import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { clearToasts } from "../../../../ui";
import { mountPlugins, seedPlugins } from "./testkit";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "pi 扩展" });
const rowOf = (n: string) =>
  within(rail()).getByText(n).closest(".u-lrow") as HTMLElement;
const names = () =>
  [...rail().querySelectorAll(".u-lrow-label")].map((e) => e.textContent);
const choose = (n: string) => fireEvent.click(within(rail()).getByText(n));
const detail = (n: string) =>
  screen.getByRole("article", { name: `${n} 详情` });
const status = (n: string) =>
  within(rowOf(n)).getByRole("img").getAttribute("aria-label");

const book = {
  "npm:pi-notes": {
    source: "npm:pi-notes",
    version: "0.3.0",
    extensionCount: 1,
    skillCount: 0,
    hasInstallScript: false,
  },
  "npm:pi-build": {
    source: "npm:pi-build",
    version: "1.0.0",
    extensionCount: 1,
    skillCount: 0,
    hasInstallScript: true,
  },
};

const openInstall = () => {
  fireEvent.click(within(rail()).getByRole("button", { name: /安装扩展/ }));
  return screen.getByRole("dialog", { name: /安装 pi 扩展/ });
};
const typeSource = (dlg: HTMLElement, v: string) =>
  fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: v } });

test("左列表：名字去掉协议，副标题是来源类型与版本，状态点说明启用或停用", async () => {
  await mountPlugins();
  expect(names()).toEqual([
    "pi-subagents",
    "@tintinweb/pi-tasks",
    "pi-web-access",
  ]);
  expect(rowOf("pi-subagents").textContent).toContain("npm · v2.1.0");
  expect(status("pi-subagents")).toBe("已启用");
  expect(status("pi-web-access")).toBe("已停用");
});

test("详情：默认选中第一个；写明带来什么与生效时机；停用的不说「没有扩展」", async () => {
  await mountPlugins();
  const d = detail("pi-subagents");
  expect(d.textContent).toContain("2 个扩展");
  expect(d.textContent).toContain("重载");
  choose("pi-web-access");
  expect(detail("pi-web-access").textContent).toContain(
    "扩展、技能和提示词模板都不进会话",
  );
});

test("停用再启用：弹提示，行状态跟着变", async () => {
  const { fake } = await mountPlugins();
  fireEvent.click(screen.getByRole("button", { name: "停用" }));
  await waitFor(() => expect(status("pi-subagents")).toBe("已停用"));
  expect(fake.called("PATCH", /\/plugins\//)[0]?.body).toEqual({
    enabled: false,
  });
  expect(await screen.findByText(/已停用，新会话或重载后生效/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "启用" }));
  await waitFor(() => expect(status("pi-subagents")).toBe("已启用"));
});

test("安装两步：先预览（不改登记），确认后才安装；装好后选中它", async () => {
  const { fake } = await mountPlugins(seedPlugins(), book);
  const dlg = openInstall();
  typeSource(dlg, "npm:pi-notes");
  fireEvent.click(within(dlg).getByRole("button", { name: "预览" }));
  expect(await within(dlg).findByText("0.3.0", { exact: false })).toBeTruthy();
  // 预览阶段没有任何写入
  expect(fake.called("POST", /\/plugins$/)).toHaveLength(0);
  fireEvent.click(within(dlg).getByRole("button", { name: "安装" }));
  await waitFor(() => expect(names()).toContain("pi-notes"));
  expect(fake.called("POST", /\/plugins$/)[0]?.body).toEqual({
    source: "npm:pi-notes",
    allowScript: false,
  });
  expect(detail("pi-notes")).toBeTruthy();
  expect(await screen.findByText(/已安装，新会话或重载后生效/)).toBeTruthy();
});

test("带安装脚本的包：默认不允许，勾选后才带 allowScript；改了来源要重新预览", async () => {
  const { fake } = await mountPlugins(seedPlugins(), book);
  const dlg = openInstall();
  typeSource(dlg, "npm:pi-build");
  fireEvent.click(within(dlg).getByRole("button", { name: "预览" }));
  const box = await within(dlg).findByRole("checkbox", {
    name: "允许运行安装脚本",
  });
  expect(box.getAttribute("aria-checked")).toBe("false");
  // 改来源：预览作废，按钮回到「预览」
  typeSource(dlg, "npm:pi-build2");
  expect(within(dlg).getByRole("button", { name: "预览" })).toBeTruthy();
  typeSource(dlg, "npm:pi-build");
  fireEvent.click(within(dlg).getByRole("button", { name: "预览" }));
  fireEvent.click(
    await within(dlg).findByRole("checkbox", { name: "允许运行安装脚本" }),
  );
  fireEvent.click(within(dlg).getByRole("button", { name: "安装" }));
  await waitFor(() => expect(names()).toContain("pi-build"));
  expect(fake.called("POST", /\/plugins$/)[0]?.body).toEqual({
    source: "npm:pi-build",
    allowScript: true,
  });
});

test("预览失败：原因留在弹窗里，不进入安装；没写前缀有提示", async () => {
  await mountPlugins(seedPlugins(), book);
  const dlg = openInstall();
  typeSource(dlg, "pi-nowhere");
  expect(within(dlg).getByText(/没写前缀会被当成本地路径/)).toBeTruthy();
  fireEvent.click(within(dlg).getByRole("button", { name: "预览" }));
  expect(await within(dlg).findByText(/没有可加载的内容/)).toBeTruthy();
  expect(within(dlg).queryByRole("button", { name: "安装" })).toBeNull();
});

test("卸载：二次确认说明影响；确认后从列表消失，选中落到下一个", async () => {
  const { fake } = await mountPlugins();
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "卸载" }));
  const dlg = await screen.findByRole("dialog", { name: "卸载 pi-subagents" });
  expect(dlg.textContent).toContain("删除装到本机的包体");
  fireEvent.click(within(dlg).getByRole("button", { name: "卸载" }));
  await waitFor(() => expect(names()).not.toContain("pi-subagents"));
  expect(fake.called("DELETE", /\/plugins\//)).toHaveLength(1);
  expect(await screen.findByText(/pi-subagents 已卸载/)).toBeTruthy();
});

test("本地目录来源卸载：说明目录本身不会删", async () => {
  await mountPlugins([
    {
      source: "../../tmp/pkg",
      version: "0.1.0",
      enabled: true,
      installed: true,
      extensionCount: 1,
      skillCount: 0,
    },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "卸载" }));
  const dlg = await screen.findByRole("dialog", { name: "卸载 pkg" });
  expect(dlg.textContent).toContain("目录本身不会删");
  expect(dlg.textContent).not.toContain("删除装到本机的包体");
});

test("登记了但包体没装上：列表标红、详情给原因，没有启用 / 停用按钮", async () => {
  await mountPlugins([
    {
      source: "npm:pi-gone",
      version: null,
      enabled: true,
      installed: false,
      extensionCount: 0,
      skillCount: 0,
    },
  ]);
  expect(status("pi-gone")).toBe("未装上");
  expect(detail("pi-gone").textContent).toContain("包体没有装上");
  expect(screen.queryByRole("button", { name: "停用" })).toBeNull();
  expect(screen.queryByRole("button", { name: "启用" })).toBeNull();
});

test("一个包都没有：空状态给出下一步", async () => {
  await mountPlugins([]);
  // 列表栏写「还没有安装 pi 扩展」，右侧空态的标题是同一句：两处都在
  expect(screen.getAllByText("还没有安装 pi 扩展")).toHaveLength(2);
  // 列表底部与空态里各有一个「安装扩展」入口
  expect(screen.getAllByRole("button", { name: /安装扩展/ })).toHaveLength(2);
});
