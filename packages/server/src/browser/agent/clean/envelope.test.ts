import { describe, expect, test } from "vitest";
import { renderEnvelope } from "./envelope.js";

describe("renderEnvelope", () => {
  test("最小组合：PAGE 行 + 正文", () => {
    expect(
      renderEnvelope({ title: "登录", url: "https://x.test/", body: "BODY" }),
    ).toBe("PAGE: 登录 | https://x.test/\nBODY");
  });

  test("各行的顺序：PAGE / ACTION / URL / notes / SNAPSHOT / body", () => {
    expect(
      renderEnvelope({
        title: "t",
        url: "https://x.test/a",
        action: "click e12",
        urlChange: { from: "https://x.test/a", to: "https://x.test/b" },
        notes: ['CLIPBOARD (page copied): "x"', "PAGE ID: p1 · HTTP 200"],
        snapshot: "s3 · 554 lines",
        body: "BODY",
      }),
    ).toBe(
      [
        "PAGE: t | https://x.test/a",
        "ACTION: click e12",
        "URL: https://x.test/a → https://x.test/b",
        'CLIPBOARD (page copied): "x"',
        "PAGE ID: p1 · HTTP 200",
        "SNAPSHOT: s3 · 554 lines",
        "BODY",
      ].join("\n"),
    );
  });

  test("空 action / 空 notes / 没有 snapshot 都不留空行", () => {
    expect(
      renderEnvelope({
        title: "t",
        url: "u",
        action: "",
        notes: [],
        body: "B",
      }),
    ).toBe("PAGE: t | u\nB");
  });

  test("标题去换行、截到 120，空标题写 (untitled)", () => {
    expect(renderEnvelope({ title: "登 录\n页", url: "u", body: "" })).toBe(
      "PAGE: 登 录 页 | u\n",
    );
    expect(renderEnvelope({ title: "", url: "u", body: "" })).toBe(
      "PAGE: (untitled) | u\n",
    );
    expect(
      renderEnvelope({ title: "长".repeat(200), url: "u", body: "" }).split(
        " | ",
      )[0],
    ).toBe(`PAGE: ${"长".repeat(120)}`);
  });

  test("地址先打码再截到 300；URL 行两个地址同样处理", () => {
    const masked = renderEnvelope({
      title: "t",
      url: "http://x.test/cb?token=abc123&state=1",
      urlChange: {
        from: "http://x.test/cb?code=xyz",
        to: "http://x.test/?token=secret",
      },
      body: "",
    });
    expect(masked).not.toContain("abc123");
    expect(masked).not.toContain("xyz");
    expect(masked).not.toContain("secret");
    expect(masked).toContain("state=1");

    const long = `http://x.test/${"p".repeat(400)}`;
    const line = renderEnvelope({ title: "t", url: long, body: "" }).split(
      "\n",
    )[0] as string;
    expect(line).toBe(`PAGE: t | ${long.slice(0, 300)}`);
  });
});
