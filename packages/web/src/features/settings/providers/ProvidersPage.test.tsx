import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProviderView } from "../../../api/providers";
import { choose, selectedValue } from "../../../test/select";
import { clearToasts, ToastHost } from "../../../ui";
import { LeaveGuardProvider } from "../frame/leave";
import { ProvidersPage } from "./ProvidersPage";
import {
  builtin,
  custom,
  type FakeApi,
  fakeApi,
  model,
  mount,
  okResult,
  patchesOf,
  ready,
  reply,
} from "./testkit";

let api: FakeApi;
const setup = async (list?: Parameters<typeof mount>[0]) => {
  api = await mount(list);
};
const patches = () => patchesOf(api);

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
});

const field = (name: string) => screen.getByRole("textbox", { name });
// 改了只进草稿；点「保存」才发请求（X06）
const edit = (name: string, value: string) =>
  fireEvent.change(field(name), { target: { value } });
const bar = () => screen.queryByRole("region", { name: "保存" });
const save = () =>
  fireEvent.click(
    within(bar() as HTMLElement).getByRole("button", { name: "保存" }),
  );
const heading = () =>
  screen.getByRole("article").querySelector(".st-dh .t-block")?.textContent;
const rail = () => screen.getByRole("complementary", { name: "供应商" });
// 行本身（不含行尾「⋯」菜单的触发按钮）
const railRows = (re: RegExp) =>
  within(rail())
    .queryAllByRole("button", { name: re })
    .filter((b) => !/的操作$/.test(b.getAttribute("aria-label") ?? ""));
const railRow = (re: RegExp) => railRows(re)[0] as HTMLElement;
const rowMenu = (name: string, item: string) => {
  fireEvent.click(
    within(rail()).getByRole("button", { name: `${name} 的操作` }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};
const openAdvanced = () =>
  fireEvent.click(screen.getByRole("button", { name: "展开高级设置" }));
const openAdd = () =>
  fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
const pickCustom = async () => {
  openAdd();
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: /自定义端点/,
    }),
  );
};

// ---- 左侧列表与添加 ----

test("左侧只列添加过的：自定义端点与已添加的内置；默认选中第一项", async () => {
  await setup([custom("vllm"), ready("anthropic"), builtin("zeta")]);
  expect(heading()).toBe("自建 vllm");
  expect(railRow(/自建 vllm/)).toBeTruthy();
  expect(railRow(/Anthropic/)).toBeTruthy();
  expect(railRows(/Zeta/)).toHaveLength(0);
});

test("添加供应商：挑内置的出现在左边并选中；已在左边的点不了；可搜索", async () => {
  await setup([custom("vllm"), ready("anthropic"), builtin("zeta")]);
  openAdd();
  const d = within(await screen.findByRole("dialog"));
  expect(d.getByText("Anthropic").closest("[aria-disabled]")).toBeTruthy();
  fireEvent.change(d.getByRole("textbox", { name: "搜索内置供应商" }), {
    target: { value: "ze" },
  });
  expect(d.queryByText("Anthropic")).toBeNull();
  fireEvent.click(d.getByText("Zeta"));
  await waitFor(() => expect(heading()).toBe("Zeta"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    within(railRow(/Zeta/)).getByRole("img").getAttribute("aria-label"),
  ).toBe("未配置");
  expect(api.writes()).toHaveLength(0);
});

test("支持订阅登录的内置供应商，在添加列表里标出来", async () => {
  await setup([
    custom("vllm"),
    builtin("openai", { methods: ["oauth", "key"] }),
  ]);
  openAdd();
  const d = within(await screen.findByRole("dialog"));
  expect(d.getByRole("button", { name: /Openai/ }).textContent).toContain(
    "支持订阅登录",
  );
});

test("一个供应商都没有：给出空态和添加入口", async () => {
  api = fakeApi([builtin("zeta")]);
  vi.stubGlobal("fetch", api.fetchMock);
  render(<ProvidersPage />);
  expect(await screen.findByText("还没有可用的供应商")).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "添加供应商" }).length,
  ).toBeGreaterThan(0);
});

