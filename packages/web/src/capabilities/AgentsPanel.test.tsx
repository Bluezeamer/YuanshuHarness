import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { AgentsPanel } from "./AgentsPanel";

interface Admin {
  agents: object[];
  blocks: object[];
  models: object[];
  tools: object[];
  posts: unknown[];
}

let admin: Admin;
beforeEach(() => {
  sessionStorage.clear();
  saveToken("tok");
  admin = {
    agents: [
      {
        id: "a1",
        name: "默认",
        description: "完整工具集",
        promptBlocks: [],
        capabilities: [{ kind: "tool", name: "read" }],
        model: null,
        defaultThinkingLevel: null,
        defaultMode: "build",
        createdAt: "t",
        updatedAt: "t",
      },
    ],
    blocks: [
      {
        id: "b1",
        name: "角色",
        group: "角色定义",
        dimension: null,
        content: "你是助手",
        version: 1,
        createdAt: "t",
        updatedAt: "t",
      },
    ],
    models: [],
    tools: [
      { name: "read", description: "读取文件", readOnly: true, server: false },
      {
        name: "write",
        description: "写入文件",
        readOnly: false,
        server: false,
      },
    ],
    posts: [],
  };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (s: number, b: object) =>
      new Response(JSON.stringify(b), { status: s });
    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      admin.posts.push(body);
      if (input === "/api/v1/agents")
        return json(201, { ...body, id: "a2", createdAt: "t", updatedAt: "t" });
      return json(201, {});
    }
    if (input === "/api/v1/agents") return json(200, { agents: admin.agents });
    if (input === "/api/v1/prompt/blocks")
      return json(200, { blocks: admin.blocks });
    if (input === "/api/v1/models") return json(200, { models: admin.models });
    if (input === "/api/v1/tools") return json(200, { tools: admin.tools });
    return json(200, {});
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("加载 agents、blocks、models、tools 目录后显示列表", async () => {
  render(<AgentsPanel onUnauthorized={() => {}} />);
  await screen.findByText("默认");
  expect(screen.getByText(/build/)).toBeTruthy();
});

test("新建 agent 提交完整字段", async () => {
  render(<AgentsPanel onUnauthorized={() => {}} />);
  await screen.findByText("默认");
  fireEvent.click(screen.getByRole("button", { name: "新建 agent" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "计划者" },
  });
  fireEvent.change(screen.getByLabelText("描述"), {
    target: { value: "plan 模式" },
  });
  fireEvent.click(screen.getByRole("radio", { name: /plan/ }));
  fireEvent.change(screen.getByLabelText("推理档位"), {
    target: { value: "high" },
  });
  fireEvent.click(screen.getByLabelText("write"));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(admin.posts).toHaveLength(1));
  expect(admin.posts[0]).toMatchObject({
    name: "计划者",
    description: "plan 模式",
    defaultMode: "plan",
    defaultThinkingLevel: "high",
    capabilities: [{ kind: "tool", name: "write" }],
  });
});
