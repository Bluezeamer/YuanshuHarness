// 隐私变量页：左列表（按组分段、悬停卡片）、详情（草稿 + 保存条 + 离开保护）、操作（显示 / 复制 / 轮换 / 删除）、
// 添加弹窗、变量组菜单。用带状态的假服务端，断言发给服务端的请求。
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { choose } from "../../../test/select";
import { clearToasts } from "../../../ui";
import { type FakeApi, mount, pickRow, reply } from "./testkit";

let api: FakeApi;
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  clearToasts();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sections = () =>
  [...document.querySelectorAll(".st-rail-sec")].map((sec) => ({
    head: sec.querySelector(".st-rail-grp .u-lrow-label")?.textContent ?? null,
    items: [...sec.querySelectorAll(".u-hc .u-lrow-label")].map(
      (e) => e.textContent,
    ),
  }));
const trailOf = (name: string) =>
  screen
    .getByText(name, { selector: ".u-lrow-label" })
    .closest(".u-lrow")
    ?.querySelector(".u-lrow-trail")?.textContent ?? null;
const bar = () => screen.queryByRole("region", { name: "保存" });
const desc = () => screen.getByLabelText("描述") as HTMLTextAreaElement;
const typeDesc = (v: string) =>
  fireEvent.change(desc(), { target: { value: v } });
const press = async (name: string | RegExp, scope?: HTMLElement) =>
  act(async () => {
    fireEvent.click(
      (scope ? within(scope) : screen).getByRole("button", { name }),
    );
  });
const dialog = () => screen.getByRole("dialog");
const toastText = () => document.querySelector(".u-toast")?.textContent ?? "";

test("左列表按变量组分段：组按名称在前，未分组最后；行尾只在过期 / 禁止 / 未启用时出字", async () => {
  api = await mount();
  expect(sections()).toEqual([
    { head: "Git 权限", items: ["deploy_key", "github_token", "gitlab_token"] },
    { head: "云服务", items: ["aws_access_key", "oss_secret"] },
    { head: "未分组", items: ["hf_token", "legacy_pypi_token"] },
  ]);
  // 「未分组」不是真正的组：没有组头菜单可以重命名或解散
  expect(screen.queryByRole("button", { name: "未分组 的操作" })).toBeNull();
  expect(screen.getByRole("button", { name: "云服务 的操作" })).toBeTruthy();
  expect(trailOf("gitlab_token")).toBeNull();
  expect(trailOf("aws_access_key")).toBe("未启用");
  expect(trailOf("oss_secret")).toBe("已禁止");
  expect(trailOf("legacy_pypi_token")).toBe("已过期");
  expect(document.querySelector(".st-rail-h")?.textContent).toBe("变量7");
});

test("搜索命中名称或描述；没有命中的段不出现；折叠的组在搜索时自动展开", async () => {
  api = await mount();
  fireEvent.click(screen.getByText("云服务", { selector: ".u-lrow-label" }));
  expect(sections()[1]?.items).toEqual([]);
  const box = screen.getByRole("textbox", { name: "筛选名称或描述" });
  fireEvent.change(box, { target: { value: "令牌" } });
  expect(sections().flatMap((s) => s.items)).toEqual([
    "github_token",
    "gitlab_token",
    "hf_token",
    "legacy_pypi_token",
  ]);
  fireEvent.change(box, { target: { value: "aws" } });
  expect(sections()).toEqual([{ head: "云服务", items: ["aws_access_key"] }]);
  fireEvent.change(box, { target: { value: "没有这个" } });
  expect(screen.getByText("没有匹配的变量")).toBeTruthy();
});

test("默认选中列表里第一个；详情头给引用写法与状态；没引用过的不出「查看记录」", async () => {
  api = await mount();
  const head = screen.getByRole("article", { name: "deploy_key 详情" });
  expect(head.textContent).toContain("{{@deploy_key}}");
  expect(head.textContent).toContain("已启用 1 个工作区");
  expect(head.textContent).toContain("还没被引用过");
  expect(within(head).queryByRole("button", { name: "查看记录" })).toBeNull();
  pickRow("gitlab_token");
  const next = screen.getByRole("article", { name: "gitlab_token 详情" });
  expect(next.textContent).toContain("已启用 2 个工作区");
  expect(within(next).getByRole("button", { name: "查看记录" })).toBeTruthy();
});