test("列表行的状态点带读屏名：已连接 / 待核验 / 连接失败", async () => {
  await setup([
    custom("vllm", { status: "warn" }),
    ready("anthropic"),
    custom("bad", {
      status: "warn",
      lastTest: {
        at: "t",
        ok: false,
        ttft: 0,
        total: 0,
        stage: "endpoint",
        errorCode: "unreachable",
      },
    }),
  ]);
  const dot = (re: RegExp) =>
    within(railRow(re)).getByRole("img").getAttribute("aria-label");
  expect(dot(/自建 vllm/)).toBe("待核验");
  expect(dot(/Anthropic/)).toBe("已连接");
  expect(dot(/自建 bad/)).toBe("连接失败");
});

test("加载失败给出重试，重试成功后进入列表", async () => {
  api = fakeApi([custom("vllm")]);
  let first = true;
  api.on("GET /api/v1/providers", () => {
    if (!first) return undefined;
    first = false;
    return reply(500, { error: "boom" });
  });
  vi.stubGlobal("fetch", api.fetchMock);
  render(<ProvidersPage />);
  expect(await screen.findByText("读取供应商失败")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("article");
  expect(heading()).toBe("自建 vllm");
});

test("页内没有重复 id（label/aria 接线不撞车）", async () => {
  await setup();
  openAdvanced();
  const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
});

// ---- 新建与移除自定义端点 ----

test("新建端点：空表单被前端拦住，不发请求", async () => {
  await setup();
  await pickCustom();
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "保存端点" }));
  expect(within(dialog).getByText(/名称不能为空/)).toBeTruthy();
  expect(within(dialog).getByText(/Base URL 无效/)).toBeTruthy();
  expect(api.writes()).toHaveLength(0);
});

test("新建端点：标识跟随名称推导，成功后选中新端点，是待核验", async () => {
  await setup();
  await pickCustom();
  const d = within(await screen.findByRole("dialog"));
  fireEvent.change(d.getByPlaceholderText("例：团队 vLLM 网关"), {
    target: { value: "Local Ollama" },
  });
  expect((d.getByPlaceholderText("team-vllm") as HTMLInputElement).value).toBe(
    "local-ollama",
  );
  fireEvent.change(d.getByPlaceholderText("端点地址，如 host/v1"), {
    target: { value: "http://localhost:11434/v1" },
  });
  fireEvent.click(d.getByRole("button", { name: "保存端点" }));
  await waitFor(() => expect(heading()).toBe("Local Ollama"));
  expect(api.writes()[0]?.body).toMatchObject({
    name: "Local Ollama",
    slug: "local-ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    within(railRow(/Local Ollama/))
      .getByRole("img")
      .getAttribute("aria-label"),
  ).toBe("待核验");
});

test("新建端点：标识重复时错误落在标识字段，弹窗保持打开", async () => {
  await setup();
  await pickCustom();
  const d = within(await screen.findByRole("dialog"));
  fireEvent.change(d.getByPlaceholderText("例：团队 vLLM 网关"), {
    target: { value: "vllm" },
  });
  fireEvent.change(d.getByPlaceholderText("端点地址，如 host/v1"), {
    target: { value: "http://x/v1" },
  });
  fireEvent.click(d.getByRole("button", { name: "保存端点" }));
  expect(await d.findByText(/已被其他供应商占用/)).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("删除自定义端点要在确认弹窗里确认，成功后从列表消失", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  expect(api.writes()).toHaveLength(0);
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "删除",
    }),
  );
  await waitFor(() => expect(api.writes()[0]?.method).toBe("DELETE"));
  await waitFor(() => expect(heading()).toBe("Anthropic"));
});

test("删除被 Agent 占用的端点：弹窗里显示原因并保留", async () => {
  await setup();
  api.on("DELETE /api/v1/providers/vllm", () =>
    reply(409, { error: "in_use" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "删除",
    }),
  );
  expect(await screen.findByText(/还有 Agent 在使用/)).toBeTruthy();
  expect(heading()).toBe("自建 vllm");
});

const openDelete = () => {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
};

