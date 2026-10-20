import { describe, expect, test } from "vitest";
import { assemble } from "../prompt/assemble.js";
import { isMode, modeExtension, modePrompt } from "./mode.js";

// 直接驱动扩展的 tool_call 处理器。
function gate(mode: "build" | "plan") {
  let handler: ((e: unknown) => unknown) | undefined;
  modeExtension(mode)({
    on: (_n: string, h: (e: unknown) => unknown) => {
      handler = h;
    },
  } as never);
  return (toolName: string) => handler?.({ toolName, input: {} });
}

describe("plan 模式拦截", () => {
  test.each(["read", "grep", "find", "ls", "ask_user", "list_workspaces"])(
    "放行 %s",
    (tool) => {
      expect(gate("plan")(tool)).toBeUndefined();
    },
  );

  test.each(["write", "edit", "bash", "mcp__fs__write", "custom_tool"])(
    "拒绝 %s 并说明原因",
    (tool) => {
      expect(gate("plan")(tool)).toMatchObject({
        block: true,
        reason: expect.stringContaining("当前模式下不可用"),
      });
    },
  );

  test("build 模式不注册任何拦截", () => {
    expect(gate("build")("bash")).toBeUndefined();
  });
});

describe("模式提示词", () => {
  test("isMode 只认 build / plan", () => {
    expect(isMode("plan")).toBe(true);
    expect(isMode("yolo")).toBe(false);
    expect(isMode(null)).toBe(false);
  });

  test("plan 的提示词排在系统提示词最末尾，build 不追加", () => {
    const base = {
      blocks: [
        { id: "1", name: "角色", group: "角色定义", content: "你是助手" },
      ],
      globalConventions: "全局约定",
      projectConventions: null,
    };
    const build = assemble({ ...base, modePrompt: modePrompt("build") });
    expect(build.parts.some((p) => p.kind === "mode")).toBe(false);

    const plan = assemble({ ...base, modePrompt: modePrompt("plan") });
    expect(plan.parts.at(-1)).toMatchObject({ kind: "mode" });
    expect(plan.text.indexOf("plan 模式")).toBeGreaterThan(
      plan.text.indexOf("全局约定"),
    );
    expect(plan.text.endsWith(modePrompt("plan") as string)).toBe(true);
  });
});
