import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { PromptBlocksPanel } from "./PromptBlocksPanel";

let posts: unknown[];
beforeEach(() => {
  posts = [];
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (s: number, b: object) =>
      new Response(JSON.stringify(b), { status: s });
    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      posts.push(body);
      return json(201, {
        ...body,
        id: "b2",
        version: 1,
        createdAt: "t",
        updatedAt: "t",
      });
    }
    if (input === "/api/v1/prompt/blocks")
      return json(200, {
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
      });
    return json(200, {});
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("新建块提交字段，dimension 空时转 null", async () => {
  render(<PromptBlocksPanel onUnauthorized={() => {}} />);
  await screen.findByText("角色");
  fireEvent.click(screen.getByRole("button", { name: "新建块" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "工具约定" },
  });
  fireEvent.change(screen.getByLabelText("分组"), {
    target: { value: "全局约定" },
  });
  fireEvent.change(screen.getByLabelText("内容"), {
    target: { value: "工具调用必须谨慎" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({
    name: "工具约定",
    group: "全局约定",
    dimension: null,
    content: "工具调用必须谨慎",
  });
});
