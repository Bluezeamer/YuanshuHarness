import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  CANVAS_MEDIA_DEFAULT,
  PI_IMAGE_COMPRESSION,
} from "../../../api/defaults";
import { choose, optionsOf, selectedValue } from "../../../test/select";
import { DefaultsPage } from "./DefaultsPage";
import {
  builtin,
  custom,
  fakeDefaults,
  model,
  mountDefaults,
  reply,
  vllm,
} from "./testkit";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

// 下拉走自绘的点开再选，输入框仍是 change 事件
const change = (el: HTMLElement, value: string) =>
  el.getAttribute("role") === "combobox"
    ? choose(el, value)
    : fireEvent.change(el, { target: { value } });
const field = (name: string) => screen.getByLabelText(name);
const goto = (name: string) =>
  fireEvent.click(screen.getByRole("tab", { name }));
const bar = () => screen.queryByRole("region", { name: "保存" });
const save = () =>
  fireEvent.click(
    within(bar() as HTMLElement).getByRole("button", { name: "保存" }),
  );
const tier = (name: string) =>
  screen.getByRole("radio", { name }) as HTMLButtonElement;
const putsOf = (fake: ReturnType<typeof fakeDefaults>, path: string) =>
  fake.api.calls.filter((c) => c.method === "PUT" && c.path === path);
const optionValues = (el: HTMLElement) => optionsOf(el).map((o) => o.value);

// ---- 模型与权限 ----

test("三个页签；模型一张表，三个角色各一行，值取自服务端（没人设置过的默认模型是第一个模型）", async () => {
  const fake = fakeDefaults([
    vllm(),
    builtin("anthropic", { models: [model("anthropic-m1")] }),
  ]);
  await mountDefaults(fake);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
    "模型与权限",
    "会话与任务",
    "输入与显示",
  ]);
  expect(selectedValue(field("默认模型 供应商"))).toBe("vllm");
  expect(selectedValue(field("默认模型 模型"))).toBe("m-plain");
  expect(selectedValue(field("默认模型 思考级别"))).toBe("off");
  // 审批模型、辅助模型没配：供应商显示「未设置」，模型与思考级别置灰
  expect(selectedValue(field("审批模型 供应商"))).toBe("");
  expect((field("审批模型 模型") as HTMLButtonElement).disabled).toBe(true);
  expect(selectedValue(field("辅助模型 供应商"))).toBe("");
  // 供应商下拉只列带模型的供应商；默认模型必配，审批、辅助多一个「未设置」
  expect(optionValues(field("默认模型 供应商"))).toEqual(["vllm", "anthropic"]);
  expect(optionValues(field("审批模型 供应商"))).toEqual([
    "",
    "vllm",
    "anthropic",
  ]);
  expect(optionValues(field("默认模型 模型"))).toEqual(["m-plain", "m-think"]);
  expect(bar()).toBeNull();
});

test("换默认模型：先进草稿（不发请求、出保存条），点保存才写 /default-model，思考档位取新模型的启动档位", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  change(field("默认模型 模型"), "m-think");
  expect(selectedValue(field("默认模型 思考级别"))).toBe("low");
  expect(optionValues(field("默认模型 思考级别"))).toEqual([
    "off",
    "minimal",
    "low",
    "high",
  ]);
  expect(bar()).toBeTruthy();
  expect(fake.api.calls.filter((c) => c.method === "PUT")).toEqual([]);
  save();
  await waitFor(() => expect(bar()).toBeNull());
  expect(putsOf(fake, "/api/v1/default-model").map((c) => c.body)).toEqual([
    { provider: "vllm", model: "m-think", thinking: "low" },
  ]);
  // 没动 /defaults 的任何一项
  expect(putsOf(fake, "/api/v1/defaults")).toEqual([]);
  expect(await screen.findByText("已保存")).toBeTruthy();
});

test("只改思考级别不换模型；换到不能思考的模型后档位回到 off", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  change(field("默认模型 模型"), "m-think");
  change(field("默认模型 思考级别"), "high");
  expect(selectedValue(field("默认模型 思考级别"))).toBe("high");
  change(field("默认模型 模型"), "m-plain");
  expect(selectedValue(field("默认模型 思考级别"))).toBe("off");
  expect(optionValues(field("默认模型 思考级别"))).toEqual(["off"]);
  change(field("默认模型 模型"), "m-think");
  change(field("默认模型 思考级别"), "high");
  save();
  await waitFor(() => expect(bar()).toBeNull());
  expect(putsOf(fake, "/api/v1/default-model").map((c) => c.body)).toEqual([
    { provider: "vllm", model: "m-think", thinking: "high" },
  ]);
});