test("改了描述才出保存条；放弃回到原值；保存只发改动的字段，并提示「已保存」", async () => {
  api = await mount();
  expect(bar()).toBeNull();
  typeDesc("新描述");
  expect(bar()).toBeTruthy();
  await press("放弃");
  expect(desc().value).toBe("部署机的 SSH 私钥。");
  expect(bar()).toBeNull();

  typeDesc("新描述");
  await press("保存");
  await waitFor(() => expect(bar()).toBeNull());
  expect(api.writes()).toEqual([
    {
      method: "PATCH",
      path: "/api/v1/variables/dk",
      body: { desc: "新描述" },
    },
  ]);
  expect(toastText()).toContain("已保存");
  expect(desc().value).toBe("新描述");
});

test("只改启用的工作区：只发 PUT /workspaces，不发 PATCH；两处都改：先 PATCH 后 PUT", async () => {
  api = await mount();
  fireEvent.click(screen.getByRole("checkbox", { name: /元枢/ }));
  expect(screen.getByText("2 / 4")).toBeTruthy();
  await press("保存");
  await waitFor(() => expect(bar()).toBeNull());
  expect(api.writes()).toEqual([
    {
      method: "PUT",
      path: "/api/v1/variables/dk/workspaces",
      body: { workspaces: ["w1", "w2"] },
    },
  ]);

  typeDesc("又改了");
  fireEvent.click(screen.getByRole("checkbox", { name: /官网/ }));
  await press("保存");
  await waitFor(() => expect(bar()).toBeNull());
  expect(api.writes().slice(1)).toEqual([
    { method: "PATCH", path: "/api/v1/variables/dk", body: { desc: "又改了" } },
    {
      method: "PUT",
      path: "/api/v1/variables/dk/workspaces",
      body: { workspaces: ["w1"] },
    },
  ]);
});

test("PATCH 失败就不发 PUT；失败提示弹出，草稿与保存条都留着", async () => {
  api = await mount();
  api.on("PATCH /api/v1/variables/dk", () => reply(500));
  typeDesc("会失败");
  fireEvent.click(screen.getByRole("checkbox", { name: /元枢/ }));
  await press("保存");
  await waitFor(() => expect(toastText()).toContain("保存失败"));
  expect(api.writes().map((c) => c.method)).toEqual(["PATCH"]);
  expect(desc().value).toBe("会失败");
  expect(bar()).toBeTruthy();
});

test("描述清空时保存：不发请求，提示要写描述", async () => {
  api = await mount();
  typeDesc("   ");
  await press("保存");
  await waitFor(() => expect(toastText()).toContain("写一句描述"));
  expect(api.writes()).toHaveLength(0);
});

test("有效期、策略、变量组都进草稿，一次保存一个 PATCH", async () => {
  api = await mount();
  pickRow("hf_token");
  fireEvent.click(screen.getByRole("radio", { name: "永久" }));
  fireEvent.click(screen.getByRole("radio", { name: "禁止" }));
  choose(screen.getByRole("combobox", { name: "变量组" }), "云服务");
  expect(bar()).toBeTruthy();
  expect(api.writes()).toHaveLength(0);
  await press("保存");
  await waitFor(() => expect(bar()).toBeNull());
  expect(api.writes()).toEqual([
    {
      method: "PATCH",
      path: "/api/v1/variables/hf",
      body: { group: "云服务", policy: "deny", expiry: { kind: "never" } },
    },
  ]);
  // 保存后它移进了「云服务」组
  expect(sections()[1]?.items).toContain("hf_token");
});

test("新建变量组：在详情里输入组名回车，保存后列表里长出这个组；选「不分组」得到 null", async () => {
  api = await mount();
  pickRow("hf_token");
  choose(screen.getByRole("combobox", { name: "变量组" }), " new");
  const input = screen.getByRole("textbox", { name: "新变量组名称" });
  fireEvent.change(input, { target: { value: "模型相关" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await press("保存");
  await waitFor(() => expect(bar()).toBeNull());
  expect(api.writes()[0]?.body).toEqual({ group: "模型相关" });
  expect(sections().map((s) => s.head)).toContain("模型相关");

  choose(screen.getByRole("combobox", { name: "变量组" }), " none");
  await press("保存");
  await waitFor(() => expect(bar()).toBeNull());
  expect(api.writes()[1]?.body).toEqual({ group: null });
  expect(sections().map((s) => s.head)).not.toContain("模型相关");
});

test("有未保存的修改时切换变量：取消留在原处，放弃修改才切，保存成功后切", async () => {
  api = await mount();
  typeDesc("没保存");
  pickRow("gitlab_token");
  expect(dialog().textContent).toContain("有未保存的修改");
  expect(screen.getByRole("article", { name: "deploy_key 详情" })).toBeTruthy();
  await press("取消", dialog());
  expect(desc().value).toBe("没保存");

  pickRow("gitlab_token");
  await press("放弃修改", dialog());
  expect(
    screen.getByRole("article", { name: "gitlab_token 详情" }),
  ).toBeTruthy();
  expect(api.writes()).toHaveLength(0);
  pickRow("deploy_key");
  expect(desc().value).toBe("部署机的 SSH 私钥。");

  typeDesc("要保存");
  pickRow("github_token");
  await press("保存", dialog());
  await waitFor(() =>
    expect(
      screen.getByRole("article", { name: "github_token 详情" }),
    ).toBeTruthy(),
  );
  expect(api.writes()[0]?.body).toEqual({ desc: "要保存" });
});

test("切到「引用记录」页签同样走离开保护", async () => {
  api = await mount();
  typeDesc("没保存");
  fireEvent.click(screen.getByRole("tab", { name: "引用记录" }));
  expect(dialog().textContent).toContain("有未保存的修改");
  await press("放弃修改", dialog());
  await screen.findByText(/条记录/);
});

test("显示值：向服务端取明文，8 秒后自动重新遮挡；隐藏立即遮挡", async () => {
  api = await mount();
  pickRow("hf_token");
  const field = () =>
    screen.getByRole("textbox", { name: "值" }) as HTMLInputElement;
  expect(field().value).toBe("••••••••abcd");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await press("显示");
  expect(api.called("POST", /\/hf\/reveal$/)).toHaveLength(1);
  expect(field().value).toBe("plain-hf_token-0000");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8100);
  });
  expect(field().value).toBe("••••••••abcd");
  await press("显示");
  await press("隐藏");
  expect(field().value).toBe("••••••••abcd");
});

