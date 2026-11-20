import { describe, expect, test } from "vitest";
import { pluginToolNames } from "./tools.js";

// 只认「包里的扩展注册的」工具：内置、MCP 与框架工具都不算插件工具。
const at = (name: string, origin: string) => ({
  name,
  sourceInfo: { origin },
});

describe("pluginToolNames", () => {
  test("package 来源的进，内置 / MCP / 框架的不进", () => {
    expect(
      pluginToolNames([
        at("hello_plugin", "package"),
        at("another_plugin", "package"),
        at("read", "top-level"),
        at("powershell", "top-level"),
        at("mcp__fs__read", "top-level"),
        at("mcp__fs__read", "package"),
        at("ask_user", "package"),
        at("call_tool", "package"),
        at("switch_mode", "package"),
        at("todo_write", "package"),
        at("job_start", "package"),
      ]),
    ).toEqual(["hello_plugin", "another_plugin"]);
  });

  test("没有工具时返回空数组", () => {
    expect(pluginToolNames([])).toEqual([]);
  });
});
