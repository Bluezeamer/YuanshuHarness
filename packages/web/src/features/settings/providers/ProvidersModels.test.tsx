import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { choose, optionsOf, selectedValue } from "../../../test/select";
import {
  builtin,
  custom,
  type FakeApi,
  model,
  mount,
  patchesOf,
  ready,
  reply,
  sentModelsOf,
} from "./testkit";

let api: FakeApi;
const setup = async (list?: Parameters<typeof mount>[0]) => {
  api = await mount(list);
};
const patches = () => patchesOf(api);
const sentModels = (n: number) => sentModelsOf(api, n);

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const section = () => within(screen.getByRole("region", { name: "模型" }));
const dialog = () => within(screen.getByRole("dialog"));
const mine = (id: string, over = {}) =>
  model(id, { source: "manual", ...over });
// 行的「⋯」菜单：移除
const removeModel = (name: string) => {
  fireEvent.click(section().getByRole("button", { name: `${name} 的操作` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "移除" }));
};
// 模型行本身（不含它的「⋯」按钮）
const rowsNamed = (re: RegExp) =>
  section()
    .getAllByRole("button", { name: re })
    .filter((b) => !/的操作$/.test(b.getAttribute("aria-label") ?? ""));
const openRow = (name: string) =>
  fireEvent.click(section().getByText(name).closest("button") as HTMLElement);
const count = (el: HTMLElement, value: string) => {
  fireEvent.change(el, { target: { value } });
};

// ---- 列表 ----

test("每行只说名字、能做什么、上下文：思考 / 视觉 / 上下文长度 / 待补全", async () => {
  await setup([
    custom("vllm", {
      models: [
        mine("plain", { ctx: 8000 }),
        mine("thinker", {
          ctx: 131072,
          reasoning: true,
          levels: ["low", "high"],
        }),
        mine("looker", { ctx: 200000, input: ["text", "image"] }),
        mine("bare", { ctx: 0, out: 0 }),
      ],
    }),
  ]);
  const row = (n: string) =>
    within(section().getByText(n).closest(".u-lrow") as HTMLElement);
  expect(row("plain").getByText("8k 上下文")).toBeTruthy();
  expect(row("plain").queryByText("思考")).toBeNull();
  expect(row("plain").queryByText("视觉")).toBeNull();
  expect(row("thinker").getByText("思考")).toBeTruthy();
  expect(row("thinker").getByText("131k 上下文")).toBeTruthy();
  expect(row("looker").getByText("视觉")).toBeTruthy();
  expect(row("bare").getByText("待补全")).toBeTruthy();
  expect(row("bare").queryByText(/上下文/)).toBeNull();
});

test("模型多时先收起，只露前 5 个；超过 8 个才出搜索框", async () => {
  const many = Array.from({ length: 10 }, (_, i) => model(`m${i}`));
  await setup([ready("anthropic", { models: many })]);
  expect(rowsNamed(/^m\d/)).toHaveLength(5);
  fireEvent.click(section().getByRole("button", { name: "显示其余 5 个" }));
  expect(rowsNamed(/^m\d/)).toHaveLength(10);
  fireEvent.change(section().getByRole("textbox", { name: "搜索模型" }), {
    target: { value: "m7" },
  });
  expect(rowsNamed(/^m\d/)).toHaveLength(1);
});

test("没有模型时给出空态说明；模型不多就没有搜索框", async () => {
  await setup([custom("vllm", { models: [] })]);
  expect(section().getByText(/还没有已添加的模型/)).toBeTruthy();
  expect(section().queryByRole("textbox", { name: "搜索模型" })).toBeNull();
});

// ---- 手动添加与编辑 ----

