import { describe, expect, test } from "vitest";
import { type ClientOptions, parseClientOptions } from "./options.js";

function ok(flag: string | undefined, env: Record<string, string>) {
  const r = parseClientOptions(flag, env);
  if (!r.ok) throw new Error(r.message);
  return r.options satisfies ClientOptions;
}

describe("客户端参数（R2）", () => {
  test("地址：命令行 > 环境变量 > 默认值", () => {
    expect(ok(undefined, {}).url).toBe("http://127.0.0.1:7420");
    expect(ok(undefined, { YUANSHU_URL: "http://x:8080" }).url).toBe(
      "http://x:8080",
    );
    expect(ok("http://y:9000", { YUANSHU_URL: "http://x:8080" }).url).toBe(
      "http://y:9000",
    );
  });

  test.each([
    ["--url", "not-a-url", {}],
    ["--url", "ftp://x", {}],
    ["YUANSHU_URL", "", { YUANSHU_URL: "" }],
  ])("非法地址点名来源：%s", (name, value, env) => {
    const r = parseClientOptions(name === "--url" ? value : undefined, env);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(name);
  });

  test("令牌只取 YUANSHU_TOKEN；未设或为空时为 null", () => {
    expect(ok(undefined, {}).token).toBeNull();
    expect(ok(undefined, { YUANSHU_TOKEN: "" }).token).toBeNull();
    expect(ok(undefined, { YUANSHU_TOKEN: "abc" }).token).toBe("abc");
  });

  test("地址非法的错误信息不含令牌", () => {
    const token = "t".repeat(40);
    const r = parseClientOptions("nope", { YUANSHU_TOKEN: token });
    expect(!r.ok && r.message).not.toContain(token);
  });
});
