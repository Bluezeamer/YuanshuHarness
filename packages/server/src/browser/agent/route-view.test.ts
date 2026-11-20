// route-view 的渲染规则：每种动作的摘要、delay、列表整段比对。纯函数，不起浏览器。
import { describe, expect, test } from "vitest";
import type { RouteInfo } from "../engine/types.js";
import { renderRoutes, routeSummary } from "./route-view.js";

const where = { title: "示例页", url: "https://x.test/a" };

describe("routeSummary", () => {
  test("block：error 缺省 failed", () => {
    expect(
      routeSummary({
        pattern: "**/*.png",
        method: "GET",
        type: "image",
        action: { kind: "block" },
      }),
    ).toBe("block GET image **/*.png error=failed");
    expect(
      routeSummary({
        pattern: "**/a.js",
        action: { kind: "block", error: "blockedbyclient" },
      }),
    ).toBe("block * * **/a.js error=blockedbyclient");
  });

  test("mock：状态码、体字符数与头个数", () => {
    expect(
      routeSummary({
        pattern: "**/api/items",
        action: {
          kind: "mock",
          status: 500,
          headers: { "content-type": "application/json" },
          body: '{"error":"boom"}',
        },
      }),
    ).toBe("mock * * **/api/items → 500 16 chars, 1 headers");
  });

  test("modify：只写给了的项", () => {
    expect(
      routeSummary({
        pattern: "**/api/**",
        action: {
          kind: "modify",
          method: "POST",
          url: "https://x.test/api/items",
          body: "abc",
          headers: { Authorization: "Bearer t", "X-A": "1", Cookie: null },
        },
      }),
    ).toBe(
      "modify * * **/api/** method=POST url=https://x.test/api/items body=3 chars headers +2 -1",
    );
    expect(
      routeSummary({
        pattern: "**/a",
        action: { kind: "modify", headers: { Cookie: null } },
      }),
    ).toBe("modify * * **/a headers +0 -1");
  });

  test("patch：状态码、头的增删、替换项数", () => {
    expect(
      routeSummary({
        pattern: "**/",
        action: {
          kind: "patch",
          status: 200,
          headers: { "content-security-policy": null, "X-A": "1", "X-B": null },
          replace: [
            { find: "a", with: "b" },
            { find: "c", with: "d" },
            { find: "e", with: "f" },
          ],
        },
      }),
    ).toBe("patch * * **/ status=200 headers +1 -2 replace ×3");
    expect(
      routeSummary({ pattern: "**/", action: { kind: "patch", status: 404 } }),
    ).toBe("patch * * **/ status=404");
  });

  test("delayMs 末尾加一句", () => {
    expect(
      routeSummary({
        pattern: "**/api/**",
        delayMs: 500,
        action: { kind: "block" },
      }),
    ).toBe("block * * **/api/** error=failed delay 500 ms");
  });
});

describe("renderRoutes", () => {
  const rule = (over: Partial<RouteInfo> = {}): RouteInfo => ({
    id: 1,
    pattern: "**/*.png",
    action: { kind: "block", error: "failed" },
    hits: 3,
    ...over,
  });

  test("整段：标题、页面地址、条数与一行一条", () => {
    expect(
      renderRoutes(
        [
          rule({ id: 1, method: "GET", type: "image" }),
          rule({
            id: 2,
            pattern: "**/api/items",
            delayMs: 500,
            hits: 1,
            action: {
              kind: "mock",
              status: 500,
              headers: { "x-a": "1" },
              body: "123456789012",
            },
          }),
        ],
        where,
      ),
    ).toBe(
      [
        "ROUTES: 示例页 | https://x.test/a",
        "RULES: 2 (max 20)",
        "#1 block GET image **/*.png error=failed (hits 3)",
        "#2 mock * * **/api/items → 500 12 chars, 1 headers delay 500 ms (hits 1)",
      ].join("\n"),
    );
  });

  test("没有规则：No rules.", () => {
    expect(renderRoutes([], where)).toBe(
      [
        "ROUTES: 示例页 | https://x.test/a",
        "RULES: 0 (max 20)",
        "No rules.",
      ].join("\n"),
    );
  });
});