test("复制：先向服务端取明文再写剪贴板，提示「已复制」；这是操作，不出保存条", async () => {
  api = await mount();
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  pickRow("hf_token");
  await press("复制");
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith("plain-hf_token-0000"),
  );
  expect(toastText()).toContain("已复制");
  expect(bar()).toBeNull();
});

test("轮换：弹窗里填新值，POST /rotate；成功提示并关弹窗，不出保存条", async () => {
  api = await mount();
  pickRow("hf_token");
  await press("轮换");
  const d = dialog();
  fireEvent.change(within(d).getByPlaceholderText("粘贴要托管的值"), {
    target: { value: "brand-new-value" },
  });
  await press("轮换", d);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.called("POST", /\/hf\/rotate$/)[0]?.body).toEqual({
    value: "brand-new-value",
  });
  expect(toastText()).toContain("已轮换");
  expect(bar()).toBeNull();
});

test("值太短的变量：详情里提醒回显遮挡不住", async () => {
  api = await mount({
    variables: [
      {
        ...(await import("./testkit")).variable("sudo_pw"),
        id: "sp",
        maskable: false,
      },
    ],
  });
  expect(screen.getByText(/值少于 8 个字符/)).toBeTruthy();
});

test("添加变量：填名称 / 描述 / 值，在二级页里勾工作区、选新组；POST 带上组与启用的工作区", async () => {
  api = await mount();
  fireEvent.click(screen.getByRole("button", { name: "添加变量" }));
  const d = dialog();
  fireEvent.change(within(d).getByPlaceholderText("hf_token"), {
    target: { value: "new_token" },
  });
  fireEvent.change(within(d).getByLabelText("描述"), {
    target: { value: "新令牌，什么时候用" },
  });
  fireEvent.change(within(d).getByPlaceholderText("粘贴要托管的值"), {
    target: { value: "secret-value-123" },
  });
  choose(within(d).getByRole("combobox", { name: "变量组" }), " new");
  fireEvent.change(within(d).getByRole("textbox", { name: "新变量组名称" }), {
    target: { value: "新组" },
  });
  // 摘要行默认值直接写在行上
  expect(d.textContent).toContain("每次批准");
  expect(d.textContent).toContain("30 天后到期");
  expect(d.textContent).toContain("暂不启用");
  fireEvent.click(within(d).getByRole("button", { name: /启用于工作区/ }));
  fireEvent.click(within(d).getByRole("checkbox", { name: /官网/ }));
  fireEvent.click(within(d).getByRole("checkbox", { name: /元枢/ }));
  await press("完成", d);
  expect(d.textContent).toContain("2 个工作区");
  await press("添加变量", d);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.writes()[0]).toEqual({
    method: "POST",
    path: "/api/v1/variables",
    body: {
      name: "new_token",
      desc: "新令牌，什么时候用",
      group: "新组",
      workspaces: ["w1", "w2"],
      kind: "text",
      value: "secret-value-123",
      policy: "ask",
      expiry: { kind: "days", days: 30 },
    },
  });
  // 新加的变量被选中，并出现在新组里
  expect(screen.getByRole("article", { name: "new_token 详情" })).toBeTruthy();
  expect(sections().map((s) => s.head)).toContain("新组");
});

