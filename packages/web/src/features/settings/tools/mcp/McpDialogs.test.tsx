// MCP 页的弹窗：JSON 编辑器的校验、添加、编辑与改名、卸载确认、详情。
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { clearToasts } from "../../../../ui";
import { mountMcp, server, url } from "./testkit";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "MCP 服务" });
const names = () =>
  [...rail().querySelectorAll(".u-lrow-label")].map((e) => e.textContent);
const choose = (n: string) => fireEvent.click(within(rail()).getByText(n));
const status = (n: string) =>
  within(within(rail()).getByText(n).closest(".u-lrow") as HTMLElement)
    .getByRole("img")
    .getAttribute("aria-label");
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, " ");
const addBtn = () =>
  fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
const editBtn = () =>
  fireEvent.click(screen.getByRole("button", { name: "编辑配置" }));
const json = () =>
  screen.getByRole("textbox", { name: "MCP 配置 JSON" }) as HTMLTextAreaElement;
const setJson = (v: string) =>
  fireEvent.change(json(), { target: { value: v } });
const diags = () =>
  [...document.querySelectorAll("ul[aria-label='校验结果'] li")].map((l) =>
    text(l),
  );
const pv = (k: string) => screen.getByTestId(`mcp-pv-${k}`).textContent;
const saveBtn = (label: string) =>
  screen.getByRole("button", { name: label }) as HTMLButtonElement;
const conf = (n: string) => screen.getByTestId(`conf-${n}`).textContent ?? "";

test("添加弹窗：只有一个 JSON 编辑器，没有名称与描述输入，不写配置文件路径", async () => {
  await mountMcp();
  addBtn();
  const dlg = await screen.findByRole("dialog", { name: "添加 MCP 服务" });
  expect(dlg.querySelectorAll("textarea")).toHaveLength(1);
  expect(dlg.querySelectorAll("input")).toHaveLength(0);
  expect(within(dlg).queryByLabelText(/名称/)).toBeNull();
  expect(dlg.textContent).not.toContain("mcp.json");
  expect(dlg.textContent).toContain(`\${VAR} 取 server 环境`);
});

test("stdio / http 模板：边输入边校验，预览只显示名称 / 传输 / 目标 / 附带数量", async () => {
  await mountMcp();
  addBtn();
  await waitFor(() => expect(pv("name")).toBe("memory"));
  expect(pv("transport")).toBe("stdio");
  expect(pv("target")).toBe("npx -y @modelcontextprotocol/server-memory");
  expect(pv("extra")).toBe("env 1");
  fireEvent.click(screen.getByRole("button", { name: "http" }));
  await waitFor(() => expect(pv("name")).toBe("docs"));
  expect(pv("transport")).toBe("http");
  expect(pv("extra")).toBe("headers 1");
  expect(pv("target")).toContain("docs.example.com");
});

const BAD: [string, string, string][] = [
  ["{", "解析失败", "JSON 语法错误"],
  [
    `{"mcpServers":{"x":{"type":"sse","url":"${url("a.example/mcp")}"}}}`,
    "不支持 sse",
    "sse 被拒",
  ],
  [
    '{"mcpServers":{"x":{"command":"npx -y foo"}}}',
    "参数放 args",
    "command 不可带空格",
  ],
  ['{"mcpServers":{"x":{}}}', "需要 command", "command 与 url 都缺"],
  [
    '{"mcpServers":{"x":{"command":"npx"},"y":{"command":"uvx"}}}',
    "一次只添加一个服务",
    "一次只一个",
  ],
  ['{"foo":1}', "需要 mcpServers 包装", "缺 mcpServers 包装"],
];

for (const [input, want, label] of BAD)
  test(`校验拒绝 · ${label}：逐条诊断，保存按钮禁用`, async () => {
    await mountMcp();
    addBtn();
    await waitFor(() => expect(pv("name")).toBe("memory"));
    setJson(input);
    await waitFor(() => expect(diags().join("|")).toContain(want));
    expect(saveBtn("添加").disabled).toBe(true);
    expect(pv("name")).toBe("—");
  });

test("校验：合法配置清掉诊断；warning 只提示不拦保存", async () => {
  await mountMcp();
  addBtn();
  setJson('{"mcpServers":{"x":{"command":"npx -y foo"}}}');
  await waitFor(() => expect(diags()).toHaveLength(1));
  setJson(
    '{"mcpServers":{"w":{"command":"npx","args":["x"],"description":"手填"}}}',
  );
  await waitFor(() => expect(diags().join("")).toContain("手填会被忽略"));
  expect(saveBtn("添加").disabled).toBe(false);
});