test("换供应商落到它的第一个模型，不带旧模型 id（哪怕新供应商里恰好有同 id 的）", async () => {
  const fake = fakeDefaults([
    vllm(),
    custom("alt", { models: [model("alt-1"), model("m-plain")] }),
  ]);
  await mountDefaults(fake);
  change(field("默认模型 供应商"), "alt");
  expect(selectedValue(field("默认模型 模型"))).toBe("alt-1");
  save();
  await waitFor(() => expect(bar()).toBeNull());
  expect(putsOf(fake, "/api/v1/default-model").at(-1)?.body).toMatchObject({
    provider: "alt",
    model: "alt-1",
  });
});

test("审批模型配好后「模型」档才可选；与「模型」档一起保存是同一次请求", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  expect(tier("规则").getAttribute("aria-checked")).toBe("true");
  expect(tier("模型").disabled).toBe(true);
  change(field("审批模型 供应商"), "vllm");
  expect(tier("模型").disabled).toBe(false);
  fireEvent.click(tier("模型"));
  save();
  await waitFor(() => expect(bar()).toBeNull());
  expect(putsOf(fake, "/api/v1/defaults").map((c) => c.body)).toEqual([
    {
      permissionTier: "auto",
      reviewModel: { provider: "vllm", model: "m-plain", thinking: "off" },
    },
  ]);
  expect(fake.tier()).toBe("auto");
});

test("清掉审批模型时，停在「模型」档的默认档位在草稿里退回「规则」，一起保存", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  change(field("审批模型 供应商"), "vllm");
  fireEvent.click(tier("模型"));
  save();
  await waitFor(() => expect(bar()).toBeNull());

  change(field("审批模型 供应商"), "");
  expect(tier("规则").getAttribute("aria-checked")).toBe("true");
  save();
  await waitFor(() => expect(bar()).toBeNull());
  expect(putsOf(fake, "/api/v1/defaults").at(-1)?.body).toEqual({
    reviewModel: null,
    permissionTier: "rules",
  });
  expect(fake.review()).toBeNull();
  expect(fake.tier()).toBe("rules");
});

test("辅助模型：选了写 auxModel，再选「未设置」清掉", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  change(field("辅助模型 供应商"), "vllm");
  save();
  await waitFor(() => expect(fake.aux()?.model).toBe("m-plain"));
  await waitFor(() => expect(bar()).toBeNull());
  change(field("辅助模型 供应商"), "");
  save();
  await waitFor(() => expect(fake.aux()).toBeNull());
  expect(putsOf(fake, "/api/v1/defaults").at(-1)?.body).toEqual({
    auxModel: null,
  });
});

test("还没有任何模型：给出去哪里添加的说明，不出现下拉", async () => {
  const fake = fakeDefaults([vllm()].map((p) => ({ ...p, models: [] })));
  await mountDefaults(fake);
  expect(screen.getByText(/还没有可选的模型/)).toBeTruthy();
  expect(screen.queryByLabelText("默认模型 供应商")).toBeNull();
});

test("两个接口一个失败：成功的那份落定，失败的在提示里点名，草稿与保存条保留", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  fake.api.on("PUT /api/v1/default-model", () =>
    reply(404, { error: "unknown_model" }),
  );
  change(field("默认模型 模型"), "m-think");
  fireEvent.click(tier("通过"));
  save();
  expect(
    (await screen.findByText(/保存失败：默认模型：这个模型已不在供应商里/))
      .textContent,
  ).not.toContain("unknown_model");
  expect(fake.tier()).toBe("full");
  expect(bar()).toBeTruthy();
  expect(selectedValue(field("默认模型 模型"))).toBe("m-think");
  expect(tier("通过").getAttribute("aria-checked")).toBe("true");
});

// ---- 会话与任务 ----

