import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { clearToasts } from "../../../../ui";
import { fakeFetch, mountPage, reply } from "../common/testkit";
import { toolsRoutes } from "./testkit";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
});

async function mount() {
  const api = toolsRoutes();
  const fake = fakeFetch(api.route);
  await mountPage(fake);
  await screen.findByRole("region", { name: "文件与命令" });
  return { fake, api };
}

const region = (name: string) => screen.getByRole("region", { name });
const pick = (tool: string, axis: string, policy: string) =>
  fireEvent.click(
    within(
      screen.getByRole("radiogroup", { name: `${tool} ${axis}` }),
    ).getByRole("radio", { name: policy }),
  );
const checked = (tool: string, axis: string) =>
  within(screen.getByRole("radiogroup", { name: `${tool} ${axis}` }))
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;
const bar = () => screen.queryByRole("region", { name: "保存" });
const save = () =>
  fireEvent.click(
    within(bar() as HTMLElement).getByRole("button", { name: "保存" }),
  );
const menu = (name: string, item: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};
const puts = (fake: {
  called: (m: string, re: RegExp) => { body: unknown }[];
}) => fake.called("PUT", /\/tools\/rules$/);

test("按用途分组；框架工具组默认折起，展开后是只读的固定规则", async () => {
  await mount();
  expect(
    screen.getAllByRole("region").map((r) => r.getAttribute("aria-label")),
  ).toEqual(["文件与命令", "目录与传输", "编排与委派", "浏览器", "框架工具"]);
  expect(screen.queryByText("todo_write")).toBeNull();
  fireEvent.click(
    within(region("框架工具")).getByRole("button", { name: "展开" }),
  );
  expect(within(region("框架工具")).getByText("todo_write")).toBeTruthy();
  expect(within(region("框架工具")).getByText("自身放行")).toBeTruthy();
  // 框架工具里的 switch_mode 是可调的
  expect(
    screen.getByRole("radiogroup", { name: "switch_mode 审批" }),
  ).toBeTruthy();
});

test("路径类工具 cwd 内外各一档；其余一个开关；固定规则只有文字", async () => {
  await mount();
  expect(checked("read", "cwd 内")).toBe("放行");
  expect(checked("read", "cwd 外")).toBe("审批");
  expect(checked("list_directories", "审批")).toBe("放行");
  expect(checked("workflow_run", "审批")).toBe("审批");
  expect(
    screen.queryByRole("radiogroup", { name: "list_directories cwd 内" }),
  ).toBeNull();
  expect(
    screen.queryByRole("radiogroup", { name: /transfer_files/ }),
  ).toBeNull();
  expect(
    within(region("目录与传输")).getByText(/源端按 read、目标端按 write/),
  ).toBeTruthy();
});

test("改了进草稿：不发请求、出保存条和「已修改」；点保存才落，只发改动的那一项", async () => {
  const { fake } = await mount();
  expect(bar()).toBeNull();
  pick("read", "cwd 外", "放行");
  expect(bar()).toBeTruthy();
  expect(within(region("文件与命令")).getByText("已修改")).toBeTruthy();
  expect(fake.writes()).toHaveLength(0);
  save();
  await waitFor(() => expect(puts(fake)).toHaveLength(1));
  expect(puts(fake)[0]?.body).toEqual({
    rules: { read: { inside: "allow", outside: "allow" } },
  });
  await waitFor(() => expect(bar()).toBeNull());
  expect(await screen.findByText("已保存")).toBeTruthy();
});

test("单开关工具两格一起写", async () => {
  const { fake } = await mount();
  pick("spawn_subagent", "审批", "审批");
  save();
  await waitFor(() => expect(puts(fake)).toHaveLength(1));
  expect(puts(fake)[0]?.body).toEqual({
    rules: { spawn_subagent: { inside: "ask", outside: "ask" } },
  });
});

test("组头批量：全部放行含 cwd 内外；保存只发真正变了的项", async () => {
  const { fake } = await mount();
  menu("浏览器 的批量设置", /^全部放行/);
  expect(checked("browser_open", "审批")).toBe("放行");
  save();
  await waitFor(() => expect(puts(fake)).toHaveLength(1));
  // browser_snapshot 本来就是放行，不在请求里
  expect(puts(fake)[0]?.body).toEqual({
    rules: { browser_open: { inside: "allow", outside: "allow" } },
  });
  await waitFor(() => expect(bar()).toBeNull());

  menu("文件与命令 的批量设置", /^全部审批/);
  expect(checked("read", "cwd 内")).toBe("审批");
  expect(checked("write", "cwd 外")).toBe("审批");
  menu("文件与命令 的批量设置", /^全部恢复出厂/);
  expect(checked("read", "cwd 内")).toBe("放行");
  expect(bar()).toBeNull();
});

test("行菜单恢复出厂：回到出厂值，保存条随之消失", async () => {
  await mount();
  pick("bash", "cwd 内", "放行");
  expect(bar()).toBeTruthy();
  menu("bash 的操作", /^恢复出厂/);
  expect(checked("bash", "cwd 内")).toBe("审批");
  expect(bar()).toBeNull();
});

test("搜索过滤分组；没有命中给空状态", async () => {
  await mount();
  fireEvent.change(screen.getByLabelText("搜索工具"), {
    target: { value: "browser" },
  });
  expect(
    screen.getAllByRole("region").map((r) => r.getAttribute("aria-label")),
  ).toEqual(["浏览器"]);
  fireEvent.change(screen.getByLabelText("搜索工具"), {
    target: { value: "没有这个工具" },
  });
  expect(screen.getByText("没有匹配的工具")).toBeTruthy();
});

test("保存失败：草稿与保存条保留，失败原因弹出来", async () => {
  const { fake } = await mount();
  fake.override((m, p) =>
    m === "PUT" && p.endsWith("/tools/rules")
      ? reply(400, { error: "invalid_rule", message: "read 不可调整" })
      : undefined,
  );
  pick("read", "cwd 外", "放行");
  save();
  expect(await screen.findByText("保存失败：read 不可调整")).toBeTruthy();
  expect(bar()).toBeTruthy();
  expect(checked("read", "cwd 外")).toBe("放行");
});
