import { describe, expect, test } from "vitest";
import { parseCall, validateCall } from "./call-tool.js";

const CALLABLE = ["read_file", "web-search", "grep"];
const ok = (outer: unknown) => {
  const r = parseCall(outer, CALLABLE);
  if (!r.ok) throw new Error(r.error);
  return r;
};
const err = (outer: unknown) => {
  const r = parseCall(outer, CALLABLE);
  if (r.ok) throw new Error("expected failure");
  return r.error;
};

describe("call_tool 解析", () => {
  test("正常：名字与对象参数", () => {
    expect(ok({ name: "grep", arguments: { pattern: "x" } })).toEqual({
      ok: true,
      name: "grep",
      args: { pattern: "x" },
    });
  });

  test("arguments 省略得 {}；字符串按 JSON 解析", () => {
    expect(ok({ name: "grep" }).args).toEqual({});
    expect(ok({ name: "grep", arguments: '{"a":1}' }).args).toEqual({ a: 1 });
  });

  test("两种确定性修复：去 markdown 围栏、去尾随逗号", () => {
    expect(
      ok({ name: "grep", arguments: '```json\n{"a":1}\n```' }).args,
    ).toEqual({
      a: 1,
    });
    expect(ok({ name: "grep", arguments: '{"a":1,}' }).args).toEqual({ a: 1 });
  });

  test("工具名：去空白与 functions. 前缀；大小写与 -/_ 差异唯一匹配才接受", () => {
    expect(ok({ name: " functions.grep " }).name).toBe("grep");
    expect(ok({ name: "READ-FILE" }).name).toBe("read_file");
    expect(ok({ name: "web_search" }).name).toBe("web-search");
  });

  test("工具名不近似接受：报最接近的并列出全部可调用名，且写明没有执行", () => {
    const e = err({ name: "search" });
    expect(e).toContain('no callable tool named "search"');
    expect(e).toContain("Closest: web-search");
    expect(e).toContain("Callable tools: read_file, web-search, grep");
    expect(e).toContain("The tool was NOT executed.");
  });

  test("参数顶层平铺：不自动搬，给出改正后的完整调用", () => {
    const e = err({ name: "grep", pattern: "x" });
    expect(e).toContain('"arguments"');
    expect(e).toContain(
      'call_tool({ "name": "grep", "arguments": {"pattern":"x"} })',
    );
  });

  test("参数不是合法 JSON 或不是对象：报错，不猜", () => {
    expect(err({ name: "grep", arguments: "{oops" })).toContain(
      "not valid JSON",
    );
    expect(err({ name: "grep", arguments: 5 })).toContain("JSON object");
    expect(err("grep")).toContain("takes an object");
  });
});

describe("call_tool 校验", () => {
  const tool = {
    name: "grep",
    description: "d",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  };

  test("合法参数通过", () => {
    expect(validateCall(tool, { pattern: "x" })).toEqual({
      ok: true,
      args: { pattern: "x" },
    });
  });

  test("缺必填：三段式（哪里错、合法的是什么、怎么改）并写明没有执行", () => {
    const r = validateCall(tool, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('arguments for "grep" are invalid');
    expect(r.error).toContain("Expected parameters (JSON schema)");
    expect(r.error).toContain("call again");
    expect(r.error).toContain("The tool was NOT executed.");
  });
});
