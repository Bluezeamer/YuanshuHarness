import { describe, expect, test } from "vitest";
import { permissionExtension } from "./extension.js";
import { dirAt, locateAt } from "./testkit.js";

// 直接驱动扩展的 tool_call 处理器，模拟 SDK 里并未注册的自定义/MCP 工具。
function harness(review: () => Promise<{ decision: "allow" }>) {
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  const reviewed: string[] = [];
  const asked: Array<{ title: string }> = [];
  const ext = permissionExtension({
    directoryCtx: dirAt("/tmp/ws"),
    locate: locateAt("/tmp/ws"),
    tier: () => "auto",
    ask: async (spec) => {
      asked.push(spec as { title: string });
      return { outcome: "answered", optionId: "allow" } as never;
    },
    review: async (call) => {
      reviewed.push(call.tool);
      return review();
    },
  });
  ext({
    on: (_n: string, h: (e: unknown) => Promise<unknown>) => {
      handler = h;
    },
  } as never);
  return { call: (e: unknown) => handler?.(e), reviewed, asked };
}

describe("未知工具（含 MCP）在 auto 档只交人工", () => {
  test.each([
    ["mcp__fs__read", { path: "/tmp/ws/.env" }],
    ["custom_tool", { cmd: "sudo rm -rf /" }],
    ["custom_tool", { x: 1 }],
  ])("%s %j：弹审批且不调用审核方", async (toolName, input) => {
    const h = harness(async () => ({ decision: "allow" }));
    await h.call({ toolName, input });
    expect(h.reviewed).toEqual([]);
    expect(h.asked).toHaveLength(1);
  });
});

describe("todo_write 与目标工具只写会话自己的状态", () => {
  test.each([
    ["todo_write", { todos: [{ content: "x", status: "pending" }] }],
    ["get_goal", {}],
    ["create_goal", { objective: "x" }],
    ["update_goal", { goal_id: "g", revision: 1, action: "complete" }],
  ])("%s 不弹审批也不送审，调用直接放行", async (toolName, input) => {
    const h = harness(async () => ({ decision: "allow" }));
    const r = await h.call({ toolName, toolCallId: "t1", input });
    expect(r).toBeUndefined();
    expect(h.reviewed).toEqual([]);
    expect(h.asked).toEqual([]);
  });
});
