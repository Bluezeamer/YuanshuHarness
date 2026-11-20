import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ContextMcp } from "../../../api/flows";
import { McpDialog } from "./McpDialog";

const item = (over: Partial<ContextMcp>): ContextMcp => ({
  name: "fx",
  state: "ready",
  tools: 3,
  global: true,
  transport: "stdio",
  where: "本机",
  ...over,
});

let mcp: ContextMcp[];
let reloads = 0;
let reloadStatus = 200;

beforeEach(() => {
  reloads = 0;
  reloadStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/reload")) {
        reloads++;
        return new Response(JSON.stringify({ status: "reloaded" }), {
          status: reloadStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ files: [], skills: [], mcp }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(<McpDialog sessionId="s1" open onClose={() => {}} />);

test("失败的排在前面，带运行位置与原因；有 stdio 失败时提醒自行装依赖", async () => {
  mcp = [
    item({ name: "ok", tools: 4 }),
    item({
      name: "broken",
      state: "failed",
      tools: 0,
      error: "spawn npx ENOENT",
      where: "测试机",
    }),
  ];
  mount();
  await screen.findByText("spawn npx ENOENT");
  const names = screen
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");
  expect(names[0]).toContain("broken");
  expect(names[0]).toContain("运行位置：测试机");
  expect(names[1]).toContain("4 个工具");
  expect(screen.getByText(/需要在运行位置的主机上自行装好/)).toBeTruthy();
});

test("会话开着时才登记的服务显示「待加载」并说明何时加载；不算失败，不提醒装依赖", async () => {
  mcp = [
    item({ name: "late", state: "pending", tools: 0, where: "本机" }),
    item({ name: "ok", tools: 2 }),
  ];
  mount();
  await screen.findByText("待加载");
  expect(screen.getByText(/发下一条消息或点「重载」时加载/)).toBeTruthy();
  expect(screen.queryByText(/自行装好/)).toBeNull();
});

test("没有 MCP 时说明去哪里登记；全绿时不提醒装依赖", async () => {
  mcp = [];
  mount();
  await screen.findByText(/这个会话没有用到 MCP 服务/);
  cleanup();
  mcp = [item({})];
  mount();
  await screen.findByText(/3 个工具/);
  expect(screen.queryByText(/自行装好/)).toBeNull();
});

test("重载：调用接口，再读到新状态", async () => {
  mcp = [item({ state: "failed", tools: 0, error: "not found" })];
  mount();
  await screen.findByText("not found");
  mcp = [item({})];
  fireEvent.click(screen.getByRole("button", { name: "重载" }));
  await waitFor(() => expect(reloads).toBe(1));
  await screen.findByText(/3 个工具/);
  expect(screen.queryByText("not found")).toBeNull();
});

test("会话正在运行：提示等这一轮结束", async () => {
  mcp = [item({})];
  reloadStatus = 409;
  mount();
  await screen.findByText(/3 个工具/);
  fireEvent.click(screen.getByRole("button", { name: "重载" }));
  await screen.findByText("会话正在运行，等这一轮结束再重载");
});