test("删除内置供应商：确认后回到未配置，从左侧消失并选中下一个", async () => {
  await setup([
    custom("vllm"),
    ready("anthropic", { models: [model("claude-x")] }),
  ]);
  fireEvent.click(railRow(/Anthropic/));
  expect(heading()).toBe("Anthropic");
  openDelete();
  expect(api.writes()).toHaveLength(0);
  const d = within(await screen.findByRole("dialog"));
  expect(d.getByText(/它从左侧列表消失/)).toBeTruthy();
  fireEvent.click(d.getByRole("button", { name: "删除" }));
  await waitFor(() => expect(api.writes()[0]?.method).toBe("DELETE"));
  expect(api.writes()[0]?.path).toBe("/api/v1/providers/anthropic");
  await waitFor(() => expect(heading()).toBe("自建 vllm"));
  expect(railRows(/Anthropic/)).toHaveLength(0);
  // 删掉的供应商还在「添加供应商」里能再选回来
  openAdd();
  expect(
    await within(await screen.findByRole("dialog")).findByText("Anthropic"),
  ).toBeTruthy();
});

test("只有环境变量凭据的内置供应商不在左边；删除一个内置供应商后即使环境凭据还在也从左边消失", async () => {
  const envCred = {
    source: "env" as const,
    detail: "ANTHROPIC_AUTH_TOKEN",
    chain: (["--api-key", "auth.json", "models.json", "env"] as const).map(
      (source) => ({ source, hit: source === "env" }),
    ),
  };
  await setup([
    custom("vllm"),
    ready("anthropic", { credential: envCred }),
    builtin("deepseek", { status: "ok", credential: envCred }),
  ]);
  // 没添加过的 deepseek 只有环境凭据：不上架
  expect(railRows(/Deepseek/)).toHaveLength(0);
  fireEvent.click(railRow(/Anthropic/));
  openDelete();
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "删除",
    }),
  );
  await waitFor(() => expect(api.writes()[0]?.method).toBe("DELETE"));
  await waitFor(() => expect(heading()).toBe("自建 vllm"));
  expect(railRows(/Anthropic/)).toHaveLength(0);
});

test("删除内置供应商失败：弹窗里显示原因并保留", async () => {
  await setup([custom("vllm"), ready("anthropic")]);
  api.on("DELETE /api/v1/providers/anthropic", () =>
    reply(500, { error: "internal" }),
  );
  fireEvent.click(railRow(/Anthropic/));
  openDelete();
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "删除",
    }),
  );
  await waitFor(() => expect(api.writes()[0]?.method).toBe("DELETE"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(heading()).toBe("Anthropic");
});

// ---- 左列表：悬停卡片、行菜单、搜索 ----

test("左列表带搜索框，按名称、标识或协议筛；筛不到时给出说明", async () => {
  await setup([custom("vllm"), ready("anthropic")]);
  const q = within(rail()).getByRole("textbox", { name: "筛选名称或协议" });
  fireEvent.change(q, { target: { value: "anth" } });
  expect(railRows(/Anthropic/)).toHaveLength(1);
  expect(railRows(/自建 vllm/)).toHaveLength(0);
  fireEvent.change(q, { target: { value: "没有这个" } });
  expect(within(rail()).getByText("没有匹配的供应商")).toBeTruthy();
});

test("行菜单：测试连接（总是测已保存的配置）与删除", async () => {
  await setup([custom("vllm"), ready("anthropic")]);
  rowMenu("Anthropic", "测试连接");
  await waitFor(() =>
    expect(api.writes().some((c) => c.path.endsWith("/anthropic/test"))).toBe(
      true,
    ),
  );
  expect(await screen.findByText(/连接成功/)).toBeTruthy();
  rowMenu("Anthropic", "删除");
  expect(
    await screen.findByRole("dialog", { name: "删除「Anthropic」" }),
  ).toBeTruthy();
});

// ---- 连接：改了进草稿，点保存才发 ----

test("改了进草稿：不发请求、出保存条；点保存只发改动的字段", async () => {
  await setup();
  expect(bar()).toBeNull();
  edit("Base URL", "http://10.0.0.9:9000/v1");
  expect(bar()).toBeTruthy();
  expect(patches()).toHaveLength(0);
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]).toMatchObject({
    path: "/api/v1/providers/vllm",
    body: { baseUrl: "http://10.0.0.9:9000/v1" },
  });
  await waitFor(() => expect(bar()).toBeNull());
  expect(await screen.findByText("已保存")).toBeTruthy();
});

