import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../api";
import { ModelsPanel } from "./ModelsPanel";

let posts: Record<string, unknown>[] = [];
beforeEach(() => {
  posts = [];
  sessionStorage.clear();
  saveToken("tok");
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "m1" }), { status: 201 });
    }
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

test("高级区的 compat、推理档位映射与最大输出会随登记请求发出", async () => {
  render(<ModelsPanel onUnauthorized={() => {}} />);
  await screen.findByText(/还没有登记模型/);
  fill("名称", "本地");
  fill("接口地址", "http://127.0.0.1:1/v1");
  fill("模型 ID", "m1");
  fill("最大输出 token（可选）", "4096");
  fill("支持 developer 角色", "false");
  fill("最大输出字段名", "max_tokens");
  fill("low 映射方式", "map");
  fill("low 映射值", "lo");
  fill("medium 映射方式", "unsupported");
  fireEvent.click(screen.getByLabelText("支持图片输入"));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({
    maxTokens: 4096,
    input: ["text", "image"],
    compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    thinkingLevelMap: { low: "lo", medium: null },
  });
});

test("高级区不动时请求不带 compat / thinkingLevelMap", async () => {
  render(<ModelsPanel onUnauthorized={() => {}} />);
  await screen.findByText(/还没有登记模型/);
  fill("名称", "本地");
  fill("接口地址", "http://127.0.0.1:1/v1");
  fill("模型 ID", "m1");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).not.toHaveProperty("compat");
  expect(posts[0]).not.toHaveProperty("thinkingLevelMap");
  expect(posts[0]).toMatchObject({ input: ["text"] });
});
