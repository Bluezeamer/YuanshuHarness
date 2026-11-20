// request-view 的渲染规则：头行、JAR 行、REDIRECTS、STATUS、头截断、各种 BODY 形态与 stopped。
// 纯函数整段比对：只给最小的 BodyPresentation 形状。
import { describe, expect, test } from "vitest";
import type { BodyPresentation } from "./body.js";
import { type RequestQuery, renderRequest } from "./request-view.js";

const text = (over: Partial<BodyPresentation> = {}): BodyPresentation => ({
  size: 5,
  text: "hello",
  shownChars: 5,
  totalChars: 5,
  marker: null,
  ...over,
});

const base = (over: Partial<RequestQuery> = {}): RequestQuery => ({
  pageId: "p1",
  method: "POST",
  url: "https://api.x.test/items",
  jar: null,
  ms: 142,
  status: 201,
  statusText: "Created",
  headers: [],
  ...over,
});

describe("头行", () => {
  test("页面身份：METHOD 地址 + via page + 毫秒", () => {
    expect(renderRequest(base(), [], null, "BODY: empty")).toBe(
      [
        "REQUEST: POST https://api.x.test/items  (via page p1, 142 ms)",
        "STATUS: 201 Created",
        "RESPONSE HEADERS: (none)",
        "BODY: empty",
      ].join("\n"),
    );
  });

  test("命名身份：via identity，JAR 行写在末尾", () => {
    expect(
      renderRequest(
        base({ identity: "bob", jar: ["sid", "csrf"] }),
        [],
        null,
        "BODY: empty",
      ),
    ).toBe(
      [
        "REQUEST: POST https://api.x.test/items  (via identity bob, 142 ms)",
        "STATUS: 201 Created",
        "RESPONSE HEADERS: (none)",
        "BODY: empty",
        "JAR bob: 2 cookies (sid, csrf)",
      ].join("\n"),
    );
  });

  test("身份罐空着：JAR 写 none", () => {
    expect(
      renderRequest(
        base({ identity: "bob", jar: [] }),
        [],
        null,
        "BODY: empty",
      ),
    ).toContain("JAR bob: none");
  });
});

describe("REDIRECTS", () => {
  test("每跳一行，最后一跳不写箭头", () => {
    expect(
      renderRequest(
        base({
          method: "GET",
          url: "https://a.test/start",
          status: 200,
          statusText: "OK",
        }),
        [
          {
            status: 302,
            method: "POST",
            url: "https://a.test/start",
            location: "https://b.test/end",
          },
          { status: 200, method: "GET", url: "https://b.test/end" },
        ],
        null,
        "BODY: empty",
      ),
    ).toBe(
      [
        "REQUEST: GET https://a.test/start  (via page p1, 142 ms)",
        "REDIRECTS:",
        "  302 POST https://a.test/start → https://b.test/end",
        "  200 GET https://b.test/end",
        "STATUS: 200 OK",
        "RESPONSE HEADERS: (none)",
        "BODY: empty",
      ].join("\n"),
    );
  });

  test("没发出去的那一跳写 stopped，STATUS 仍是最后一次响应", () => {
    expect(
      renderRequest(
        base({ status: 302, statusText: "Found" }),
        [
          {
            status: 302,
            method: "GET",
            url: "https://a.test/start",
            location: "https://b.test/end",
          },
        ],
        "用户没有批准访问 https://b.test",
        "BODY: empty",
      ),
    ).toBe(
      [
        "REQUEST: POST https://api.x.test/items  (via page p1, 142 ms)",
        "REDIRECTS:",
        "  302 GET https://a.test/start → https://b.test/end",
        "  (stopped: 用户没有批准访问 https://b.test)",
        "STATUS: 302 Found",
        "RESPONSE HEADERS: (none)",
        "BODY: empty",
      ].join("\n"),
    );
  });

  test("一次都没有跟随（follow: false）：没有 REDIRECTS 段", () => {
    expect(renderRequest(base(), [], null, "BODY: empty")).not.toContain(
      "REDIRECTS",
    );
  });

  test("follow 为 true 但这一个响应不是重定向：没有 REDIRECTS 段", () => {
    expect(
      renderRequest(
        base({ method: "GET", status: 200, statusText: "OK" }),
        [{ status: 200, method: "GET", url: "https://api.x.test/items" }],
        null,
        "BODY: empty",
      ),
    ).not.toContain("REDIRECTS");
  });
});

describe("响应头", () => {
  test("逐条一行，保持顺序与重复", () => {
    expect(
      renderRequest(
        base({
          status: 200,
          statusText: "OK",
          headers: [
            ["content-type", "application/json"],
            ["set-cookie", "sid=abc; HttpOnly"],
            ["set-cookie", "csrf=xyz; HttpOnly"],
          ],
        }),
        [],
        null,
        "BODY: empty",
      ),
    ).toContain(
      [
        "RESPONSE HEADERS:",
        "  content-type: application/json",
        "  set-cookie: sid=abc; HttpOnly",
        "  set-cookie: csrf=xyz; HttpOnly",
      ].join("\n"),
    );
  });

  test("值超过 300 字符截断并写剩下的字符数（不打码）", () => {
    const long = "x".repeat(320);
    expect(
      renderRequest(
        base({ status: 200, statusText: "OK", headers: [["x-long", long]] }),
        [],
        null,
        "BODY: empty",
      ),
    ).toContain(`  x-long: ${"x".repeat(300)}…(+20 chars)`);
  });
});

describe("响应体", () => {
  test("文本：MIME · 大小 · text，正文原样", () => {
    expect(
      renderRequest(base(), [], null, {
        mime: "application/json",
        ...text({ text: '{"a":1}', size: 7 }),
      }),
    ).toContain('BODY: application/json · 7 B · text\n{"a":1}');
  });

  test("被截断：写出没显示的字符数", () => {
    expect(
      renderRequest(base(), [], null, {
        mime: "text/plain",
        ...text({ text: "head", shownChars: 4, totalChars: 90 }),
      }),
    ).toContain("BODY: text/plain · 5 B · text\nhead\n… (+86 chars not shown)");
  });

  test("有附件标记：FULL BODY 行", () => {
    expect(
      renderRequest(base(), [], null, {
        mime: "text/plain",
        ...text({
          marker: "[attach_file] a.txt",
          totalChars: 4,
          shownChars: 4,
        }),
      }),
    ).toContain("FULL BODY: [attach_file] a.txt");
  });

  test("二进制：binary (not shown) 没有正文", () => {
    expect(
      renderRequest(base(), [], null, {
        mime: "image/png",
        ...text({ text: null, shownChars: 0, totalChars: 0 }),
      }),
    ).toContain("BODY: image/png · 5 B · binary (not shown)");
  });

  test("没有 MIME：写 -", () => {
    expect(renderRequest(base(), [], null, { mime: "", ...text() })).toContain(
      "BODY: - · 5 B · text",
    );
  });

  test("空体与 HEAD 由调用方给一句固定说明", () => {
    expect(renderRequest(base(), [], null, "BODY: empty")).toContain(
      "\nBODY: empty",
    );
    expect(renderRequest(base(), [], null, "BODY: none (HEAD)")).toContain(
      "\nBODY: none (HEAD)",
    );
    expect(
      renderRequest(
        base(),
        [],
        null,
        "BODY: not saved — 内容有 1 MB，超过大小上限",
      ),
    ).toContain("\nBODY: not saved — 内容有 1 MB，超过大小上限");
  });
});