test("后台任务提醒：按分钟填、保存成秒；填错就地提示，保存被拦住、不写服务端", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  const input = field("提醒间隔") as HTMLInputElement;
  expect(input.value).toBe("10");
  change(input, "0");
  expect(await screen.findByText(/提醒间隔要是 1–1440 的整数/)).toBeTruthy();
  save();
  expect(await screen.findByText(/保存失败：有填写不合法的项/)).toBeTruthy();
  expect(putsOf(fake, "/api/v1/defaults")).toEqual([]);
  change(input, "30");
  save();
  await waitFor(() => expect(fake.jobRemind()).toBe(1800));
  expect(putsOf(fake, "/api/v1/defaults").map((c) => c.body)).toEqual([
    { jobRemindSeconds: 1800 },
  ]);
});

test("目标轮数上限：改数字；关掉「限制续跑轮数」发 null，数字框随之隐藏", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  const input = field("轮数上限") as HTMLInputElement;
  expect(input.value).toBe("50");
  change(input, "20");
  save();
  await waitFor(() => expect(fake.goalMax()).toBe(20));
  fireEvent.click(screen.getByRole("switch", { name: "限制续跑轮数" }));
  expect(screen.queryByLabelText("轮数上限")).toBeNull();
  save();
  await waitFor(() => expect(fake.goalMax()).toBeNull());
  expect(putsOf(fake, "/api/v1/defaults").map((c) => c.body)).toEqual([
    { goalMaxRounds: 20 },
    { goalMaxRounds: null },
  ]);
});

test("子代理限额：改一项发完整的三项", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  const perCaller = field("每个调用方同时存活") as HTMLInputElement;
  expect(perCaller.value).toBe("10");
  change(perCaller, "101");
  expect(await screen.findByText(/要是 1–100 的整数/)).toBeTruthy();
  change(perCaller, "4");
  save();
  await waitFor(() =>
    expect(fake.limits()).toEqual({ maxDepth: 3, perCaller: 4, perTree: 50 }),
  );
  expect(putsOf(fake, "/api/v1/defaults").at(-1)?.body).toEqual({
    subagentLimits: { maxDepth: 3, perCaller: 4, perTree: 50 },
  });
});

const preset = (name: string) =>
  screen.getByRole("radio", { name }) as HTMLButtonElement;
const agentPuts = (fake: ReturnType<typeof fakeDefaults>) =>
  putsOf(fake, "/api/v1/agent-settings").map((c) => c.body);

test("压缩与重试：文件里没写的项显示 pi 自己的值；数字收着，展开后能看到", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  expect(preset("pi 默认").getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByLabelText("预留余量")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "调整数字" }));
  expect((field("预留余量") as HTMLInputElement).value).toBe("16384");
  expect((field("保留最近") as HTMLInputElement).value).toBe("20000");
  expect((field("重试次数") as HTMLInputElement).value).toBe("3");
  expect(bar()).toBeNull();
});

test("压缩方式：选一档只改草稿，保存发这一档的两个数；再选回「pi 默认」就删掉这两项", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  fireEvent.click(preset("节省上下文"));
  expect(agentPuts(fake)).toEqual([]);
  save();
  await waitFor(() =>
    expect(fake.agent().compaction).toEqual({
      reserveTokens: 32768,
      keepRecentTokens: 10000,
    }),
  );
  expect(agentPuts(fake)).toEqual([
    { compaction: { reserveTokens: 32768, keepRecentTokens: 10000 } },
  ]);
  // 保存后表单取回写入的值，仍停在这一档
  expect(preset("节省上下文").getAttribute("aria-checked")).toBe("true");
  // 其余接口一个没碰
  expect(putsOf(fake, "/api/v1/defaults")).toEqual([]);

  fireEvent.click(preset("pi 默认"));
  save();
  await waitFor(() => expect(fake.agent().compaction).toEqual({}));
  expect(agentPuts(fake).at(-1)).toEqual({
    compaction: { reserveTokens: null, keepRecentTokens: null },
  });
});

