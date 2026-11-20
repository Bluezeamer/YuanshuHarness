// privacy.smoke.cjs 的引用记录断言迁移：列 / 筛选 / 目录下拉 / 行展开 / 翻页。
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { choose } from "../../../test/select";
import { type FakeApi, mount, pickRow, ref, reply } from "./testkit";

let api: FakeApi;
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const seed = () => [
  ref(1, {
    name: "github_token",
    command:
      'gh api /repos/ys/harness/pulls --header "Authorization: token {{@github_token}}"',
  }),
  ref(2, { name: "hf_token", directoryId: "ws-ft", hostId: "prod-gpu" }),
  ref(3, { name: "npm_token", result: "denied" }),
  ref(4, { name: "cf_api_token", directoryId: "ws-ft", result: "expired" }),
  ref(5, { name: "ghost", result: "unknown", runId: undefined as never }),
];

const openRefs = async (opts: Parameters<typeof mount>[0] = {}) => {
  api = await mount({ references: seed(), ...opts });
  fireEvent.click(screen.getByRole("tab", { name: /引用记录/ }));
  await screen.findByText(/条记录|读取引用记录失败/);
};
const rows = () => [...document.querySelectorAll<HTMLElement>("tr[data-ref]")];
const ids = () => rows().map((r) => r.dataset.ref);

test("列：时间 / 变量 / 目录 · 环境 / 命令（占位符原文） / 结果；新的在前；变量用 {{@名称}}", async () => {
  await openRefs();
  const heads = within(screen.getByRole("table")).getAllByRole("columnheader");
  expect(heads.map((h) => h.textContent)).toEqual([
    "时间",
    "变量",
    "目录 · 环境",
    "命令（占位符原文）",
    "结果",
  ]);
  expect(ids()).toEqual(["5", "4", "3", "2", "1"]);
  expect(rows()[4]?.textContent).toContain("{{@github_token}}");
  // 目录显示名 + 执行环境（环境 id → 连接名，本机环境显示服务端给的名字）
  expect(rows()[4]?.textContent).toContain("harness-core");
  expect(rows()[4]?.textContent).toContain("本机");
  expect(rows()[3]?.textContent).toContain("llm-finetune");
  expect(rows()[3]?.textContent).toContain("GPU 训练机");
  expect(screen.getByText(/5 条记录/)).toBeTruthy();
});

test("命令列显示占位符原文；没有命令的记录（旧记录）显示「—」", async () => {
  await openRefs();
  const cmd = (id: string) =>
    document.querySelector(`tr[data-ref="${id}"] td:nth-child(4)`);
  expect(cmd("1")?.textContent).toBe(
    'gh api /repos/ys/harness/pulls --header "Authorization: token {{@github_token}}"',
  );
  // 悬停可看全文
  expect(cmd("1")?.getAttribute("title")).toBe(cmd("1")?.textContent);
  expect(cmd("2")?.textContent).toBe("—");
  expect(cmd("2")?.hasAttribute("title")).toBe(false);
});

test("结果标签：放行 / 拒绝 / 已过期 / 名称不存在", async () => {
  await openRefs();
  const result = (id: string) =>
    document.querySelector(`tr[data-ref="${id}"] .u-chip`)?.textContent;
  expect(result("1")).toBe("放行");
  expect(result("3")).toBe("拒绝");
  expect(result("4")).toBe("已过期");
  expect(result("5")).toBe("名称不存在");
});

test("筛选 全部 / 放行 / 拒绝：拒绝 = 放行之外的全部结果", async () => {
  await openRefs();
  const chip = (label: RegExp) => screen.getByRole("button", { name: label });
  expect(chip(/^全部/).textContent).toContain("5");
  expect(chip(/^放行/).textContent).toContain("2");
  expect(chip(/^拒绝/).textContent).toContain("3");
  fireEvent.click(chip(/^放行/));
  expect(ids()).toEqual(["2", "1"]);
  fireEvent.click(chip(/^拒绝/));
  expect(ids()).toEqual(["5", "4", "3"]);
  fireEvent.click(chip(/^全部/));
  expect(ids()).toHaveLength(5);
});

