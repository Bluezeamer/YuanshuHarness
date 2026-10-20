import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "./api";
import { FakeWS, installAdmin, installApi, installFs } from "./fakes";
import { Shell } from "./Shell";

const ws1 = (over: object = {}) => ({
  id: "w1",
  name: "项目甲",
  path: "/work/a",
  environmentId: "local",
  tier: "rules",
  createdAt: "t",
  ...over,
});

let admin: ReturnType<typeof installAdmin>;
beforeEach(() => {
  FakeWS.all = [];
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("WebSocket", FakeWS);
  installApi([]);
  admin = installAdmin();
  installFs();
  admin.workspaces = [
    ws1(),
    ws1({ id: "w2", name: "项目乙", path: "/work/b" }),
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openSettings = async () => {
  render(<Shell sessions={[]} onUnauthorized={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  await screen.findByLabelText("名称");
};
const patches = () => admin.calls.filter((c) => c.method === "PATCH");

test("改名与改档位只发改动的字段", async () => {
  await openSettings();
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "新名" },
  });
  fireEvent.click(screen.getByRole("radio", { name: /自动模式/ }));
  expect(screen.getByText(/拿不准会交给你决定/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches()).toHaveLength(1));
  expect(patches()[0]?.body).toEqual({ name: "新名", tier: "auto" });
  await screen.findByText("已保存");
});

test("设为完全允许要二次确认，取消则不发请求", async () => {
  await openSettings();
  fireEvent.click(screen.getByRole("radio", { name: /完全允许/ }));
  expect(screen.getByRole("note").textContent).toContain("风险");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(patches()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(patches()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  fireEvent.click(screen.getByRole("button", { name: "确认设为完全允许" }));
  await waitFor(() => expect(patches()[0]?.body).toEqual({ tier: "full" }));
});

// 从根目录起逐级进入。
const goto = async (...names: string[]) => {
  fireEvent.click(
    within(await screen.findByRole("navigation", { name: "路径" })).getByRole(
      "button",
      { name: "根目录" },
    ),
  );
  for (const n of names) {
    const l = await screen.findByRole("list", { name: "子目录" });
    fireEvent.click(within(l).getByRole("button", { name: n }));
  }
  await screen.findByRole("status");
};
const posts = (path: string) =>
  admin.calls.filter((c) => c.method === "POST" && c.path === path);

test("新增：用选择器选目录，无效与重复路径给出不同提示", async () => {
  await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "新增工作区" }));
  expect(screen.queryByLabelText(/目录路径/)).toBeNull();
  await goto("work", "c");
  admin.fail["POST /api/v1/workspaces"] = 400;
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  expect((await screen.findByRole("alert")).textContent).toContain("路径无效");
  admin.fail["POST /api/v1/workspaces"] = 409;
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("已登记"),
  );
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  await screen.findByRole("button", { name: /\/work\/c/ });
  expect(admin.workspaces).toHaveLength(3);
  expect(posts("/api/v1/workspaces")[2]?.body).toEqual({ path: "/work/c" });
});

test("新增：目录不可读写时禁用并写明原因", async () => {
  await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "新增工作区" }));
  await goto("home", "u", "proj", "locked");
  expect(screen.getByRole("button", { name: "添加" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByText(/不能用作工作区/)).toBeTruthy();
});

test("删除需确认；409 提示仍有会话引用并保留条目", async () => {
  await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "删除工作区" }));
  admin.fail["DELETE /api/v1/workspaces/w1"] = 409;
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("仍有会话"),
  );
  fireEvent.click(screen.getByRole("button", { name: "删除工作区" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(admin.workspaces).toHaveLength(1));
  await waitFor(() =>
    expect(screen.getByLabelText("名称")).toHaveProperty("value", "项目乙"),
  );
});

test("查看并删除已记住的规则", async () => {
  admin.rules.w1 = [
    {
      id: "r1",
      kind: "command",
      access: null,
      value: "git status",
      createdAt: "t",
    },
    {
      id: "r2",
      kind: "path",
      access: "write",
      value: "/work/a/dist",
      createdAt: "t",
    },
  ];
  await openSettings();
  await screen.findByText("git status");
  expect(screen.getByText(/路径 · 读写/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "删除规则 git status" }));
  await waitFor(() => expect(screen.queryByText("git status")).toBeNull());
  expect(screen.getByText("/work/a/dist")).toBeTruthy();
});

const openNew = async () => {
  render(<Shell sessions={[]} onUnauthorized={() => {}} />);
  // 顶栏按钮排在 DOM 最前；pane 会话列表里还有同名入口。
  fireEvent.click(
    screen.getAllByRole("button", { name: "新建会话" })[0] as HTMLElement,
  );
  await screen.findByRole("dialog", { name: "新建会话" });
  await screen.findByRole("list", { name: "子目录" });
};
const createBtn = () => screen.getByRole("button", { name: "创建" });