test("压缩的数字不在任何一档上：出现「自定义」；填错就地提示、不能收起、保存被拦住", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  fireEvent.click(screen.getByRole("button", { name: "调整数字" }));
  change(field("保留最近"), "25000");
  expect(preset("自定义").getAttribute("aria-checked")).toBe("true");
  change(field("预留余量"), "100");
  expect(await screen.findByText(/预留余量要是 4096–65536/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起数字" }));
  expect(screen.getByLabelText("预留余量")).toBeTruthy();
  save();
  expect(await screen.findByText(/保存失败：有填写不合法的项/)).toBeTruthy();
  expect(agentPuts(fake)).toEqual([]);
  change(field("预留余量"), "8192");
  save();
  await waitFor(() =>
    expect(fake.agent().compaction).toEqual({
      reserveTokens: 8192,
      keepRecentTokens: 25000,
    }),
  );
});

test("关掉自动压缩：档位与数字都收起，保存只发开关；开回去（等于 pi 的值）就删掉这一项", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  fireEvent.click(screen.getByRole("switch", { name: "自动压缩上下文" }));
  expect(screen.queryByRole("radio", { name: "pi 默认" })).toBeNull();
  expect(screen.queryByRole("button", { name: /数字/ })).toBeNull();
  save();
  await waitFor(() =>
    expect(fake.agent().compaction).toEqual({ enabled: false }),
  );
  expect(agentPuts(fake)).toEqual([{ compaction: { enabled: false } }]);
  fireEvent.click(screen.getByRole("switch", { name: "自动压缩上下文" }));
  save();
  await waitFor(() => expect(fake.agent().compaction).toEqual({}));
  expect(agentPuts(fake).at(-1)).toEqual({ compaction: { enabled: null } });
});

test("请求重试：次数 0 合法，范围外就地提示；关掉后次数收起", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  change(field("重试次数"), "11");
  expect(await screen.findByText(/重试次数要是 0–10/)).toBeTruthy();
  change(field("重试次数"), "0");
  save();
  await waitFor(() => expect(fake.agent().retry).toEqual({ maxRetries: 0 }));
  fireEvent.click(screen.getByRole("switch", { name: "自动重试" }));
  expect(screen.queryByLabelText("重试次数")).toBeNull();
  save();
  await waitFor(() =>
    expect(fake.agent().retry).toEqual({ maxRetries: 0, enabled: false }),
  );
});

test("settings.json 里有被忽略的项：在压缩一栏里写明文件路径与原因", async () => {
  const fake = fakeDefaults([vllm()]);
  fake.setAgentProblems(["compaction.reserveTokens 超出范围，已忽略"]);
  await mountDefaults(fake);
  goto("会话与任务");
  const note = await screen.findByText(/里有被忽略的项/);
  expect(note.textContent).toContain("/data/ys/settings.json");
  expect(note.textContent).toContain("compaction.reserveTokens 超出范围");
});

test("settings.json 被改坏、服务端拒绝：把它说的原因原样给用户，其余接口照常保存", async () => {
  const fake = fakeDefaults([vllm()]);
  fake.failAgentPut("文件现在不是合法 JSON，先改好再从界面保存");
  await mountDefaults(fake);
  goto("会话与任务");
  change(field("提醒间隔"), "30");
  fireEvent.click(preset("保留更多细节"));
  save();
  expect(
    await screen.findByText(
      /保存失败：压缩与重试：文件现在不是合法 JSON，先改好再从界面保存/,
    ),
  ).toBeTruthy();
  expect(fake.jobRemind()).toBe(1800);
  expect(bar()).toBeTruthy();
  expect(preset("保留更多细节").getAttribute("aria-checked")).toBe("true");
});

test("画布图片与资源：数字按 MB / 像素输入，保存整组发；越界就地提示", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("输入与显示");
  expect((field("缩略图最长边") as HTMLInputElement).value).toBe("2000");
  expect((field("GIF 原样上限") as HTMLInputElement).value).toBe("8");
  change(field("缩略图最长边"), "100");
  expect(await screen.findByText(/缩略图最长边要是 256–4096/)).toBeTruthy();
  change(field("缩略图最长边"), "1600");
  change(field("GIF 原样上限"), "30");
  save();
  await waitFor(() => expect(fake.media().gifMaxMB).toBe(30));
  expect(putsOf(fake, "/api/v1/defaults").at(-1)?.body).toEqual({
    canvasMedia: { ...CANVAS_MEDIA_DEFAULT, thumbMaxSide: 1600, gifMaxMB: 30 },
  });
});

test("目录起点：失焦去掉首尾空白，保存只发这一项；清空就地提示", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  const start = field("起点路径") as HTMLInputElement;
  change(start, "  /srv/work  ");
  fireEvent.blur(start);
  expect(start.value).toBe("/srv/work");
  save();
  await waitFor(() => expect(fake.start()).toBe("/srv/work"));
  await waitFor(() => expect(bar()).toBeNull());
  expect(putsOf(fake, "/api/v1/defaults").map((c) => c.body)).toEqual([
    { directoryStart: "/srv/work" },
  ]);
  change(start, "   ");
  expect(await screen.findByText("起点不能为空")).toBeTruthy();
});

