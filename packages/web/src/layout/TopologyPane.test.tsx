import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TopologyNode } from "../api";
import { TopologyPane } from "./TopologyPane";

const node = (over: Partial<TopologyNode> & { id: string }): TopologyNode => ({
  name: null,
  parentId: null,
  depth: 0,
  state: "idle",
  task: null,
  denied: 0,
  deniedReasons: [],
  ...over,
});

const reply = (nodes: TopologyNode[]) =>
  new Response(JSON.stringify({ nodes }), { status: 200 });

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

test("没有协作会话时给出说明，而不是空白", async () => {
  fetchMock.mockResolvedValue(reply([]));
  render(<TopologyPane />);
  expect(await screen.findByText(/暂无协作会话/)).toBeTruthy();
});

test("请求失败且还没有数据：提示加载失败", async () => {
  fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
  render(<TopologyPane />);
  expect(await screen.findByText(/拓扑加载失败/)).toBeTruthy();
});

test("节点显示名称、状态文字与被拒次数，被拒原因随任务进悬停提示", async () => {
  fetchMock.mockResolvedValue(
    reply([
      node({ id: "p", name: "父", state: "running" }),
      node({
        id: "c",
        name: "子",
        parentId: "p",
        depth: 1,
        state: "failed",
        task: "读文件",
        denied: 2,
        deniedReasons: ["sudo -s 需要人工批准"],
      }),
    ]),
  );
  render(<TopologyPane />);
  const child = await screen.findByRole("link", {
    name: /^子，失败，被拒 2 次/,
  });
  expect(child.textContent).toContain("失败");
  expect(child.textContent).toContain("拒绝 2 次");
  expect(child.querySelector("title")?.textContent).toBe(
    "读文件\n被拒：sudo -s 需要人工批准",
  );
  expect(
    screen.getByRole("link", { name: /^父，运行中/ }).textContent,
  ).toContain("运行中");
});

test("点击节点走前端路由到会话详情，不整页刷新", async () => {
  fetchMock.mockResolvedValue(reply([node({ id: "a/1", name: "甲" })]));
  render(<TopologyPane />);
  fireEvent.click(await screen.findByRole("link", { name: /^甲/ }));
  expect(location.pathname).toBe("/sessions/a%2F1");
});

test("节点是带 href 的真链接，可新标签页打开，键盘靠原生 Enter", async () => {
  fetchMock.mockResolvedValue(reply([node({ id: "k", name: "键" })]));
  render(<TopologyPane />);
  const a = await screen.findByRole("link", { name: /^键/ });
  expect(a.getAttribute("href")).toBe("/sessions/k");
});
