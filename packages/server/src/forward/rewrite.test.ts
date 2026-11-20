// 头改写的每一条规则与反例：上游看到的是它自己，浏览器看到的是转发出口。
import type http from "node:http";
import { describe, expect, test } from "vitest";
import { SESSION_COOKIE } from "../auth.js";
import { downstreamHeaders, upstreamHeaders } from "./rewrite.js";

const TOKEN = "t".repeat(32);

const headers = (
  h: Record<string, string | string[]>,
): http.IncomingHttpHeaders => h as http.IncomingHttpHeaders;

describe("upstreamHeaders", () => {
  test("Host、Origin、Referer 都改写成上游自己的 localhost:<port>", () => {
    const out = upstreamHeaders(
      headers({
        host: "ys.example.com:7500",
        origin: "http://ys.example.com:7500",
        referer: "http://ys.example.com:7500/a/b?q=1#f",
      }),
      3000,
    );
    expect(out.host).toBe("localhost:3000");
    expect(out.origin).toBe("http://localhost:3000");
    expect(out.referer).toBe("http://localhost:3000/a/b?q=1#f");
  });

  test("Origin 为 null 或别的来源也一律改成上游自己", () => {
    expect(upstreamHeaders(headers({ origin: "null" }), 3000).origin).toBe(
      "http://localhost:3000",
    );
    expect(
      upstreamHeaders(headers({ origin: "https://evil.test" }), 3000).origin,
    ).toBe("http://localhost:3000");
  });

  test("没有 Origin / Referer 时不会凭空造出来", () => {
    const out = upstreamHeaders(headers({ host: "x.test" }), 3000);
    expect(out.origin).toBeUndefined();
    expect(out.referer).toBeUndefined();
  });

  test("Referer 解析不了就丢掉这个头", () => {
    const out = upstreamHeaders(headers({ referer: "not a url" }), 3000);
    expect(out.referer).toBeUndefined();
  });

  test("Cookie：只摘会话令牌，别的项原样保留", () => {
    const out = upstreamHeaders(
      headers({ cookie: `a=1; ${SESSION_COOKIE}=${TOKEN}; b=2` }),
      3000,
    );
    expect(out.cookie).toBe("a=1; b=2");
  });

  test("Cookie：名字只是前缀相似的不误摘", () => {
    const out = upstreamHeaders(
      headers({ cookie: `${SESSION_COOKIE}_backup=x; ${SESSION_COOKIE}x=y` }),
      3000,
    );
    expect(out.cookie).toBe(`${SESSION_COOKIE}_backup=x; ${SESSION_COOKIE}x=y`);
  });

  test("Cookie：摘完没有剩下的项就删掉整个头", () => {
    const out = upstreamHeaders(
      headers({ cookie: `${SESSION_COOKIE}=${TOKEN}` }),
      3000,
    );
    expect(out.cookie).toBeUndefined();
    expect("cookie" in out).toBe(false);
  });

  test("没有 Cookie 时不凭空造头", () => {
    expect(upstreamHeaders(headers({}), 3000).cookie).toBeUndefined();
  });

  test("逐跳头与 Connection 点名的头都去掉；升级请求保留 Connection 与 Upgrade", () => {
    const raw = headers({
      connection: "keep-alive, x-custom",
      "keep-alive": "timeout=5",
      te: "trailers",
      upgrade: "websocket",
      "x-custom": "1",
      "x-keep": "2",
    });
    const plain = upstreamHeaders(raw, 3000);
    expect(plain.connection).toBeUndefined();
    expect(plain["keep-alive"]).toBeUndefined();
    expect(plain.te).toBeUndefined();
    expect(plain.upgrade).toBeUndefined();
    expect(plain["x-custom"]).toBeUndefined();
    expect(plain["x-keep"]).toBe("2");

    const upgrade = upstreamHeaders(
      {
        ...raw,
        "sec-websocket-key": "abc",
      },
      3000,
      { upgrade: true },
    );
    expect(upgrade.upgrade).toBe("websocket");
    expect(upgrade.connection).toBe("keep-alive, x-custom");
    // 被 Connection 点名的仍是逐跳头，升级时也照旧去掉
    expect(upgrade["x-custom"]).toBeUndefined();
  });
});

describe("downstreamHeaders", () => {
  test("指回上游回环的绝对 Location 改成转发出口", () => {
    for (const loc of [
      "http://localhost:3000/x?y=1",
      "http://127.0.0.1:3000/x?y=1",
      "http://[::1]:3000/x?y=1",
    ]) {
      expect(
        downstreamHeaders(headers({ location: loc }), 3000, "h:7500").location,
      ).toBe("http://h:7500/x?y=1");
    }
  });

  test("相对路径、别的主机、别的端口都不动", () => {
    for (const loc of [
      "/x?y=1",
      "https://other.test/x",
      "http://localhost:4000/x",
      "http://127.0.0.1/x",
    ]) {
      expect(
        downstreamHeaders(headers({ location: loc }), 3000, "h:7500").location,
      ).toBe(loc);
    }
  });

  test("上游监听 80 端口时，地址里没写端口的回环 Location 也要改", () => {
    expect(
      downstreamHeaders(
        headers({ location: "http://localhost/x" }),
        80,
        "h:7500",
      ).location,
    ).toBe("http://h:7500/x");
    expect(
      downstreamHeaders(
        headers({ location: "http://localhost/x" }),
        3000,
        "h:7500",
      ).location,
    ).toBe("http://localhost/x");
  });

  test("应用想设的 Server 会话 Cookie 被丢掉（同主机 Cookie 不分端口，会顶掉登录），别的 Cookie 保留", () => {
    const out = downstreamHeaders(
      headers({
        "set-cookie": [
          "ys_session=evil; Path=/",
          "ys_sessionx=1; Path=/",
          "theme=dark; Path=/",
        ],
      }),
      3000,
      "h:7500",
    );
    expect(out["set-cookie"]).toEqual([
      "ys_sessionx=1; Path=/",
      "theme=dark; Path=/",
    ]);
    // 全丢光了就不留这个头
    expect(
      downstreamHeaders(
        headers({ "set-cookie": ["ys_session=evil"] }),
        3000,
        "h",
      )["set-cookie"],
    ).toBeUndefined();
  });

  test("Set-Cookie 去掉 Domain 属性，中间与末尾两种位置都要处理，其余原样", () => {
    const out = downstreamHeaders(
      headers({
        "set-cookie": [
          "a=1; Domain=localhost; Path=/; HttpOnly",
          "b=2; Path=/; domain=.example.com",
          "c=3; SameSite=Lax",
        ],
      }),
      3000,
      "h:7500",
    );
    expect(out["set-cookie"]).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/",
      "c=3; SameSite=Lax",
    ]);
  });

  test("其余响应头原样保留，逐跳头去掉", () => {
    const out = downstreamHeaders(
      headers({ "content-type": "text/html", "keep-alive": "timeout=5" }),
      3000,
      "h:7500",
    );
    expect(out["content-type"]).toBe("text/html");
    expect(out["keep-alive"]).toBeUndefined();
  });
});
