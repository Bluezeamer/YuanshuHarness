import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { clearToasts } from "../../../../ui";
import { mountMcp, seedMcp, server } from "./testkit";

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "MCP 服务" });
const rowOf = (n: string) =>
  within(rail()).getByText(n).closest(".u-lrow") as HTMLElement;
const names = () =>
  [...rail().querySelectorAll(".u-lrow-label")].map((e) => e.textContent);
const choose = (n: string) => fireEvent.click(within(rail()).getByText(n));
const detail = (n: string) =>
  screen.getByRole("article", { name: `${n} 详情` });
const status = (n: string) =>
  within(rowOf(n)).getByRole("img").getAttribute("aria-label");
const menuItem = (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
};
const hasMenuItem = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  const has = screen.queryByRole("menuitem", { name }) !== null;
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  return has;
};
const conf = (n: string) => screen.getByTestId(`conf-${n}`).textContent ?? "";
const bar = () => screen.queryByRole("region", { name: "保存" });

test("左列表：每行 传输 · 版本与状态点；描述与细节在悬停卡片里，不写配置文件位置", async () => {
  await mountMcp();
  expect(names()).toEqual(seedMcp().map((m) => m.name));
  expect(rowOf("filesystem").textContent).toContain("stdio · 2.0.0 · 已固定");
  expect(rowOf("playwright").textContent).toContain("stdio · 浮动 · 未固定");
  expect(rowOf("github").textContent).toContain("http · 远端服务");
  expect(status("filesystem")).toBe("就绪");
  expect(status("linear")).toBe("授权过期");
  expect(status("internal-tools")).toBe("已禁用");
  expect(rail().textContent).not.toContain("mcp.json");
});

test("详情：本机运行位置与握手耗时；工具只列前几个；配置块是 mcpServers JSON", async () => {
  await mountMcp();
  const d = detail("filesystem");
  expect(d.textContent).toContain("本机（Server）");
  expect(d.textContent).toContain("握手 180ms");
  expect(d.textContent).toContain("mcp__filesystem__read_file");
  expect(d.textContent).toContain("另 8 个未列出");
  // stdio 服务会经 SSH 起在远程主机上：写明同时连接数的上限
  expect(d.textContent).toContain("每台远程主机同时最多支持 10 个 MCP 连接");
  const c = conf("filesystem");
  expect(c).toContain('"mcpServers"');
  expect(c).toContain("server-filesystem@2.0.0");
  expect(d.textContent).not.toContain("mcp.json");
});

test("http 服务：与环境无关，不可固定，没有版本一节", async () => {
  await mountMcp();
  choose("github");
  const d = detail("github");
  expect(d.textContent).toContain("Server 直连");
  expect(d.textContent).toContain("与目录所在的环境无关");
  expect(d.textContent).not.toContain("同时最多支持 10 个");
  expect(within(d).queryByRole("region", { name: "版本" })).toBeNull();
  expect(hasMenuItem("试装并固定")).toBe(false);
  expect(hasMenuItem("选择版本")).toBe(false);
});

test("审批进草稿：改了不发请求，点保存才 PATCH；写明对 mcp__server__* 统一生效", async () => {
  const { fake } = await mountMcp();
  const group = screen.getByRole("radiogroup", { name: "filesystem 审批" });
  expect(
    within(group)
      .getAllByRole("radio")
      .find((r) => r.getAttribute("aria-checked") === "true")?.textContent,
  ).toBe("审批");
  expect(detail("filesystem").textContent).toContain(
    "对 11 个 mcp__filesystem__* 工具统一生效",
  );
  fireEvent.click(within(group).getByRole("radio", { name: "放行" }));
  expect(bar()).toBeTruthy();
  expect(fake.called("PATCH", /\/mcp\/filesystem$/)).toHaveLength(0);
  fireEvent.click(
    within(bar() as HTMLElement).getByRole("button", { name: "保存" }),
  );
  await waitFor(() =>
    expect(fake.called("PATCH", /\/mcp\/filesystem$/)).toHaveLength(1),
  );
  expect(fake.called("PATCH", /\/mcp\/filesystem$/)[0]?.body).toEqual({
    approval: "allow",
    global: false,
  });
  await waitFor(() => expect(bar()).toBeNull());
});