test("新建会话：点已登记入口跳转，沿用其档位，不再登记", async () => {
  admin.workspaces[1] = ws1({
    id: "w2",
    name: "项目乙",
    path: "/work/b",
    tier: "auto",
  });
  await openNew();
  fireEvent.click(await screen.findByRole("button", { name: /项目乙/ }));
  await waitFor(() => expect(screen.getByText(/已登记/)).toBeTruthy());
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.getByText(/自动模式/)).toBeTruthy();
  await waitFor(() => expect(createBtn()).toHaveProperty("disabled", false));
  fireEvent.click(createBtn());
  await waitFor(() => expect(posts("/api/v1/sessions")).toHaveLength(1));
  expect(posts("/api/v1/sessions")[0]?.body).toEqual({ workspaceId: "w2" });
  expect(posts("/api/v1/workspaces")).toHaveLength(0);
});

test("新建会话：未登记目录先登记、按所选档位设置，再建会话", async () => {
  await openNew();
  await goto("work", "c");
  expect(screen.getByRole("radio", { name: /规则审批/ })).toHaveProperty(
    "checked",
    true,
  );
  fireEvent.click(screen.getByRole("radio", { name: /自动模式/ }));
  fireEvent.click(createBtn());
  await waitFor(() => expect(posts("/api/v1/sessions")).toHaveLength(1));
  expect(posts("/api/v1/workspaces")[0]?.body).toEqual({ path: "/work/c" });
  expect(admin.calls.find((c) => c.method === "PATCH")?.body).toEqual({
    tier: "auto",
  });
  expect(posts("/api/v1/sessions")[0]?.body).toEqual({ workspaceId: "w3" });
});

test("新建会话：登记返回 409 时按路径复用已有工作区", async () => {
  await openNew();
  await goto("work", "c");
  // 界面加载后才被别处登记，造成 409。
  admin.workspaces.push(ws1({ id: "w9", name: "别处", path: "/work/c" }));
  fireEvent.click(createBtn());
  await waitFor(() => expect(posts("/api/v1/sessions")).toHaveLength(1));
  expect(posts("/api/v1/sessions")[0]?.body).toEqual({ workspaceId: "w9" });
  expect(admin.workspaces).toHaveLength(3);
  expect(admin.calls.some((c) => c.method === "PATCH")).toBe(false);
});

test("新建会话：目录不可读写时创建禁用并写明原因", async () => {
  await openNew();
  await goto("home", "u", "proj", "locked");
  expect(createBtn()).toHaveProperty("disabled", true);
  expect(screen.getByText(/不可读写，不能创建会话/)).toBeTruthy();
  cleanup();
  await openNew();
  await goto("home", "u", "proj", "ro");
  expect(createBtn()).toHaveProperty("disabled", true);
});

test("新建会话失败：给出提示，说明目录已登记，且不吞错", async () => {
  await openNew();
  await goto("work", "c");
  admin.fail["POST /api/v1/sessions"] = 500;
  fireEvent.click(createBtn());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("目录已登记");
  expect(alert.textContent).toContain("Server");
  expect(admin.workspaces).toHaveLength(3);
  // 重试直接走已登记路径，不再重复登记。
  fireEvent.click(createBtn());
  await waitFor(() => expect(posts("/api/v1/sessions")).toHaveLength(2));
  expect(posts("/api/v1/workspaces")).toHaveLength(1);
  expect(posts("/api/v1/sessions")[1]?.body).toEqual({ workspaceId: "w3" });
});

test("会话审核策略：保存、清除（空串）", async () => {
  const api = installApi([]);
  api.list = [
    {
      id: "s1",
      name: "甲",
      createdAt: "t",
      updatedAt: "t",
      running: false,
      reviewPolicy: null,
    },
  ];
  admin = installAdmin();
  render(<Shell sessions={[]} onUnauthorized={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(screen.getByRole("tab", { name: "审核策略" }));
  const box = await screen.findByLabelText("审核策略");
  expect(screen.getByText(/拿不准时会交给你决定/)).toBeTruthy();
  fireEvent.change(box, { target: { value: " 不要碰生产 " } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(patches()[0]?.body).toEqual({ reviewPolicy: "不要碰生产" }),
  );
  await screen.findByText("已保存");
  fireEvent.click(screen.getByRole("button", { name: "清除策略" }));
  await waitFor(() => expect(patches()[1]?.body).toEqual({ reviewPolicy: "" }));
});

test("新建会话：选了 agent 定义时带上 agentId", async () => {
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) =>
    input === "/api/v1/agents"
      ? new Response(
          JSON.stringify({
            agents: [
              { id: "a1", name: "默认", defaultMode: "build" },
              { id: "a2", name: "只读审阅", defaultMode: "plan" },
            ],
          }),
          { status: 200 },
        )
      : inner(input, init),
  );
  await openNew();
  fireEvent.click(await screen.findByRole("button", { name: /项目乙/ }));
  const sel = await screen.findByLabelText("Agent 定义");
  await waitFor(() => expect(createBtn()).toHaveProperty("disabled", false));
  fireEvent.change(sel, { target: { value: "a2" } });
  fireEvent.click(createBtn());
  await waitFor(() => expect(posts("/api/v1/sessions")).toHaveLength(1));
  expect(posts("/api/v1/sessions")[0]?.body).toEqual({
    workspaceId: "w2",
    agentId: "a2",
  });
});