test("手动添加：只填 ID 也能加，标为待补全；重复和空 ID 被拦住", async () => {
  await setup([custom("vllm", { models: [mine("m-a")] })]);
  fireEvent.click(section().getByRole("button", { name: "手动添加" }));
  fireEvent.click(dialog().getByRole("button", { name: "添加" }));
  expect(dialog().getByText("先填模型 ID")).toBeTruthy();
  const id = dialog().getByRole("textbox", { name: "模型 ID" });
  fireEvent.change(id, { target: { value: "m-a" } });
  fireEvent.click(dialog().getByRole("button", { name: "添加" }));
  expect(dialog().getByText("模型 m-a 已在列表里")).toBeTruthy();
  expect(patches()).toHaveLength(0);

  fireEvent.change(id, { target: { value: "qwen3-coder" } });
  fireEvent.click(dialog().getByRole("button", { name: "添加" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0).map((m) => [m.id, m.source, m.ctx])).toEqual([
    ["m-a", "manual", 200000],
    ["qwen3-coder", "manual", 0],
  ]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(section().getByText("待补全")).toBeTruthy();
});

test("编辑：回填当前值，未填（0）显示为空；ID 不能改；补全后「待补全」消失", async () => {
  await setup([custom("vllm", { models: [mine("m1", { ctx: 0, out: 0 })] })]);
  openRow("m1");
  const id = dialog().getByRole("textbox", {
    name: "模型 ID",
  }) as HTMLInputElement;
  expect(id.readOnly).toBe(true);
  const ctx = dialog().getByRole("textbox", {
    name: "上下文长度（token）",
  }) as HTMLInputElement;
  expect(ctx.value).toBe("");
  count(ctx, "32768");
  count(dialog().getByRole("textbox", { name: "最大输出（token）" }), "4096");
  fireEvent.click(dialog().getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0)[0]).toMatchObject({ id: "m1", ctx: 32768, out: 4096 });
  await waitFor(() => expect(section().queryByText("待补全")).toBeNull());
  expect(section().getByText("33k 上下文")).toBeTruthy();
});

test("上下文输入不合法：就地报错且不发请求", async () => {
  await setup([custom("vllm", { models: [mine("m1")] })]);
  openRow("m1");
  for (const bad of ["abc", "12kb", "-1", "1.5.2M"]) {
    count(dialog().getByRole("textbox", { name: "上下文长度（token）" }), bad);
    fireEvent.click(dialog().getByRole("button", { name: "保存" }));
    expect(dialog().getByText(/K \/ M 单位/)).toBeTruthy();
  }
  expect(patches()).toHaveLength(0);
});

test("上下文与输出可以写 K / M 单位，不分大小写，按 1024 换算后保存", async () => {
  await setup([custom("vllm", { models: [mine("m1", { ctx: 0, out: 0 })] })]);
  openRow("m1");
  count(dialog().getByRole("textbox", { name: "上下文长度（token）" }), "256K");
  count(dialog().getByRole("textbox", { name: "最大输出（token）" }), "0.5m");
  fireEvent.click(dialog().getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0)[0]).toMatchObject({ ctx: 262144, out: 524288 });
});

test("内置供应商已添加的模型：能编辑也能移除，编辑不改来源；空了给出提示", async () => {
  await setup([
    ready("anthropic", {
      models: [model("claude-x", { ctx: 200000 }), model("claude-y")],
    }),
  ]);
  openRow("claude-x");
  expect(dialog().getByText("创建后不能改")).toBeTruthy();
  count(
    dialog().getByRole("textbox", { name: "上下文长度（token）" }),
    "300000",
  );
  fireEvent.click(dialog().getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0)).toEqual([
    expect.objectContaining({ id: "claude-x", source: "catalog", ctx: 300000 }),
    expect.objectContaining({ id: "claude-y" }),
  ]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  removeModel("claude-y");
  await waitFor(() => expect(patches()).toHaveLength(2));
  expect(sentModels(1).map((m) => m.id)).toEqual(["claude-x"]);
  removeModel("claude-x");
  expect(await section().findByText(/点「从端点获取」挑选/)).toBeTruthy();
});

test("自己添加的模型从行菜单移除；视觉开关写进 input", async () => {
  await setup([custom("vllm", { models: [mine("m1"), mine("m2")] })]);
  openRow("m1");
  fireEvent.click(dialog().getByRole("switch", { name: "支持图片输入" }));
  fireEvent.click(dialog().getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0)[0]?.input).toEqual(["text", "image"]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  removeModel("m2");
  await waitFor(() => expect(patches()).toHaveLength(2));
  expect(sentModels(1).map((m) => m.id)).toEqual(["m1"]);
});

// ---- 思考档位 ----

