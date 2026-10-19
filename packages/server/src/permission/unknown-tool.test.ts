import { describe, expect, test } from "vitest";
import { permissionExtension } from "./extension.js";

// 直接驱动扩展的 tool_call 处理器，模拟 SDK 里并未注册的自定义/MCP 工具。
function harness(review: () => Promise<{ decision: "allow" }>) {
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  const reviewed: string[] = [];
  const asked: Array<{ title: string }> = [];
  const ext = permissionExtension({
    cwd: "/tmp/ws",
    tier: () => "auto",
    rules: () => ({ path: [], command: [] }),
    addRule: () => {},
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
