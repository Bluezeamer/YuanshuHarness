import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { McpPanel } from "./McpPanel";
import { SkillsPanel } from "./SkillsPanel";

type Handler = (body: unknown) => { status?: number; json?: unknown };
let routes: Record<string, Handler>;
let calls: { key: string; body: unknown }[];

// 按 "METHOD /path" 查表的 fetch 替身；未登记的路由返回 404。
beforeEach(() => {
  sessionStorage.clear();
  saveToken("tok");
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ key, body });
      const h = routes[key];
      const r = h ? h(body) : { status: 404, json: { error: "not_found" } };
      return new Response(
        r.json === undefined ? null : JSON.stringify(r.json),
        {
          status: r.status ?? 200,
        },
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const skill = (over: object = {}) => ({
  name: "pdf",
  description: "处理 PDF",
  scope: "project",
  source: "local",
  updatedAt: "t",
  ...over,
});
const ws = { id: "w1", name: "项目甲", path: "/a", environmentId: "local" };

test("SkillsPanel：项目 skill 显示分配与同步状态，勾选后整体替换", async () => {
  let names: string[] = [];
  routes["GET /api/v1/skills"] = () => ({ json: { skills: [skill()] } });
  routes["GET /api/v1/workspaces"] = () => ({ json: { workspaces: [ws] } });
  routes["GET /api/v1/workspaces/w1/skills"] = () => ({ json: { names } });
  routes["PUT /api/v1/workspaces/w1/skills"] = (b) => {
    names = (b as { names: string[] }).names;
    return { json: { names } };
  };
  routes["GET /api/v1/workspaces/w1/skills/sync"] = () => ({
    json: {
      report: {
        workspaceId: "w1",
        at: "t",
        items: [
          {
            name: "pdf",
            scope: "project",
            status: "conflict",
            message: "同名",
          },
        ],
      },
    },
  });
  render(<SkillsPanel onUnauthorized={() => {}} />);

  expect(await screen.findByText(/冲突 · 同名/)).toBeTruthy();
  fireEvent.click(await screen.findByLabelText("分配给 项目甲"));
  await waitFor(() =>
    expect(
      calls.some((c) => c.key === "PUT /api/v1/workspaces/w1/skills"),
    ).toBe(true),
  );
  expect(names).toEqual(["pdf"]);
});

test("SkillsPanel：改范围走 PATCH，全局 skill 不显示分配", async () => {
  routes["GET /api/v1/skills"] = () => ({ json: { skills: [skill()] } });
  routes["GET /api/v1/workspaces"] = () => ({ json: { workspaces: [] } });
  routes["PATCH /api/v1/skills/pdf"] = () => ({
    json: skill({ scope: "global" }),
  });
  render(<SkillsPanel onUnauthorized={() => {}} />);

  fireEvent.click(await screen.findByLabelText(/^全局/));
  expect(await screen.findByText(/在 agent 的能力引用里启用/)).toBeTruthy();
  expect(calls.find((c) => c.key === "PATCH /api/v1/skills/pdf")?.body).toEqual(
    {
      scope: "global",
    },
  );
});

test("SkillsPanel：库为空时进入导入页，扫描后可导入", async () => {
  routes["GET /api/v1/skills"] = () => ({ json: { skills: [] } });
  routes["GET /api/v1/environments"] = () => ({
    json: { environments: [{ id: "e1", name: "本机", kind: "local" }] },
  });
  routes["GET /api/v1/workspaces"] = () => ({ json: { workspaces: [] } });
  routes["GET /api/v1/environments/e1/skills"] = () => ({
    json: {
      skills: [
        {
          name: "pdf",
          description: "d",
          dir: "/h/pdf",
          managed: false,
          inLibrary: false,
        },
      ],
    },
  });
  routes["POST /api/v1/skills/import"] = () => ({ status: 201, json: skill() });
  render(<SkillsPanel onUnauthorized={() => {}} />);

  const scan = await screen.findByRole("button", { name: "扫描" });
  await waitFor(() => expect((scan as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(scan);
  fireEvent.click(await screen.findByRole("button", { name: "导入 pdf" }));
  expect(await screen.findByText("已在库中")).toBeTruthy();
  expect(
    calls.find((c) => c.key === "POST /api/v1/skills/import")?.body,
  ).toEqual({ environmentId: "e1", dir: "/h/pdf", scope: "global" });
});

const server = (over: object = {}) => ({
  name: "fx",
  config: { transport: "stdio", command: "npx", args: ["-y", "x"], env: [] },
  tools: null,
  toolsAt: null,
  status: null,
  ...over,
});

test("McpPanel：登记 http server，请求头引用密码库条目而不是明文", async () => {
  routes["GET /api/v1/mcp"] = () => ({ json: { servers: [] } });
  routes["GET /api/v1/secrets"] = () => ({
    json: { secrets: [{ id: "s1", name: "令牌", kind: "password" }] },
  });
  routes["POST /api/v1/mcp"] = () => ({
    status: 201,
    json: server({ name: "web" }),
  });
  render(<McpPanel onUnauthorized={() => {}} />);

  fireEvent.change(await screen.findByLabelText("名称"), {
    target: { value: "web" },
  });
  fireEvent.click(screen.getByLabelText(/streamable-http/));
  fireEvent.change(screen.getByLabelText("地址"), {
    target: { value: "https://h/mcp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加一项" }));
  fireEvent.change(screen.getByLabelText("请求头名称 1"), {
    target: { value: "Authorization" },
  });
  fireEvent.change(screen.getByLabelText("请求头取值方式 1"), {
    target: { value: "secret" },
  });
  fireEvent.change(screen.getByLabelText("请求头密码库条目 1"), {
    target: { value: "s1" },
  });
  fireEvent.change(screen.getByLabelText("请求头前缀 1"), {
    target: { value: "Bearer " },
  });
  fireEvent.click(screen.getByRole("button", { name: "登记" }));

  await waitFor(() =>
    expect(calls.some((c) => c.key === "POST /api/v1/mcp")).toBe(true),
  );
  expect(calls.find((c) => c.key === "POST /api/v1/mcp")?.body).toEqual({
    name: "web",
    config: {
      transport: "http",
      url: "https://h/mcp",
      headers: [{ key: "Authorization", secretId: "s1", prefix: "Bearer " }],
    },
  });
});

test("McpPanel：刷新连不上时显示失败原因，登记仍在", async () => {
  let state: object | null = null;
  routes["GET /api/v1/mcp"] = () => ({
    json: { servers: [server({ status: state })] },
  });
  routes["GET /api/v1/secrets"] = () => ({ json: { secrets: [] } });
  routes["GET /api/v1/workspaces"] = () => ({ json: { workspaces: [] } });
  routes["POST /api/v1/mcp/fx/refresh"] = () => {
    state = { state: "error", error: "spawn ENOENT", at: "t" };
    return { status: 502, json: { error: "mcp_unavailable" } };
  };
  render(<McpPanel onUnauthorized={() => {}} />);

  expect(await screen.findByText("尚未连接", { selector: "p" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新工具列表" }));
  expect(await screen.findByText("连接失败：spawn ENOENT")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "fx" })).toBeTruthy();
});