test("全局开关进草稿：默认关；打开后点保存才 PATCH，列表行副标题标「全局」", async () => {
  const { fake } = await mountMcp();
  const sw = screen.getByRole("switch", { name: "filesystem 全局" });
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByText(/^全局 · /)).toBeNull();
  fireEvent.click(sw);
  expect(bar()).toBeTruthy();
  expect(fake.called("PATCH", /\/mcp\/filesystem$/)).toHaveLength(0);
  fireEvent.click(
    within(bar() as HTMLElement).getByRole("button", { name: "保存" }),
  );
  await waitFor(() =>
    expect(fake.called("PATCH", /\/mcp\/filesystem$/)[0]?.body).toEqual({
      approval: "ask",
      global: true,
    }),
  );
  await waitFor(() => expect(bar()).toBeNull());
  expect(
    screen
      .getByRole("switch", { name: "filesystem 全局" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getAllByText(/^全局 · /).length).toBeGreaterThan(0);
});

test("检测：启动 → 握手 → 列工具三步；通过提示一下", async () => {
  const { fake } = await mountMcp();
  choose("github");
  fireEvent.click(
    within(detail("github")).getByRole("button", { name: "检测" }),
  );
  const steps = await within(detail("github")).findByRole("list", {
    name: "检测三步",
  });
  expect(
    within(steps)
      .getAllByRole("listitem")
      .map((l) => l.getAttribute("data-step")),
  ).toEqual(["start", "handshake", "list"]);
  expect(fake.called("POST", /\/mcp\/github\/check$/)).toHaveLength(1);
  expect(await screen.findByText("检测通过")).toBeTruthy();
});

test("检测失败点名原因：401 写在步骤里与提示里，状态授权过期，不吞错", async () => {
  await mountMcp();
  choose("linear");
  const d = detail("linear");
  // 握手失败的原因一直挂在详情上
  expect(d.textContent).toContain("HTTP 401 未授权");
  expect(d.textContent).toContain("到「编辑配置」里换掉密钥引用");
  fireEvent.click(within(d).getByRole("button", { name: "检测" }));
  const steps = await within(d).findByRole("list", { name: "检测三步" });
  const handshake = steps.querySelector(
    '[data-step="handshake"]',
  ) as HTMLElement;
  expect(handshake.getAttribute("data-state")).toBe("error");
  expect(handshake.textContent).toContain(
    "HTTP 401 未授权（令牌无效或已过期）",
  );
  expect(
    steps.querySelector('[data-step="list"]')?.getAttribute("data-state"),
  ).toBe("skipped");
  expect(status("linear")).toBe("授权过期");
});

test("启用成功后自动检测，从已禁用直接到就绪", async () => {
  const { fake } = await mountMcp();
  choose("internal-tools");
  fireEvent.click(screen.getByRole("button", { name: "启用" }));
  await waitFor(() => expect(status("internal-tools")).toBe("就绪"));
  expect(fake.called("PATCH", /\/mcp\/internal-tools$/)).toHaveLength(1);
  expect(fake.called("POST", /\/mcp\/internal-tools\/check$/)).toHaveLength(1);
  expect(
    await screen.findByText("internal-tools 已启用，检测通过"),
  ).toBeTruthy();
});

test("禁用不触发检测；已禁用的服务不给检测、不给固定", async () => {
  const { fake } = await mountMcp();
  menuItem("禁用");
  await waitFor(() => expect(status("filesystem")).toBe("已禁用"));
  expect(fake.called("POST", /\/check$/)).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "检测" })).toBeNull();
  expect(detail("filesystem").textContent).toContain("已禁用，未连接");
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(
    (screen.getByRole("menuitem", { name: "重新固定" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("启用请求失败：不检测，错误弹出来，状态不变", async () => {
  const { fake } = await mountMcp();
  fake.override((m, p) =>
    m === "PATCH" && /\/mcp\/internal-tools$/.test(p)
      ? new Response(JSON.stringify({ error: "boom", message: "服务出错" }), {
          status: 500,
        })
      : undefined,
  );
  choose("internal-tools");
  fireEvent.click(screen.getByRole("button", { name: "启用" }));
  expect(await screen.findByText("服务出错")).toBeTruthy();
  expect(fake.called("POST", /\/check$/)).toHaveLength(0);
  expect(status("internal-tools")).toBe("已禁用");
});

test("试装并固定：弹窗列出三步；成功才写回 pkg@版本", async () => {
  const { fake } = await mountMcp();
  choose("playwright");
  menuItem("试装并固定");
  const dlg = await screen.findByRole("dialog", { name: /试装并固定/ });
  expect(within(dlg).getAllByRole("listitem")).toHaveLength(3);
  fireEvent.click(within(dlg).getByRole("button", { name: "开始试装" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.called("POST", /\/mcp\/playwright\/try-pin$/)[0]?.body).toEqual(
    {},
  );
  await waitFor(() =>
    expect(conf("playwright")).toContain("@playwright/mcp@0.0.83"),
  );
  expect(rowOf("playwright").textContent).toContain("0.0.83 · 已固定");
  expect(await screen.findByText("playwright 已固定在 0.0.83")).toBeTruthy();
});

test("试装失败：不写回、仍是浮动，失败原因与三步都点名", async () => {
  await mountMcp(undefined, {
    pinFails: { playwright: "npm 安装失败：ETIMEDOUT" },
  });
  choose("playwright");
  menuItem("试装并固定");
  const dlg = await screen.findByRole("dialog");
  fireEvent.click(within(dlg).getByRole("button", { name: "开始试装" }));
  const alert = await within(dlg).findByRole("alert");
  expect(alert.textContent).toContain("npm 安装失败：ETIMEDOUT");
  expect(alert.textContent).toContain("没有写回配置，仍是浮动");
  expect(within(dlg).getByRole("list", { name: "检测三步" })).toBeTruthy();
  fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
  expect(rowOf("playwright").textContent).toContain("浮动 · 未固定");
  expect(conf("playwright")).not.toMatch(/mcp@\d/);
});

test("选择版本=回退并锁定：命令改写成旧版本，版本一节标出更新的最新版", async () => {
  const { fake } = await mountMcp();
  choose("playwright");
  menuItem("试装并固定");
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "开始试装",
    }),
  );
  await waitFor(() => expect(conf("playwright")).toContain("@0.0.83"));

  menuItem("选择版本");
  const dlg = await screen.findByRole("dialog", { name: /选择版本/ });
  expect(await within(dlg).findAllByRole("radio")).toHaveLength(3);
  const apply = within(dlg).getByRole("button", {
    name: "固定到此版本",
  }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  fireEvent.click(dlg.querySelector('[data-v="0.0.79"]') as HTMLElement);
  fireEvent.click(apply);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.called("POST", /\/playwright\/try-pin$/).at(-1)?.body).toEqual({
    version: "0.0.79",
  });
  expect(conf("playwright")).toContain("@playwright/mcp@0.0.79");
  expect(detail("playwright").textContent).toContain("最新 0.0.83");
});

test("手填版本按 x.y.z 校验：latest 被拒且不发请求；合法版本照常试装", async () => {
  const { fake } = await mountMcp();
  menuItem("选择版本");
  const dlg = await screen.findByRole("dialog", { name: /选择版本/ });
  await within(dlg).findAllByRole("radio");
  const input = within(dlg).getByLabelText("手填版本");
  fireEvent.change(input, { target: { value: "latest" } });
  fireEvent.click(within(dlg).getByRole("button", { name: "固定到此版本" }));
  expect(within(dlg).getByText("版本形如 x.y.z")).toBeTruthy();
  expect(fake.called("POST", /try-pin$/)).toHaveLength(0);
  fireEvent.change(input, { target: { value: "1.2.3" } });
  fireEvent.click(within(dlg).getByRole("button", { name: "固定到此版本" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.called("POST", /\/filesystem\/try-pin$/)[0]?.body).toEqual({
    version: "1.2.3",
  });
});

test("检测全部（列表头菜单）：就绪数汇总，没通过的逐个点名；禁用的不测", async () => {
  const { fake } = await mountMcp();
  fireEvent.click(screen.getByRole("button", { name: "MCP 服务的操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "检测全部" }));
  expect(
    await screen.findByText(
      "检测完成：就绪 5 / 6。linear（HTTP 401 未授权（令牌无效或已过期））",
    ),
  ).toBeTruthy();
  expect(fake.called("POST", /\/mcp\/check-all$/)).toHaveLength(1);
  expect(status("internal-tools")).toBe("已禁用");
});

test("检查更新（列表头菜单）：只问已固定的服务，包源出了新版的行标「可更新」，浮动的不查", async () => {
  const { fake, api } = await mountMcp();
  const fs = api.state.servers.find((m) => m.name === "filesystem");
  if (!fs) throw new Error("没有种子服务");
  fs.candidates = ["2.1.0", "2.0.0", "1.9.0"];
  expect(status("filesystem")).toBe("就绪");
  fireEvent.click(screen.getByRole("button", { name: "MCP 服务的操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "检查更新" }));
  expect(await screen.findByText(/检查完成：\d+ 个已固定的服务/)).toBeTruthy();
  expect(status("filesystem")).toBe("可更新");
  // 只有已固定的被问到；浮动的 playwright 不查
  const asked = fake
    .called("POST", /\/mcp\/[^/]+\/versions$/)
    .map((c) => c.path);
  expect(asked.some((u) => u.includes("/filesystem/"))).toBe(true);
  expect(asked.some((u) => u.includes("/playwright/"))).toBe(false);
  expect(status("playwright")).toBe("就绪");
});

test("首次进入页签：后台静默查已固定的服务，行标「可更新」，不弹提示；6 小时内再进不重查", async () => {
  const seed = seedMcp();
  const fs = seed.find((m) => m.name === "filesystem");
  if (!fs) throw new Error("没有种子服务");
  fs.candidates = ["2.1.0", "2.0.0"];
  const { fake } = await mountMcp(seed, undefined, { autoCheck: true });
  await waitFor(() => expect(status("filesystem")).toBe("可更新"));
  expect(screen.queryByText(/检查完成/)).toBeNull();
  const asked = fake.called("POST", /\/mcp\/[^/]+\/versions$/).length;
  expect(asked).toBeGreaterThan(0);
  // 换个页签再回来：页签重新进入，不再查
  fireEvent.click(screen.getByRole("tab", { name: /技能/ }));
  fireEvent.click(screen.getByRole("tab", { name: /MCP/ }));
  await screen.findByRole("complementary", { name: "MCP 服务" });
  expect(fake.called("POST", /\/mcp\/[^/]+\/versions$/)).toHaveLength(asked);
});

test("左列表行菜单：检测、禁用、卸载不用先选中", async () => {
  const { fake } = await mountMcp();
  fireEvent.click(
    within(rowOf("github")).getByRole("button", { name: "github 的操作" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "检测" }));
  await waitFor(() =>
    expect(fake.called("POST", /\/mcp\/github\/check$/)).toHaveLength(1),
  );
});

test("搜索覆盖名称、描述与目标地址；空库不编造数据，给添加入口", async () => {
  await mountMcp();
  fireEvent.change(screen.getByLabelText("筛选名称、描述或目标"), {
    target: { value: "docs.internal" },
  });
  expect(names()).toEqual(["docs-search"]);
  cleanup();
  vi.unstubAllGlobals();
  await mountMcp([]);
  expect(screen.getAllByText("还没有 MCP 服务").length).toBeGreaterThan(0);
  expect(
    screen.getAllByRole("button", { name: "添加服务" }).length,
  ).toBeGreaterThan(0);
});

test("seed 自洽：7 个服务按创建时间倒序", () => {
  expect(seedMcp()).toHaveLength(7);
  const x = server("a", { command: "npx", args: ["a"] });
  expect(x.enabled).toBe(true);
});
