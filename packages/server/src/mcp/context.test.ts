import { expect, test } from "vitest";
import type { McpServerMeta } from "../store/mcp.js";
import { mcpContextItem } from "./context.js";

const tool = (name: string) => ({
  name,
  description: "",
  inputSchema: { type: "object" as const },
});

const server = (over: Partial<McpServerMeta> = {}): McpServerMeta =>
  ({
    name: "s",
    global: false,
    config: { transport: "stdio", command: "x", args: [], env: [] },
    enabled: true,
    exposure: "direct",
    toolExposure: {},
    handshake: null,
    tools: [tool("a"), tool("b")],
    ...over,
  }) as McpServerMeta;

const at = "2026-01-01T00:00:00Z";

test("禁用的服务：disabled，工具数 0", () => {
  expect(mcpContextItem(server({ enabled: false }), undefined)).toEqual({
    name: "s",
    global: false,
    transport: "stdio",
    state: "disabled",
    tools: 0,
  });
});

test("可见工具数排除 hidden（整体或按工具覆盖）", () => {
  expect(
    mcpContextItem(server({ toolExposure: { a: "hidden" } }), undefined),
  ).toMatchObject({ state: "ready", tools: 1 });
  expect(
    mcpContextItem(server({ exposure: "hidden" }), undefined),
  ).toMatchObject({ state: "ready", tools: 0 });
});

test("运行时最近一次结果优先于库里的握手记录", () => {
  const failedHandshake = { ok: false, tools: 0, ms: 1, at, error: "旧错误" };
  expect(
    mcpContextItem(server({ handshake: failedHandshake }), {
      state: "ok",
      at,
    }),
  ).toMatchObject({ state: "ready" });
  expect(
    mcpContextItem(server(), { state: "error", error: "连接断开", at }),
  ).toMatchObject({ state: "failed", tools: 2, error: "连接断开" });
});

test("全局与传输方式随条目带出，供右栏与 /mcp 弹窗显示", () => {
  expect(
    mcpContextItem(
      server({
        global: true,
        config: {
          transport: "http",
          url: "https://x.example/mcp",
          headers: [],
        },
      }),
      undefined,
    ),
  ).toMatchObject({ global: true, transport: "http" });
});

test("没有运行时状态时看握手记录；从未列出过工具的服务按 failed", () => {
  expect(
    mcpContextItem(
      server({
        tools: null,
        handshake: { ok: false, tools: 0, ms: 1, at, error: "401" },
      }),
      undefined,
    ),
  ).toMatchObject({ state: "failed", tools: 0, error: "401" });
  expect(mcpContextItem(server({ tools: null }), undefined)).toMatchObject({
    state: "failed",
    tools: 0,
  });
  expect(
    mcpContextItem(
      server({ handshake: { ok: true, tools: 2, ms: 1, at } }),
      undefined,
    ),
  ).toMatchObject({ state: "ready", tools: 2 });
});