test("目录下拉：向服务端按 directory 取数", async () => {
  await openRefs();
  const sel = screen.getByRole("combobox", { name: "按目录筛选" });
  fireEvent.click(sel);
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "全部目录",
    "harness-core",
    "llm-finetune",
  ]);
  fireEvent.click(sel);
  choose(sel, "ws-ft");
  await waitFor(() => expect(ids()).toEqual(["4", "2"]));
  expect(api.called("GET", /references\?directory=ws-ft/)).toHaveLength(1);
});

test("行展开：目录 / 环境 / 执行 / 工具调用 / 命令；没有值，也没有看值与复制", async () => {
  await openRefs();
  fireEvent.click(rows()[3] as HTMLElement); // ref 2：旧记录，没有命令
  const detail = document.querySelector(".vr-rdetail") as HTMLElement;
  expect(detail.textContent).toContain("llm-finetune");
  expect(detail.textContent).toContain("GPU 训练机");
  expect(detail.textContent).toContain("run-2");
  expect(detail.textContent).toContain("tc-2");
  expect(detail.querySelector(".vr-rcmd dd")?.textContent).toBe("—");
  expect(detail.querySelectorAll("button")).toHaveLength(0);
  fireEvent.click(rows()[3] as HTMLElement);
  expect(document.querySelector(".vr-rdetail")).toBeNull();
  // 有命令的记录：展开区给完整命令
  fireEvent.click(rows()[4] as HTMLElement); // ref 1
  expect(
    document.querySelector(".vr-rdetail .vr-rcmd dd")?.textContent,
  ).toContain("{{@github_token}}");
});

test("加载更早的：按 nextBefore 翻页，到头后按钮消失", async () => {
  await openRefs({ pageSize: 2 });
  expect(ids()).toEqual(["5", "4"]);
  fireEvent.click(screen.getByRole("button", { name: "加载更早的" }));
  await waitFor(() => expect(ids()).toEqual(["5", "4", "3", "2"]));
  expect(api.called("GET", /references\?before=4/)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "加载更早的" }));
  await waitFor(() => expect(ids()).toHaveLength(5));
  expect(screen.queryByRole("button", { name: "加载更早的" })).toBeNull();
});

test("空态；读取失败给出重试", async () => {
  await openRefs({ references: [] });
  expect(screen.getByText("这个筛选下还没有记录。")).toBeTruthy();
  cleanup();

  api = await mount();
  let calls = 0;
  api.on("GET /api/v1/references", () =>
    ++calls === 1 ? reply(500) : undefined,
  );
  fireEvent.click(screen.getByRole("tab", { name: /引用记录/ }));
  await screen.findByText("读取引用记录失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText(/0 条记录/);
});

test("引用记录页不出现看值 / 复制 / 增删轮换，也不向服务端写任何东西", async () => {
  await openRefs();
  const pane = screen.getByRole("tabpanel");
  for (const name of [
    "显示值",
    "查看内容",
    "复制",
    "添加变量",
    "轮换",
    "删除变量",
  ])
    expect(within(pane).queryByRole("button", { name })).toBeNull();
  expect(api.writes()).toHaveLength(0);
});

test("从变量详情的「查看记录」进来只看这个变量；点芯片清除后回到全部", async () => {
  api = await mount({ references: seed() });
  pickRow("gitlab_token");
  fireEvent.click(await screen.findByRole("button", { name: "查看记录" }));
  await screen.findByText(/条记录/);
  await waitFor(() =>
    expect(api.called("GET", /references\?name=gitlab_token/)).toHaveLength(1),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /只看 gitlab_token，点击清除/ }),
  );
  await waitFor(() => expect(ids()).toHaveLength(5));
  expect(screen.queryByRole("button", { name: /点击清除/ })).toBeNull();
});