test("服务端拒绝：提示翻成人话，输入与保存条都留着", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("会话与任务");
  fake.failPut("invalid_directory_start");
  const start = field("起点路径") as HTMLInputElement;
  change(start, "/x");
  save();
  const msg = await screen.findByText(/保存失败：起点不合法/);
  expect(msg.textContent).not.toContain("invalid_directory_start");
  expect(start.value).toBe("/x");
  expect(bar()).toBeTruthy();
  expect(fake.start()).toBe("~");
});

// ---- 输入与显示 ----

test("图片压缩：平时只露开关和一句现状，上限收着；展开后改宽度与编码上限，保存发完整参数", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("输入与显示");
  expect(
    screen.getByText("发送前压到 2000×2000 像素、4608 KiB 以内，JPEG 质量 80"),
  ).toBeTruthy();
  expect(screen.queryByLabelText("最大宽度")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "调整上限" }));
  expect((field("最大宽度") as HTMLInputElement).value).toBe("2000");
  change(field("最大宽度"), "1024");
  // 编码上限按 KiB 输入、按字节提交
  change(field("编码上限"), "1024");
  save();
  await waitFor(() => expect(fake.compression().maxWidth).toBe(1024));
  expect(putsOf(fake, "/api/v1/defaults").map((c) => c.body)).toEqual([
    {
      imageCompression: {
        ...PI_IMAGE_COMPRESSION,
        maxWidth: 1024,
        maxBytes: 1024 * 1024,
      },
    },
  ]);
});

test("压缩上限填错时不能收起；关掉自动压缩后上限与「调整上限」都不再出现", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("输入与显示");
  fireEvent.click(screen.getByRole("button", { name: "调整上限" }));
  change(field("最大宽度"), "9999");
  expect(await screen.findByText(/最大宽度要是 256–2000/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起上限" }));
  expect(screen.getByLabelText("最大宽度")).toBeTruthy();

  change(field("最大宽度"), "2000");
  fireEvent.click(screen.getByRole("switch", { name: "自动压缩" }));
  expect(screen.queryByLabelText("最大宽度")).toBeNull();
  expect(screen.queryByRole("button", { name: /上限/ })).toBeNull();
  save();
  await waitFor(() => expect(fake.compression().enabled).toBe(false));
  expect(putsOf(fake, "/api/v1/defaults").at(-1)?.body).toEqual({
    imageCompression: { ...PI_IMAGE_COMPRESSION, enabled: false },
  });
});

test("界面字号是本机设置：拖滑块立即生效，不出保存条、不发请求", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  goto("输入与显示");
  fireEvent.change(screen.getByRole("slider", { name: "基准字号滑块" }), {
    target: { value: "20" },
  });
  expect(document.documentElement.style.getPropertyValue("--fs-read")).toBe(
    "20px",
  );
  expect(bar()).toBeNull();
  expect(fake.api.calls.filter((c) => c.method === "PUT")).toEqual([]);
});

// ---- 整页 ----

test("有未保存的修改时切页签先问；放弃后回到已保存的值", async () => {
  const fake = fakeDefaults([vllm()]);
  await mountDefaults(fake);
  change(field("默认模型 模型"), "m-think");
  goto("会话与任务");
  const dialog = await screen.findByRole("dialog", {
    name: "有未保存的修改",
  });
  expect(screen.queryByLabelText("提醒间隔")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "放弃修改" }));
  await screen.findByLabelText("提醒间隔");
  goto("模型与权限");
  expect(selectedValue(field("默认模型 模型"))).toBe("m-plain");
  expect(bar()).toBeNull();
  expect(fake.api.calls.filter((c) => c.method === "PUT")).toEqual([]);
});

test("读取失败：给错误与重试，重试后恢复", async () => {
  const fake = fakeDefaults([vllm()]);
  fake.failRead(true);
  vi.stubGlobal("fetch", fake.api.fetchMock);
  render(<DefaultsPage />);
  const retry = await screen.findByRole("button", { name: "重试" });
  expect(screen.getByText("读取默认值失败")).toBeTruthy();
  fake.failRead(false);
  fireEvent.click(retry);
  await screen.findByRole("tab", { name: "模型与权限" });
  expect(screen.queryByText("读取默认值失败")).toBeNull();
});