test("放弃：回到已保存的值，不发请求", async () => {
  await setup();
  edit("Base URL", "http://changed/v1");
  fireEvent.click(
    within(bar() as HTMLElement).getByRole("button", { name: "放弃" }),
  );
  expect((field("Base URL") as HTMLInputElement).value).toBe(
    "http://10.0.0.9:8000/v1",
  );
  expect(bar()).toBeNull();
  expect(patches()).toHaveLength(0);
});

test("服务端拒绝：提示翻成人话，输入与保存条都留着", async () => {
  await setup();
  api.on("PATCH /api/v1/providers/vllm", () =>
    reply(400, { error: "invalid_base_url" }),
  );
  edit("Base URL", "not-a-url");
  save();
  expect(await screen.findByText(/保存失败：Base URL 无效/)).toBeTruthy();
  expect((field("Base URL") as HTMLInputElement).value).toBe("not-a-url");
  expect(bar()).toBeTruthy();
});

test("有未保存的修改时换供应商先问；放弃后换过去，原来那个没变", async () => {
  api = fakeApi([custom("vllm"), ready("anthropic")]);
  vi.stubGlobal("fetch", api.fetchMock);
  render(
    <LeaveGuardProvider>
      <ProvidersPage />
      <ToastHost />
    </LeaveGuardProvider>,
  );
  await screen.findByRole("article");
  edit("Base URL", "http://changed/v1");
  fireEvent.click(railRow(/Anthropic/));
  const d = within(
    await screen.findByRole("dialog", { name: "有未保存的修改" }),
  );
  expect(heading()).toBe("自建 vllm");
  fireEvent.click(d.getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(heading()).toBe("Anthropic"));
  expect(patches()).toHaveLength(0);
});

test("行菜单测试当前选中、且有未保存修改的供应商：先问；测别的供应商不问", async () => {
  api = fakeApi([custom("vllm"), ready("anthropic")]);
  vi.stubGlobal("fetch", api.fetchMock);
  render(
    <LeaveGuardProvider>
      <ProvidersPage />
      <ToastHost />
    </LeaveGuardProvider>,
  );
  await screen.findByRole("article");
  const tested = (id: string) =>
    api.writes().some((c) => c.path.endsWith(`/${id}/test`));
  edit("Base URL", "http://changed/v1");
  rowMenu("Anthropic", "测试连接");
  await waitFor(() => expect(tested("anthropic")).toBe(true));
  expect(screen.queryByRole("dialog", { name: "有未保存的修改" })).toBeNull();
  rowMenu("自建 vllm", "测试连接");
  const d = within(
    await screen.findByRole("dialog", { name: "有未保存的修改" }),
  );
  expect(tested("vllm")).toBe(false);
  fireEvent.click(d.getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(tested("vllm")).toBe(true));
});

test("自定义端点：名称与请求协议一起改，一次 PATCH；名称留空就地提示、保存被拦住", async () => {
  await setup();
  edit("名称", "团队网关");
  const sel = screen.getByRole("combobox", { name: "请求协议" });
  expect(selectedValue(sel)).toBe("openai-completions");
  choose(sel, "anthropic-messages");
  expect(patches()).toHaveLength(0);
  edit("名称", "  ");
  expect(await screen.findByText(/名称不能为空/)).toBeTruthy();
  save();
  expect(await screen.findByText(/保存失败：名称不能为空/)).toBeTruthy();
  expect(patches()).toHaveLength(0);
  edit("名称", "团队网关");
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({
    name: "团队网关",
    api: "anthropic-messages",
  });
});

test("API Key：已保存显示成一行，更换时键入的密钥进草稿、保存后回到已保存，密钥不回显", async () => {
  await setup();
  expect(screen.queryByPlaceholderText("输入新密钥以更换")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更换" }));
  const key = screen.getByPlaceholderText(
    "输入新密钥以更换",
  ) as HTMLInputElement;
  expect(key.type).toBe("password");
  fireEvent.change(key, { target: { value: "sk-secret" } });
  expect(patches()).toHaveLength(0);
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({ apiKey: "sk-secret" });
  await waitFor(() =>
    expect(screen.queryByPlaceholderText("输入新密钥以更换")).toBeNull(),
  );
  expect(document.body.textContent).not.toContain("sk-secret");
});

test("API Key：移除是动作，立即执行，回到输入框", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "移除" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({ apiKey: null });
  expect(await screen.findByPlaceholderText("粘贴密钥")).toBeTruthy();
  expect(await screen.findByText("已移除密钥")).toBeTruthy();
});