test("校验请求防抖：连续输入只在停下后调一次服务端，且 editing 为空", async () => {
  const { fake } = await mountMcp();
  addBtn();
  await waitFor(() => expect(pv("name")).toBe("memory"));
  const before = fake.called("POST", /\/mcp\/validate$/).length;
  for (const v of ["{", '{"', '{"m']) setJson(v);
  await waitFor(() => expect(diags().join("")).toContain("解析失败"));
  expect(fake.called("POST", /\/mcp\/validate$/).length - before).toBe(1);
  expect(fake.called("POST", /\/mcp\/validate$/).at(-1)?.body).toEqual({
    json: '{"m',
  });
});

test("添加：提交整段 JSON，弹窗关闭，选中新服务，随后自动检测一次", async () => {
  const { fake } = await mountMcp();
  addBtn();
  const text0 = JSON.stringify({
    mcpServers: {
      notes: {
        command: "npx",
        args: ["-y", "@acme/notes-mcp"],
        exposure: "direct",
      },
    },
  });
  setJson(text0);
  await waitFor(() => expect(pv("name")).toBe("notes"));
  fireEvent.click(saveBtn("添加"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.called("POST", /\/mcp$/)[0]?.body).toEqual({ json: text0 });
  expect(names()[0]).toBe("notes");
  expect(screen.getByRole("article", { name: "notes 详情" })).toBeTruthy();
  // 新建的服务还没握手；保存成功后自动检测，从「未检测」走到「就绪」
  await waitFor(() => expect(status("notes")).toBe("就绪"));
  expect(fake.called("POST", /\/mcp\/notes\/check$/)).toHaveLength(1);
  expect(await screen.findByText("notes 已添加，检测通过")).toBeTruthy();
});

test("重名拒绝（- 与 _ 视为相同）：诊断点名，保存按钮禁用", async () => {
  await mountMcp();
  addBtn();
  setJson('{"mcpServers":{"internal_tools":{"command":"npx","args":["x"]}}}');
  await waitFor(() =>
    expect(diags().join("")).toContain("同名服务已存在：internal-tools"),
  );
  expect(saveBtn("添加").disabled).toBe(true);
});

test("编辑配置：带回当前配置；改 exposure 保存后详情同步，并自动重新握手", async () => {
  const { fake } = await mountMcp();
  editBtn();
  const dlg = await screen.findByRole("dialog", {
    name: /编辑配置 · filesystem/,
  });
  expect(json().value).toContain("server-filesystem@2.0.0");
  const next = json().value.replace('"direct"', '"hidden"');
  setJson(next);
  await waitFor(() => expect(pv("name")).toBe("filesystem"));
  // 编辑自己不算重名：校验请求带 editing
  expect(fake.called("POST", /\/mcp\/validate$/).at(-1)?.body).toEqual({
    json: next,
    editing: "filesystem",
  });
  fireEvent.click(within(dlg).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.called("PUT", /\/mcp\/filesystem$/)[0]?.body).toEqual({
    json: next,
  });
  expect(conf("filesystem")).toContain('"exposure": "hidden"');
  // 服务端改配置会清掉握手结果；随后自动检测，先 PUT 后 check
  await waitFor(() =>
    expect(fake.called("POST", /\/mcp\/filesystem\/check$/)).toHaveLength(1),
  );
  const order = fake.calls.map((c) => `${c.method} ${c.path}`);
  expect(order.indexOf("POST /api/v1/mcp/filesystem/check")).toBeGreaterThan(
    order.indexOf("PUT /api/v1/mcp/filesystem"),
  );
  await waitFor(() => expect(status("filesystem")).toBe("就绪"));
});

test("编辑后检测未通过：提示带原因，状态不可用", async () => {
  const { fake } = await mountMcp();
  choose("linear"); // 种子里 linear 的检测会失败
  editBtn();
  await screen.findByRole("dialog");
  setJson(json().value.replace('"direct"', '"hidden"'));
  await waitFor(() => expect(pv("name")).toBe("linear"));
  fireEvent.click(saveBtn("保存"));
  expect(
    await screen.findByText(
      "linear 的配置已保存，但检测未通过：HTTP 401 未授权（令牌无效或已过期）",
    ),
  ).toBeTruthy();
  expect(fake.called("POST", /\/mcp\/linear\/check$/)).toHaveLength(1);
  expect(status("linear")).toBe("授权过期");
});

test("编辑已禁用的服务：只保存，不检测", async () => {
  const { fake } = await mountMcp();
  choose("internal-tools");
  editBtn();
  await screen.findByRole("dialog");
  setJson(json().value.replace('"hidden"', '"direct"'));
  await waitFor(() => expect(pv("name")).toBe("internal-tools"));
  fireEvent.click(saveBtn("保存"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("internal-tools 的配置已保存")).toBeTruthy();
  expect(fake.called("PUT", /\/mcp\/internal-tools$/)).toHaveLength(1);
  expect(fake.called("POST", /\/check$/)).toHaveLength(0);
  expect(status("internal-tools")).toBe("已禁用");
});

test("改名被引用：409 列出引用位置，弹窗不关、名称不变", async () => {
  await mountMcp(undefined, {
    refs: {
      filesystem: [
        { kind: "preset", id: "a1", name: "代码助手", detail: "agent 预设" },
        {
          kind: "directory",
          id: "w1",
          name: "harness-core",
          detail: "directory 分配",
        },
      ],
    },
  });
  editBtn();
  await screen.findByRole("dialog");
  setJson(json().value.replace('"filesystem"', '"fs-renamed"'));
  await waitFor(() => expect(pv("name")).toBe("fs-renamed"));
  fireEvent.click(saveBtn("保存"));
  const refs = await screen.findByRole("list", { name: "引用位置" });
  expect(
    within(refs)
      .getAllByRole("listitem")
      .map((l) => text(l)),
  ).toEqual([
    "提示词预设代码助手 · agent 预设",
    "Directoryharness-core · directory 分配",
  ]);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(names()).toContain("filesystem");
  expect(names()).not.toContain("fs-renamed");
});

test("没被引用的改名成功：旧名消失，新名出现并被选中", async () => {
  await mountMcp();
  choose("docs-search");
  editBtn();
  await screen.findByRole("dialog");
  setJson(json().value.replace('"docs-search"', '"docs-new"'));
  await waitFor(() => expect(pv("name")).toBe("docs-new"));
  fireEvent.click(saveBtn("保存"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(names()).toContain("docs-new");
  expect(names()).not.toContain("docs-search");
  expect(screen.getByRole("article", { name: "docs-new 详情" })).toBeTruthy();
});

test("服务端 400 invalid_config：诊断来自响应体，弹窗不关", async () => {
  const { fake } = await mountMcp([
    server("x-one", { command: "npx", args: ["a"] }),
  ]);
  fake.override((m, p) =>
    m === "POST" && /\/mcp$/.test(p)
      ? new Response(
          JSON.stringify({
            error: "invalid_config",
            message: "配置超过长度上限",
            diagnostics: [
              {
                level: "error",
                code: "invalid_config",
                message: "配置超过长度上限",
              },
            ],
          }),
          { status: 400 },
        )
      : undefined,
  );
  addBtn();
  await waitFor(() => expect(pv("name")).toBe("memory"));
  fireEvent.click(saveBtn("添加"));
  await waitFor(() => expect(diags().join("")).toContain("配置超过长度上限"));
  expect(screen.getByRole("dialog", { name: "添加 MCP 服务" })).toBeTruthy();
});

test("卸载：二次确认说明断开实例，取消不发请求，确认后条目消失", async () => {
  const { fake } = await mountMcp();
  choose("github");
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "卸载" }));
  };
  open();
  const dlg = await screen.findByRole("dialog", { name: "卸载 github" });
  expect(dlg.textContent).toContain("断开它的实例");
  fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
  expect(fake.writes()).toHaveLength(0);
  open();
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "卸载",
    }),
  );
  await waitFor(() => expect(names()).not.toContain("github"));
  expect(fake.called("DELETE", /\/mcp\/github$/)).toHaveLength(1);
});