test("思考：打开先勾默认五档；关掉清空档位、默认档位与取值", async () => {
  await setup([custom("vllm", { models: [mine("m1")] })]);
  openRow("m1");
  fireEvent.click(dialog().getByRole("switch", { name: "支持思考" }));
  const chips = dialog().getAllByRole("button", { pressed: true });
  expect(chips.map((c) => c.textContent)).toEqual([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  fireEvent.click(dialog().getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0)[0]).toMatchObject({
    reasoning: true,
    levels: ["off", "minimal", "low", "medium", "high"],
  });
  expect(sentModels(0)[0]).not.toHaveProperty("defaultLevel");

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  openRow("m1");
  fireEvent.click(dialog().getByRole("switch", { name: "支持思考" }));
  fireEvent.click(dialog().getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(2));
  expect(sentModels(1)[0]).toMatchObject({ reasoning: false, levels: [] });
});

test("默认档位：只能从勾选的档位里选；取消那一档后自动清掉；不指定就不发", async () => {
  await setup([
    custom("vllm", {
      models: [
        mine("m1", { reasoning: true, levels: ["low", "medium", "high"] }),
      ],
    }),
  ]);
  openRow("m1");
  const def = () => dialog().getByRole("combobox", { name: "默认档位" });
  expect(optionsOf(def()).map((o) => o.value)).toEqual([
    "",
    "low",
    "medium",
    "high",
  ]);
  choose(def(), "high");
  expect(selectedValue(def())).toBe("high");
  // 取消 high：默认档位跟着清空
  fireEvent.click(
    dialog().getByRole("button", { name: "high", pressed: true }),
  );
  expect(selectedValue(def())).toBe("");
  choose(def(), "medium");
  fireEvent.click(dialog().getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0)[0]).toMatchObject({
    levels: ["low", "medium"],
    defaultLevel: "medium",
  });
});

test("各档发给端点的取值：留空不发，填了写进 map；取消某档时丢掉它的取值", async () => {
  await setup([
    custom("vllm", {
      models: [mine("m1", { reasoning: true, levels: ["low", "high"] })],
    }),
  ]);
  openRow("m1");
  fireEvent.click(dialog().getByRole("button", { name: "各档发给端点的取值" }));
  fireEvent.change(dialog().getByRole("textbox", { name: "high 档的取值" }), {
    target: { value: "max-think" },
  });
  fireEvent.change(dialog().getByRole("textbox", { name: "low 档的取值" }), {
    target: { value: "tiny" },
  });
  fireEvent.click(dialog().getByRole("button", { name: "low", pressed: true }));
  fireEvent.click(dialog().getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0)[0]).toMatchObject({
    levels: ["high"],
    map: { high: "max-think" },
  });
});

test("编辑已有的思考模型：回填档位与默认档位", async () => {
  await setup([
    custom("vllm", {
      models: [
        mine("m1", {
          reasoning: true,
          levels: ["low", "high"],
          defaultLevel: "high",
        }),
      ],
    }),
  ]);
  openRow("m1");
  expect(
    dialog()
      .getAllByRole("button", { pressed: true })
      .map((c) => c.textContent),
  ).toEqual(["low", "high"]);
  expect(
    selectedValue(dialog().getByRole("combobox", { name: "默认档位" })),
  ).toBe("high");
});

// ---- 从端点获取 ----