test("添加变量：前端先校验名称与描述；服务端说名称被占用时留在弹窗里", async () => {
  api = await mount();
  fireEvent.click(screen.getByRole("button", { name: "添加变量" }));
  const d = dialog();
  await press("添加变量", d);
  expect(d.textContent).toContain("名称需小写字母开头");
  expect(api.writes()).toHaveLength(0);

  fireEvent.change(within(d).getByPlaceholderText("hf_token"), {
    target: { value: "hf_token" },
  });
  fireEvent.change(within(d).getByLabelText("描述"), {
    target: { value: "重名" },
  });
  fireEvent.change(within(d).getByPlaceholderText("粘贴要托管的值"), {
    target: { value: "secret-value-123" },
  });
  await press("添加变量", d);
  await waitFor(() => expect(d.textContent).toContain("这个名称已被占用"));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("删除变量：详情里的菜单与列表行的菜单都先确认；确认框写明连带取消的启用", async () => {
  api = await mount();
  pickRow("hf_token");
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除变量" }));
  expect(dialog().textContent).toContain("它在 4 个工作区里的启用也一并取消");
  await press("取消", dialog());
  expect(api.writes()).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "oss_secret 的操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除变量" }));
  await press("删除", dialog());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.writes()).toEqual([
    { method: "DELETE", path: "/api/v1/variables/oss", body: undefined },
  ]);
  expect(sections()[1]?.items).toEqual(["aws_access_key"]);
});

test("组头菜单：重命名走 PUT（改到已有的组名会提示合并）；解散走 DELETE，成员回到未分组", async () => {
  api = await mount();
  fireEvent.click(screen.getByRole("button", { name: "云服务 的操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名变量组" }));
  const d = dialog();
  const input = within(d).getByRole("textbox") as HTMLInputElement;
  expect(input.value).toBe("云服务");
  fireEvent.change(input, { target: { value: "Git 权限" } });
  expect(d.textContent).toContain("已有同名的组，改完会合并到它");
  fireEvent.change(input, { target: { value: "云厂商" } });
  await press("改名", d);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.writes()[0]).toEqual({
    method: "PUT",
    path: `/api/v1/variable-groups/${encodeURIComponent("云服务")}`,
    body: { name: "云厂商" },
  });
  expect(sections().map((s) => s.head)).toEqual([
    "Git 权限",
    "云厂商",
    "未分组",
  ]);

  fireEvent.click(screen.getByRole("button", { name: "云厂商 的操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "解散变量组" }));
  expect(dialog().textContent).toContain("回到「未分组」");
  await press("解散", dialog());
  await waitFor(() =>
    expect(sections().map((s) => s.head)).toEqual(["Git 权限", "未分组"]),
  );
  expect(api.writes()[1]?.method).toBe("DELETE");
  expect(sections()[1]?.items).toContain("aws_access_key");
});

test("悬停详情卡片：停留后浮出，放行里没有的信息（描述全文、所属组、启用的工作区名）", async () => {
  api = await mount();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const row = screen
    .getByText("gitlab_token", { selector: ".u-lrow-label" })
    .closest(".u-hc") as HTMLElement;
  fireEvent.pointerEnter(row);
  act(() => {
    vi.advanceTimersByTime(500);
  });
  const card = screen.getByRole("tooltip");
  expect(card.textContent).toContain(
    "GitLab 访问令牌：克隆和推送公司私有仓库。",
  );
  expect(card.textContent).toContain("Git 权限");
  expect(card.textContent).toContain("元枢、官网");
  expect(card.textContent).toContain("每次批准");
  fireEvent.pointerLeave(row);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("没有变量：左列表与详情区都有空态，添加入口可用", async () => {
  api = await mount({ variables: [] });
  expect(screen.getByText("还没有变量")).toBeTruthy();
  expect(screen.getByText("还没有隐私变量")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "添加变量" })).toHaveLength(2);
});

test("读取失败给出重试", async () => {
  const failing = (await import("./testkit")).fakeApi();
  failing.on("GET /api/v1/variables", () => reply(500));
  vi.stubGlobal("fetch", failing.fetchMock);
  const { render } = await import("@testing-library/react");
  const { VariablesPage } = await import("./VariablesPage");
  render(<VariablesPage />);
  await screen.findByText("读取隐私变量失败");
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});

test("旧的东西没有了：没有范围栏、服务端凭据块、吊销与策略筛选", async () => {
  api = await mount();
  for (const text of ["服务端凭据", "全局变量", "吊销值", "按名称聚合"])
    expect(screen.queryByText(text)).toBeNull();
  expect(
    screen.queryByRole("radio", { name: "自动放行", checked: true }),
  ).toBeNull();
});