test("详情弹窗（工具「查看全部」）：六格事实 + 握手工具全名与描述；只返回部分工具时标「显示 N / M」", async () => {
  await mountMcp();
  fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
  const dlg = await screen.findByRole("dialog", { name: "filesystem" });
  expect(dlg.getAttribute("data-size")).toBe("xl");
  const facts = [...dlg.querySelectorAll(".st-tl-facts6 > div")].map((d) =>
    text(d),
  );
  expect(facts.map((f) => f?.slice(0, 2))).toEqual([
    "传输",
    "版本",
    "暴露",
    "审批",
    "工具",
    "检测",
  ]);
  expect(facts[4]).toContain("11 个");
  expect(dlg.textContent).toContain("mcp__filesystem__read_file");
  expect(screen.getByTestId("tool-shown").textContent).toBe("显示 3 / 11");
  expect(dlg.textContent).toContain("其余 8 个工具握手没有返回描述");
  expect(dlg.textContent).toContain("与内置工具一样声明给模型");
});

test("详情弹窗里可直接跳到编辑配置", async () => {
  await mountMcp();
  fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
  const dlg = await screen.findByRole("dialog", { name: "filesystem" });
  fireEvent.click(within(dlg).getByRole("button", { name: "编辑配置" }));
  await screen.findByRole("dialog", { name: /编辑配置 · filesystem/ });
  expect(json().value).toContain("server-filesystem");
});
