// network-view 的渲染规则：条目行的各种状态、大小写法、外壳与过滤行、预算与详情各段。
import { describe, expect, test } from "vitest";
import type { NetworkDetail, NetworkEntry } from "../engine/types.js";
import {
  filterNetwork,
  type NetworkFilters,
  renderBody,
  renderNetwork,
  renderRequest,
} from "./network-view.js";

/** 本地时间 12:03:41 附近：时钟断言与本地时区无关。 */
const TS = new Date(2026, 0, 2, 12, 3, 41).getTime();

const entry = (p: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id: 41,
  ts: TS,
  method: "GET",
  url: "https://x.test/api/items?page=2",
  type: "xhr",
  frame: "main",
  status: 200,
  mime: "application/json",
  size: 4198,
  ms: 230,
  failure: null,
  ...p,
});

const query = (p: Partial<Parameters<typeof renderNetwork>[1]> = {}) => ({
  title: "商品页",
  url: "https://x.test/",
  total: 4,
  lastId: 44,
  evicted: 0,
  filters: {},
  ...p,
});

describe("renderNetwork", () => {
  test("外壳与四种条目行", () => {
    const shown = [
      entry(),
      entry({
        id: 42,
        type: "image",
        status: 404,
        mime: "text/html",
        size: 12_288,
        ms: 12,
        url: "https://x.test/a.png",
        frame: "sub",
      }),
      entry({
        id: 43,
        type: "script",
        status: null,
        mime: "",
        size: null,
        ms: 8,
        failure: "net::ERR_BLOCKED_BY_CLIENT",
        url: "https://x.test/ad.js",
      }),
      entry({
        id: 44,
        status: null,
        mime: "",
        size: null,
        ms: null,
        url: "https://x.test/slow",
      }),
    ];
    expect(renderNetwork(shown, query())).toEqual({
      text: [
        "NETWORK: 商品页 | https://x.test/",
        "REQUESTS: 4 in buffer · 4 shown · last id 44 · 0 older entries dropped",
        "#41 GET xhr 200 application/json 4.1 KB 230 ms https://x.test/api/items?page=2",
        "#42 GET image 404 text/html 12.0 KB 12 ms https://x.test/a.png [iframe]",
        "#43 GET script FAILED net::ERR_BLOCKED_BY_CLIENT - - 8 ms https://x.test/ad.js",
        "#44 GET xhr pending - - - https://x.test/slow",
      ].join("\n"),
      elided: false,
      full: [
        "NETWORK: 商品页 | https://x.test/",
        "REQUESTS: 4 in buffer · 4 shown · last id 44 · 0 older entries dropped",
        "#41 GET xhr 200 application/json 4.1 KB 230 ms https://x.test/api/items?page=2",
        "#42 GET image 404 text/html 12.0 KB 12 ms https://x.test/a.png [iframe]",
        "#43 GET script FAILED net::ERR_BLOCKED_BY_CLIENT - - 8 ms https://x.test/ad.js",
        "#44 GET xhr pending - - - https://x.test/slow",
      ].join("\n"),
    });
  });

  test("大小：B / KB / MB 与一位小数", () => {
    const lines = (sizes: (number | null)[]) =>
      sizes.map((size, i) => entry({ id: i + 1, size }));
    const out = renderNetwork(
      lines([512, 1024, 1536, 1024 * 1024 * 3.5, null]),
      query(),
    ).text;
    expect(out.split("\n").slice(2)).toEqual([
      "#1 GET xhr 200 application/json 512 B 230 ms https://x.test/api/items?page=2",
      "#2 GET xhr 200 application/json 1.0 KB 230 ms https://x.test/api/items?page=2",
      "#3 GET xhr 200 application/json 1.5 KB 230 ms https://x.test/api/items?page=2",
      "#4 GET xhr 200 application/json 3.5 MB 230 ms https://x.test/api/items?page=2",
      "#5 GET xhr 200 application/json - 230 ms https://x.test/api/items?page=2",
    ]);
  });

  test("地址超过 300 字符：截到 300 并标出剩下的字符数", () => {
    const long = `https://x.test/${"a".repeat(400)}`;
    const out = renderNetwork([entry({ url: long })], query()).text;
    const line = out.split("\n")[2] ?? "";
    expect(line).toContain("…(+115 chars)");
    expect(line.length).toBeLessThan(long.length);
  });

  test("没有命中：条目部分写一句 No requests matched.", () => {
    expect(renderNetwork([], query({ total: 4 })).text).toBe(
      [
        "NETWORK: 商品页 | https://x.test/",
        "REQUESTS: 4 in buffer · 0 shown · last id 44 · 0 older entries dropped",
        "No requests matched.",
      ].join("\n"),
    );
  });

  test("空缓冲：last id 写 0", () => {
    expect(
      renderNetwork([], query({ total: 0, lastId: 0 })).text.split("\n")[1],
    ).toBe(
      "REQUESTS: 0 in buffer · 0 shown · last id 0 · 0 older entries dropped",
    );
  });

  test("FILTER 行只写给了的项", () => {
    const head = (filters: NetworkFilters) =>
      renderNetwork([], query({ filters })).text.split("\n")[2];
    expect(head({})).toBe("No requests matched.");
    expect(head({ type: "xhr" })).toBe("FILTER: type=xhr");
    expect(head({ type: "xhr", url: "api", failed: true, after: 40 })).toBe(
      'FILTER: type=xhr, url~"api", failed, after=40',
    );
    expect(head({ after: 0 })).toBe("FILTER: after=0");
  });

  test("超预算：只留最新的整行、标出省略数，full 是完整的", () => {
    const shown = Array.from({ length: 200 }, (_, i) =>
      entry({ id: i + 1, url: `https://x.test/item-${i}` }),
    );
    const view = renderNetwork(shown, query({ total: 200, lastId: 200 }));
    expect(view.elided).toBe(true);
    const lines = view.text.split("\n");
    expect(lines[0]).toBe("NETWORK: 商品页 | https://x.test/");
    expect(lines[1]).toBe(
      "REQUESTS: 200 in buffer · 200 shown · last id 200 · 0 older entries dropped",
    );
    expect(lines[2]).toMatch(
      /^… \d+ earlier entries omitted \(200 shown in total\); full list is saved as an attachment$/,
    );
    // 留下的都是最新的那些，且按升序。
    expect(lines.at(-1)).toContain("https://x.test/item-199");
    const ids = lines.slice(3).map((l) => Number(/#(\d+)/.exec(l)?.[1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids.at(-1)).toBe(200);
    // 条目部分不超过预算。
    expect(lines.slice(3).join("\n").length).toBeLessThanOrEqual(6000);
    // full 不省略。
    expect(view.full.split("\n")).toHaveLength(2 + 200);
    expect(view.full).toContain("#1 GET xhr 200");
  });
});

describe("filterNetwork", () => {
  const entries = [
    entry({ id: 1, type: "xhr", url: "https://x.test/api/a", status: 200 }),
    entry({ id: 2, type: "Fetch", url: "https://x.test/API/b", status: 404 }),
    entry({
      id: 3,
      type: "image",
      url: "https://x.test/a.png",
      status: null,
      failure: "net::ERR_ABORTED",
    }),
    entry({ id: 4, type: "image", url: "https://x.test/b.png", status: null }),
  ];
  const ids = (filters: Parameters<typeof filterNetwork>[1]) =>
    filterNetwork(entries, filters).map((e) => e.id);

  test("type 不分大小写、要相等", () => {
    expect(ids({ type: "fetch" })).toEqual([2]);
    expect(ids({ type: "IMAGE" })).toEqual([3, 4]);
    expect(ids({ type: "script" })).toEqual([]);
  });

  test("url 是地址的子串，不分大小写", () => {
    expect(ids({ url: "/api/" })).toEqual([1, 2]);
    expect(ids({ url: ".PNG" })).toEqual([3, 4]);
  });

  test("failed 含失败与 4xx / 5xx；没响应的不 pending 不算", () => {
    expect(ids({ failed: true })).toEqual([2, 3]);
    expect(ids({ failed: false })).toEqual([1, 2, 3, 4]);
  });

  test("after 只看编号更大的", () => {
    expect(ids({ after: 1 })).toEqual([2, 3, 4]);
    expect(ids({ after: 0 })).toEqual([1, 2, 3, 4]);
  });

  test("几个条件都要满足", () => {
    expect(ids({ type: "image", failed: true })).toEqual([3]);
    expect(ids({ type: "image", url: "b.png", after: 1 })).toEqual([4]);
    expect(ids({ type: "xhr", failed: true })).toEqual([]);
  });
});

describe("renderRequest", () => {
  const detail = (p: Partial<NetworkDetail> = {}): NetworkDetail => ({
    entry: entry(),
    requestHeaders: { accept: "*/*", cookie: "***" },
    responseHeaders: { "content-type": "application/json" },
    requestBodyBytes: 120,
    ...p,
  });
  const where = { title: "商品页", url: "https://x.test/" };

  test("正常的一条：各段齐全", () => {
    expect(renderRequest(detail(), where)).toBe(
      [
        "REQUEST #41: 商品页 | https://x.test/",
        "GET https://x.test/api/items?page=2",
        "STATUS: 200 · TYPE: xhr · MIME: application/json · FRAME: main",
        "TIME: started 12:03:41 · 230 ms",
        "SIZE: response body 4.1 KB · request body 120 B",
        "REQUEST HEADERS:",
        "  accept: */*",
        "  cookie: ***",
        "RESPONSE HEADERS:",
        "  content-type: application/json",
        'NOTE: URLs and header values are shown exactly as sent and received (credentials included); use body="request" or body="response" with this id to read a body',
      ].join("\n"),
    );
  });

  test("失败、没响应、iframe、缺项都写 -", () => {
    const out = renderRequest(
      detail({
        entry: entry({
          status: null,
          mime: "",
          size: null,
          ms: null,
          frame: "sub",
          failure: "net::ERR_BLOCKED_BY_CLIENT",
        }),
        responseHeaders: null,
        requestBodyBytes: null,
        requestHeaders: {},
      }),
      where,
    );
    expect(out.split("\n").slice(2, 10)).toEqual([
      "STATUS: FAILED net::ERR_BLOCKED_BY_CLIENT · TYPE: xhr · MIME: - · FRAME: iframe",
      "TIME: started 12:03:41 · -",
      "SIZE: response body - · request body -",
      "REQUEST HEADERS: (none)",
      "RESPONSE HEADERS: (none)",
      'NOTE: URLs and header values are shown exactly as sent and received (credentials included); use body="request" or body="response" with this id to read a body',
    ]);
  });

  test("pending：没响应写 pending", () => {
    const out = renderRequest(
      detail({ entry: entry({ status: null }), responseHeaders: null }),
      where,
    );
    expect(out).toContain("STATUS: pending ·");
  });

  test("头的值超过 300 字符：截断并标出剩下的字数；头的数量不设上限", () => {
    const long = "a".repeat(400);
    const headers: Record<string, string> = {};
    for (let i = 0; i < 60; i++) headers[`h${i}`] = i === 0 ? long : "v";
    const out = renderRequest(detail({ requestHeaders: headers }), where);
    const lines = out.split("\n");
    const first = lines.find((l) => l.startsWith("  h0: "));
    expect(first).toContain("…(+100 chars)");
    expect(lines.filter((l) => l.startsWith("  h")).length).toBe(60);
  });
});

describe("renderBody", () => {
  const where = { title: "商品页", url: "https://x.test/" };
  const info = (
    p: Partial<Parameters<typeof renderBody>[0]> = {},
  ): Parameters<typeof renderBody>[0] => ({
    id: 41,
    which: "response",
    mime: "application/json",
    size: 12_595,
    text: '{"ok":true}',
    shownChars: 11,
    totalChars: 11,
    marker: null,
    ...p,
  });

  test("文本全文内联：外壳逐行照写，没有截断与附件行", () => {
    expect(renderBody(info(), where).split("\n")).toEqual([
      "BODY #41 response: 商品页 | https://x.test/",
      "MIME: application/json · SIZE: 12.3 KB · text",
      '{"ok":true}',
    ]);
  });

  test("被截断：末尾标出没显示的字符数，并有 FULL BODY 行", () => {
    expect(
      renderBody(
        info({
          text: "abc",
          shownChars: 3,
          totalChars: 9000,
          marker: "[attach_file] attachment:/a.txt",
        }),
        where,
      ).split("\n"),
    ).toEqual([
      "BODY #41 response: 商品页 | https://x.test/",
      "MIME: application/json · SIZE: 12.3 KB · text",
      "abc",
      "… (+8997 chars not shown)",
      "FULL BODY: [attach_file] attachment:/a.txt",
    ]);
  });

  test("二进制：不内联，正文位置写 binary (not shown)，直接接 FULL BODY", () => {
    expect(
      renderBody(
        info({
          which: "request",
          mime: "image/png",
          size: 5120,
          text: null,
          shownChars: 0,
          totalChars: 0,
          marker: "[attach_file] path=./a.png",
        }),
        where,
      ).split("\n"),
    ).toEqual([
      "BODY #41 request: 商品页 | https://x.test/",
      "MIME: image/png · SIZE: 5.0 KB · binary (not shown)",
      "FULL BODY: [attach_file] path=./a.png",
    ]);
  });

  test("MIME 空串写 -；正文里的空行原样保留", () => {
    const lines = renderBody(
      info({ mime: "", text: "a\n\nb", shownChars: 4, totalChars: 4 }),
      where,
    ).split("\n");
    expect(lines[1]).toBe("MIME: - · SIZE: 12.3 KB · text");
    expect(lines.slice(2)).toEqual(["a", "", "b"]);
  });

  test("文本为空串也照写一行空正文，不算二进制", () => {
    expect(
      renderBody(
        info({ text: "", shownChars: 0, totalChars: 0, size: 0 }),
        where,
      ).split("\n"),
    ).toEqual([
      "BODY #41 response: 商品页 | https://x.test/",
      "MIME: application/json · SIZE: 0 B · text",
      "",
    ]);
  });
});