test("从端点获取：只列 id、已添加的灰着，勾选添加后是待补全，source=probe", async () => {
  await setup([custom("vllm", { models: [mine("m-a")] })]);
  api.setProbe(["m-a", "m-b", "m-c"]);
  fireEvent.click(section().getByRole("button", { name: "从端点获取" }));
  const d = dialog();
  expect(await d.findByText(/共 3 个，其中 1 个已添加/)).toBeTruthy();
  expect(d.getAllByRole("checkbox")).toHaveLength(2);
  fireEvent.click(d.getByRole("checkbox", { name: "m-b" }));
  fireEvent.click(d.getByRole("button", { name: "添加所选（1）" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0).map((m) => [m.id, m.source])).toEqual([
    ["m-a", "manual"],
    ["m-b", "probe"],
  ]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    within(
      section().getByText("m-b").closest(".u-lrow") as HTMLElement,
    ).getByText("待补全"),
  ).toBeTruthy();
});

test("获取只是看：不勾选就不会改动已添加的模型", async () => {
  await setup([custom("vllm", { models: [mine("m-a")] })]);
  api.setProbe(["m-a", "m-b"]);
  fireEvent.click(section().getByRole("button", { name: "从端点获取" }));
  await dialog().findByText(/共 2 个/);
  expect(
    (dialog().getByRole("button", { name: "添加所选" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(dialog().getByRole("button", { name: "取消" }));
  expect(patches()).toHaveLength(0);
});

test("端点上的模型可搜索，全选只作用在当前筛出且未添加的", async () => {
  await setup([custom("vllm", { models: [mine("qwen-a")] })]);
  api.setProbe(["qwen-a", "qwen-b", "llama-1", "llama-2"]);
  fireEvent.click(section().getByRole("button", { name: "从端点获取" }));
  await dialog().findByText(/共 4 个/);
  fireEvent.change(
    dialog().getByRole("textbox", { name: "筛选端点上的模型" }),
    {
      target: { value: "llama" },
    },
  );
  fireEvent.click(dialog().getByRole("button", { name: "全选未添加的" }));
  fireEvent.click(dialog().getByRole("button", { name: "添加所选（2）" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0).map((m) => m.id)).toEqual([
    "qwen-a",
    "llama-1",
    "llama-2",
  ]);
});

test("内置供应商从端点获取：目录里有的带目录规格，没有的只有名字、待补全", async () => {
  await setup([ready("anthropic")]);
  api.setCatalog([
    model("claude-x", {
      ctx: 200000,
      reasoning: true,
      levels: ["low", "high"],
    }),
    model("claude-unlisted"),
  ]);
  api.setProbe(["claude-x", "claude-new"]);
  fireEvent.click(section().getByRole("button", { name: "从端点获取" }));
  await dialog().findByText(/共 2 个/);
  // 候选来自端点，不是目录整表：目录里有而端点没有的不出现
  expect(
    dialog().queryByRole("checkbox", { name: "claude-unlisted" }),
  ).toBeNull();
  fireEvent.click(dialog().getByRole("checkbox", { name: "claude-x" }));
  fireEvent.click(dialog().getByRole("checkbox", { name: "claude-new" }));
  fireEvent.click(dialog().getByRole("button", { name: "添加所选（2）" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0)).toEqual([
    expect.objectContaining({
      id: "claude-x",
      source: "catalog",
      ctx: 200000,
      reasoning: true,
    }),
    expect.objectContaining({ id: "claude-new", source: "probe", ctx: 0 }),
  ]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const row = (n: string) =>
    within(section().getByText(n).closest(".u-lrow") as HTMLElement);
  expect(row("claude-x").queryByText("待补全")).toBeNull();
  expect(row("claude-new").getByText("待补全")).toBeTruthy();
});

test("获取失败：显示上游原因，可重试", async () => {
  await setup();
  let fail = true;
  api.on("POST /api/v1/providers/vllm/models/probe", () =>
    fail ? reply(502, { error: "unreachable" }) : undefined,
  );
  fireEvent.click(section().getByRole("button", { name: "从端点获取" }));
  expect(await dialog().findByText(/无法连接端点/)).toBeTruthy();
  fail = false;
  api.setProbe(["m-z"]);
  fireEvent.click(dialog().getByRole("button", { name: "重试" }));
  expect(await dialog().findByText(/共 1 个/)).toBeTruthy();
});

test("没有凭据时获取被拒：显示服务端给的指路文案，不展示假列表", async () => {
  await setup([builtin("anthropic", { added: true, status: "ok" })]);
  api.on("POST /api/v1/providers/anthropic/models/probe", () =>
    reply(400, {
      error: "no_credential",
      message:
        "还没有登录订阅账号，请求会返回 401。先完成登录，或改用 API Key。",
    }),
  );
  fireEvent.click(section().getByRole("button", { name: "从端点获取" }));
  expect(await dialog().findByText(/先完成登录/)).toBeTruthy();
  expect(dialog().queryByRole("checkbox")).toBeNull();
});

test("协议不能探测的内置供应商：「从端点获取」改列目录里的模型，不请求端点", async () => {
  await setup([
    ready("mistral", { api: "mistral-conversations", probeable: false }),
  ]);
  api.setCatalog([
    model("mistral-large", { ctx: 128000 }),
    model("mistral-small"),
  ]);
  const btn = section().getByRole("button", { name: "从端点获取" });
  expect((btn as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(btn);
  expect(
    await dialog().findByText(/不能探测端点，列的是内置目录/),
  ).toBeTruthy();
  expect(dialog().getAllByRole("checkbox")).toHaveLength(2);
  fireEvent.click(dialog().getByRole("checkbox", { name: "mistral-large" }));
  fireEvent.click(dialog().getByRole("button", { name: "添加所选（1）" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(sentModels(0)).toEqual([
    expect.objectContaining({
      id: "mistral-large",
      source: "catalog",
      ctx: 128000,
    }),
  ]);
  expect(api.calls.some((c) => c.path.endsWith("/models/probe"))).toBe(false);
});

test("没有 Base URL 的自定义端点：「从端点获取」禁用并说明，仍可手动添加", async () => {
  await setup([custom("vllm", { probeable: false })]);
  const btn = section().getByRole("button", { name: "从端点获取" });
  expect((btn as HTMLButtonElement).disabled).toBe(true);
  expect(btn.getAttribute("title")).toMatch(/没有可用的 Base URL/);
  expect(
    (section().getByRole("button", { name: "手动添加" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