test("有订阅登录的内置供应商才有「登录方式」；自定义端点没有", async () => {
  await setup([custom("vllm"), ready("anthropic")]);
  expect(screen.queryByRole("radiogroup", { name: "登录方式" })).toBeNull();
  fireEvent.click(railRow(/Anthropic/));
  const g = within(screen.getByRole("radiogroup", { name: "登录方式" }));
  expect(
    g.getByRole("radio", { name: "API Key" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(g.getByRole("radio", { name: "订阅登录" })).toBeTruthy();
});

test("切到订阅登录：进草稿，点保存才发 method；没登录时出现「登录」按钮并打开登录弹窗", async () => {
  await setup([
    ready("anthropic", {
      credential: {
        source: null,
        chain: [{ source: "auth.json", hit: false }],
      },
    }),
  ]);
  fireEvent.click(screen.getByRole("radio", { name: "订阅登录" }));
  expect(patches()).toHaveLength(0);
  fireEvent.click(await screen.findByRole("button", { name: "登录" }));
  expect(
    await screen.findByRole("dialog", { name: /登录 Anthropic/ }),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({ method: "oauth" });
});

test("已登录的订阅：显示已登录；退出登录是动作，调接口后回到 API Key", async () => {
  await setup([ready("anthropic", { method: "oauth", hasKey: false })]);
  expect(screen.getByText("已登录")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  await waitFor(() =>
    expect(api.writes().some((c) => c.path.endsWith("/logout"))).toBe(true),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("radio", { name: "API Key" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
});

test("环境变量方式对内置供应商只读：显示变量名、没有密钥输入框；「改为直接填写」进草稿", async () => {
  await setup([
    ready("anthropic", {
      method: "env",
      envVariable: "ANTHROPIC_API_KEY",
      hasKey: false,
    }),
  ]);
  expect(
    (screen.getByRole("textbox", { name: "环境变量" }) as HTMLInputElement)
      .value,
  ).toBe("$ANTHROPIC_API_KEY");
  expect(screen.queryByPlaceholderText("粘贴密钥")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "改为直接填写" }));
  expect(patches()).toHaveLength(0);
  expect(screen.getByPlaceholderText("粘贴密钥")).toBeTruthy();
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({ method: "key" });
});

test("内置供应商：地址可覆盖，「恢复默认」进草稿、保存发 null；没有名称、协议、标识可改", async () => {
  await setup([ready("anthropic")]);
  expect(screen.queryByRole("textbox", { name: "名称" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "请求协议" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "恢复默认" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  edit("Base URL", "https://eu.example/v1");
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({ baseUrl: "https://eu.example/v1" });
  await waitFor(() => expect(bar()).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  expect(patches()).toHaveLength(1);
  save();
  await waitFor(() => expect(patches()).toHaveLength(2));
  expect(patches()[1]?.body).toEqual({ baseUrl: null });
  openAdvanced();
  expect(screen.queryByRole("textbox", { name: "标识" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^协议兼容/ })).toBeNull();
});

test("内置供应商只读字段即使被服务端拒绝也有可读提示", async () => {
  await setup([ready("anthropic")]);
  api.on("PATCH /api/v1/providers/anthropic", () =>
    reply(400, { error: "builtin_immutable" }),
  );
  edit("Base URL", "https://x.example/v1");
  save();
  expect(
    await screen.findByText(/内置供应商的名称、标识、协议和环境变量名不可修改/),
  ).toBeTruthy();
});

test("凭据来源在连接里：写明生效的一层，点开看四层查找顺序", async () => {
  await setup();
  expect(screen.getByText("auth.json / 密码库")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看顺序" }));
  const d = within(await screen.findByRole("dialog"));
  const items = within(
    d.getByRole("list", { name: "凭据查找链" }),
  ).getAllByRole("listitem");
  expect(items).toHaveLength(4);
  expect(items.filter((i) => i.hasAttribute("data-effective"))).toHaveLength(1);
  expect(d.getByText(/当前生效/).textContent).toContain("auth.json");
});

// ---- 高级 ----

test("高级默认折起，点开才能操作；标识只有自定义端点有", async () => {
  await setup();
  const btn = screen.getByRole("button", { name: "展开高级设置" });
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("textbox", { name: "标识" })).toBeNull();
  openAdvanced();
  expect(
    screen
      .getByRole("button", { name: "收起高级设置" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect((field("标识") as HTMLInputElement).value).toBe("vllm");
});

test("高级里有填错的项时不能收起", async () => {
  await setup();
  openAdvanced();
  edit("最大并发请求数", "0");
  expect(await screen.findByText(/1 到 1000/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起高级设置" }));
  expect(screen.getByLabelText("最大并发请求数")).toBeTruthy();
});

test("密钥保存位置：只有密码库和仅本次运行两项，不再有 models.json；进草稿、保存才发", async () => {
  await setup([custom("vllm", { keyStorage: "auth" })]);
  openAdvanced();
  expect(screen.getByRole("radio", { name: "密码库" })).toBeTruthy();
  expect(screen.queryByRole("radio", { name: /models\.json/ })).toBeNull();
  expect(screen.getByText(/加密保存在元枢的密码库/)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "仅本次运行" }));
  expect(patches()).toHaveLength(0);
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({ keyStorage: "session" });
});

test("密钥来源：选环境变量，缺变量名时保存被拦住，填完一起发", async () => {
  await setup();
  openAdvanced();
  choose(screen.getByRole("combobox", { name: "密钥来源" }), "env");
  expect(await screen.findByText(/必须填写变量名/)).toBeTruthy();
  save();
  expect(await screen.findByText(/保存失败：.*必须填写变量名/)).toBeTruthy();
  expect(patches()).toHaveLength(0);
  edit("环境变量名", "VLLM_KEY");
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({
    envVariable: "VLLM_KEY",
    method: "env",
  });
});

test("鉴权头：只有自定义端点有；保存发值，清空发 null，格式不对显示服务端校验文案", async () => {
  await setup([custom("vllm", { authHeader: "X-Gw-Key" }), ready("anthropic")]);
  openAdvanced();
  expect((field("鉴权头") as HTMLInputElement).value).toBe("X-Gw-Key");
  edit("鉴权头", "Authorization: Token");
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({ authHeader: "Authorization: Token" });
  await waitFor(() => expect(bar()).toBeNull());
  edit("鉴权头", "  ");
  save();
  await waitFor(() => expect(patches()).toHaveLength(2));
  expect(patches()[1]?.body).toEqual({ authHeader: null });
  await waitFor(() => expect(bar()).toBeNull());
  api.on("PATCH /api/v1/providers/vllm", () =>
    reply(400, { error: "invalid_auth_header" }),
  );
  edit("鉴权头", "Bad Header");
  save();
  expect(await screen.findByText(/鉴权头格式不对/)).toBeTruthy();
  fireEvent.click(railRow(/Anthropic/));
  expect(screen.queryByRole("textbox", { name: "鉴权头" })).toBeNull();
});

test("最大并发请求数：缺省 50；改成 2 只发这一个字段；留空或非法值就地提示、不发请求", async () => {
  await setup();
  openAdvanced();
  expect((field("最大并发请求数") as HTMLInputElement).value).toBe("50");
  edit("最大并发请求数", "2");
  save();
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]).toMatchObject({ body: { maxConcurrent: 2 } });
  await waitFor(() => expect(bar()).toBeNull());
  for (const bad of ["", "0", "1001"]) {
    clearToasts();
    edit("最大并发请求数", bad);
    expect((await screen.findAllByText(/1 到 1000/)).length).toBeGreaterThan(0);
    save();
    expect(await screen.findByText(/保存失败/)).toBeTruthy();
  }
  expect(patches()).toHaveLength(1);
});

test("协议兼容：弹窗里改，点保存才发；三态写入 compat，选「自动」清掉该键；内置没有这一项", async () => {
  await setup([custom("vllm"), ready("anthropic")]);
  openAdvanced();
  expect(screen.getByText("全部自动")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^协议兼容/ }));
  const d = within(await screen.findByRole("dialog"));
  expect(
    (d.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  const dev = () =>
    within(d.getByRole("radiogroup", { name: "developer 角色" }));
  fireEvent.click(dev().getByRole("radio", { name: "关" }));
  choose(d.getByRole("combobox", { name: "max tokens 字段" }), "max_tokens");
  fireEvent.click(dev().getByRole("radio", { name: "自动" }));
  expect(patches()).toHaveLength(0);
  fireEvent.click(d.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({
    compat: { maxTokensField: "max_tokens" },
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("已覆盖 1 项")).toBeTruthy();
  fireEvent.click(railRow(/Anthropic/));
  expect(screen.queryByRole("button", { name: /^协议兼容/ })).toBeNull();
});

test("models.json 预览：在弹窗里只读展示", async () => {
  await setup();
  openAdvanced();
  fireEvent.click(screen.getByRole("button", { name: /models\.json/ }));
  const d = within(await screen.findByRole("dialog"));
  expect(await d.findByText("与磁盘文件的差异")).toBeTruthy();
});

// ---- 测试连接与状态 ----

test("端点变更后旧测试结果作废，状态回到待核验", async () => {
  await setup([
    custom("vllm", {
      status: "ok",
      lastTest: {
        at: "2026-10-25T06:00:00Z",
        ok: true,
        ttft: 300,
        total: 900,
        stage: "token",
      },
    }),
  ]);
  expect(screen.getByText("已连接 · 首 token 300 ms")).toBeTruthy();
  edit("Base URL", "http://127.0.0.1:9999/v1");
  save();
  expect(await screen.findByText("待核验")).toBeTruthy();
});

test("有未保存的修改时「测试连接」置灰并说明；保存后恢复", async () => {
  await setup();
  const btn = () =>
    screen.getByRole("button", { name: "测试连接" }) as HTMLButtonElement;
  expect(btn().disabled).toBe(false);
  edit("Base URL", "http://127.0.0.1:9999/v1");
  expect(btn().disabled).toBe(true);
  expect(btn().title).toBe("先保存修改再测试");
  save();
  await waitFor(() => expect(btn().disabled).toBe(false));
});

test("测试连接：失败用提示说明原因、页头留着上次失败；再测通过回到已连接", async () => {
  await setup([custom("vllm")]);
  const at = "2026-10-25T06:03:00.000Z";
  let pass = false;
  // 假服务端在测试时落库 lastTest 并重算状态（与真实服务端一致），页面靠刷新列表拿到
  api.on("POST /api/v1/providers/vllm/test", () => {
    const p = api.list[0] as ProviderView;
    p.lastTest = pass
      ? { at, ok: true, ttft: 320, total: 1200, stage: "token" }
      : {
          at,
          ok: false,
          ttft: 0,
          total: 90,
          stage: "models",
          errorCode: "unauthorized",
        };
    p.status = pass ? "ok" : "warn";
    return reply(
      200,
      pass
        ? okResult({ lastTest: p.lastTest })
        : okResult({
            ok: false,
            failedStage: "models",
            errorCode: "unauthorized",
            lastTest: p.lastTest,
          }),
    );
  });
  expect(screen.getByText("待核验")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  expect(await screen.findByText("连接失败")).toBeTruthy();
  expect(screen.getByText(/上次测试失败：密钥被拒绝/)).toBeTruthy();
  expect(screen.getAllByText(/密钥被拒绝。/).length).toBeGreaterThan(0);

  pass = true;
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  expect(
    await screen.findByText(/连接成功 · 首 token 320 ms · 共 1.2 s/),
  ).toBeTruthy();
  expect(await screen.findByText("已连接 · 首 token 320 ms")).toBeTruthy();
  expect(screen.queryByText("连接失败")).toBeNull();
});

test("上次测试失败的原因，页面重新打开后也在页头下", async () => {
  await setup([
    custom("vllm", {
      lastTest: {
        at: "t",
        ok: false,
        ttft: 0,
        total: 0,
        stage: "endpoint",
        errorCode: "unreachable",
      },
    }),
  ]);
  expect(screen.getByText(/上次测试失败：无法连接端点/)).toBeTruthy();
});
