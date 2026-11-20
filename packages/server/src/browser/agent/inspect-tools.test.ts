// inspect-tools.ts：browser_dom（参数怎么变成 DomTarget、超预算时落附件前遮罩、不碰清洗层与审计）与
// browser_network（过滤、列表 / 详情分支、编号不存在、预算与遮罩）。全部用替身：不装浏览器、不起进程、不连网络。
import { afterAll, describe, expect, test } from "vitest";
import type { DomCapture, NetworkEntry } from "../engine/types.js";
import {
  cleanupTmpDirs,
  makeToolHarness,
  type ToolHarness,
} from "./testkit.js";

afterAll(cleanupTmpDirs);

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

const error = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return (e as Error).message;
};

/** 经工具打开一个公网站点：返回页面编号与它的假页面。 */
async function openViaTool(h: ToolHarness, target = "https://example.com/a") {
  await h.run("browser_open", { target });
  const pageId = h.registry.list("w1")[0]?.id as string;
  return { pageId, page: h.ctx().pageAt(-1) };
}

const capture = (roots: DomCapture["groups"][number]["roots"]): DomCapture => ({
  groups: [
    {
      frame: { url: "https://example.com/a", main: true },
      total: roots.length,
      roots,
    },
  ],
  nodeCapHit: false,
});

describe("browser_dom", () => {
  test("不给 selector 与 ref：读整个文档（target 为 null）", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.domResult = capture([
      { tag: "html", attrs: [], kids: [{ text: "正文", length: 2 }] },
    ]);
    const out = textOf(await h.run("browser_dom", { pageId }));
    expect(page.calls).toContain("dom document");
    expect(out).toBe(
      [
        "DOM: 示例页 | https://example.com/a",
        "QUERY: document",
        "NORMALIZED: comments dropped; script/style bodies, svg internals and templates summarized; long attribute values and data: URLs shortened; open shadow roots expanded; iframe contents are not included in ref/document views; hidden elements are included",
        "<html>正文</html>",
      ].join("\n"),
    );
    // 没有省略就不落附件，也不碰清洗层 / 遮罩（打开页面那一步的调用不算）。
    expect(h.saved).toEqual([]);
    expect(h.cleaner.calls).toHaveLength(1);
    expect(h.masks).toEqual([]);
  });

  test("selector 转成 { selector }，ref 转成 { ref }", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.domResult = capture([
      {
        tag: "img",
        attrs: [{ name: "src", value: "/a.png", length: 6 }],
        kids: [],
      },
    ]);
    const bySelector = textOf(
      await h.run("browser_dom", { pageId, selector: "img" }),
    );
    expect(page.calls).toContain("dom selector img");
    expect(bySelector).toContain('QUERY: selector "img"');
    expect(bySelector).toContain("[1] <img");
    const byRef = textOf(await h.run("browser_dom", { pageId, ref: "e12" }));
    expect(page.calls).toContain("dom ref e12");
    expect(byRef).toContain("QUERY: ref e12");
    // ref 模式没有 FRAME 行与编号。
    expect(byRef).not.toContain("FRAME");
    expect(byRef).not.toContain("[1] ");
  });

  test("selector 与 ref 都给：报错，不去读页面", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(h.run("browser_dom", { pageId, selector: "img", ref: "e1" })),
    ).toBe(
      "selector 与 ref 只能给一个：要查一类元素给 selector，要看某个快照元素的子树给 ref",
    );
  });

  test("超预算：全文遮罩后落成附件，结果里带 FULL DOM 行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const roots = Array.from({ length: 400 }, (_, i) => ({
      tag: "img",
      attrs: [
        { name: "alt", value: `secret ${i}`.padEnd(60, "a"), length: 60 },
      ],
      kids: [],
    }));
    page.domResult = capture(roots);
    const r = await h.run("browser_dom", { pageId, selector: "img" });
    expect(h.saved.map((s) => s.name)).toEqual([`dom-${pageId}.txt`]);
    const full = h.saved[0]?.bytes.toString("utf8") ?? "";
    // 落文件前确实调了 deps.mask：附件里是遮罩后的字。
    expect(h.masks).toHaveLength(1);
    expect(full).toContain("{{@secret}}");
    expect(full).not.toContain("secret ");
    expect(full.split("\n")).toHaveLength(3 + 1 + 400);
    const out = textOf(r);
    expect(out).toContain("more lines (401 lines total)");
    expect(out).toContain("\nFULL DOM: [attach_file] attachment:");
  });

  test("工具结果里的文字原样（遮罩由扩展统一做），只有落文件的才自己遮", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.domResult = capture([
      { tag: "p", attrs: [], kids: [{ text: "secret", length: 6 }] },
    ]);
    const out = textOf(await h.run("browser_dom", { pageId }));
    expect(out).toContain("<p>secret</p>");
    expect(h.masks).toEqual([]);
  });

  test("参数与描述：selector 有 maxLength 500、不带 intent，描述点明查漏补缺的要点", async () => {
    const h = makeToolHarness();
    const descriptions = new Map<
      string,
      {
        description?: string;
        parameters?: { properties?: Record<string, unknown> };
      }
    >();
    const { browserTools } = await import("./tools.js");
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: { name: string; description?: string }) =>
        descriptions.set(t.name, t as never),
    } as never);
    const tool = descriptions.get("browser_dom");
    const props = tool?.parameters?.properties ?? {};
    expect(props).toHaveProperty("pageId");
    expect(props).toHaveProperty("ref");
    expect(props.selector).toMatchObject({ type: "string", maxLength: 500 });
    expect(props).not.toHaveProperty("intent");
    const d = tool?.description ?? "";
    expect(d).toContain("查漏补缺");
    expect(d).toContain("data-*");
    expect(d).toContain("@box");
    expect(d).toContain("@natural");
    expect(d).toContain("@src");
    expect(d).toContain("不影响快照的对比基线");
    expect(d).toContain("不可信");
  });

  test("观察类只读：不调 cleaner、不写审计、不记回放", async () => {
    const recorded: unknown[] = [];
    const h = makeToolHarness({
      recordStep: async (a) => {
        recorded.push(a);
      },
    });
    const { pageId, page } = await openViaTool(h);
    page.domResult = capture([{ tag: "p", attrs: [], kids: [] }]);
    const cleaned = h.cleaner.calls.length;
    const audited = h.audit.length;
    recorded.length = 0;
    await h.run("browser_dom", { pageId, selector: "p" });
    expect(h.cleaner.calls).toHaveLength(cleaned);
    expect(h.audit).toHaveLength(audited);
    expect(recorded).toEqual([]);
    // 只读：不再多读一次快照（打开页面那一步读过）。
    expect(page.calls.filter((c) => c === "snapshot")).toHaveLength(1);
  });
});

/** 一条缓冲里的请求：缺省是成功的 xhr，给了 url 就换地址。 */
const netEntry = (p: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id: 41,
  ts: Date.parse("2026-01-02T12:03:41"),
  method: "GET",
  url: "https://example.com/api/items",
  type: "xhr",
  frame: "main",
  status: 200,
  mime: "application/json",
  size: 4198,
  ms: 230,
  failure: null,
  ...p,
});

describe("browser_network", () => {
  test("列表：外壳照写，缓冲里的条数与 last id 不受过滤影响", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.networkItems = [
      netEntry(),
      netEntry({ id: 42, type: "image", url: "https://example.com/a.png" }),
    ];
    page.networkDropped = 3;
    const out = textOf(await h.run("browser_network", { pageId }));
    expect(out).toBe(
      [
        "NETWORK: 示例页 | https://example.com/a",
        "REQUESTS: 2 in buffer · 2 shown · last id 42 · 3 older entries dropped",
        "#41 GET xhr 200 application/json 4.1 KB 230 ms https://example.com/api/items",
        "#42 GET image 200 application/json 4.1 KB 230 ms https://example.com/a.png",
      ].join("\n"),
    );
    expect(h.saved).toEqual([]);
    expect(h.masks).toEqual([]);
  });

  test("过滤条件转成 NetworkFilters：type / url / failed / after", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.networkItems = [
      netEntry(),
      netEntry({ id: 42, type: "image", url: "https://example.com/a.png" }),
      netEntry({
        id: 43,
        type: "script",
        url: "https://example.com/ad.js",
        status: null,
        failure: "net::ERR_BLOCKED_BY_CLIENT",
      }),
    ];
    const byType = textOf(
      await h.run("browser_network", { pageId, type: "IMAGE" }),
    );
    expect(byType).toContain("#42 GET image");
    expect(byType).not.toContain("#41 ");
    expect(byType).not.toContain("#43 ");
    expect(byType).toContain("FILTER: type=IMAGE");

    const byUrl = textOf(
      await h.run("browser_network", { pageId, url: "AD." }),
    );
    expect(byUrl).toContain("#43 ");
    expect(byUrl).not.toContain("#41 ");

    const failed = textOf(
      await h.run("browser_network", { pageId, failed: true }),
    );
    expect(failed.split("\n")[2]).toBe("FILTER: failed");
    expect(failed).toContain("#43 ");
    expect(failed).not.toContain("#41 ");

    const after = textOf(await h.run("browser_network", { pageId, after: 41 }));
    expect(after.split("\n")[2]).toBe("FILTER: after=41");
    expect(after).toContain("#42 ");
    expect(after).not.toContain("#41 ");
  });

  test("参数类型不对：中文错误，且不去碰页面", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const before = page.calls.length;
    expect(await error(h.run("browser_network", { pageId, type: 1 }))).toBe(
      "type 必须是字符串：如 xhr、image、document",
    );
    expect(await error(h.run("browser_network", { pageId, url: 1 }))).toBe(
      "url 必须是字符串：要匹配的地址片段，如 api",
    );
    expect(await error(h.run("browser_network", { pageId, failed: "x" }))).toBe(
      "failed 必须是布尔值：true 只看失败的与返回 4xx / 5xx 的请求",
    );
    expect(await error(h.run("browser_network", { pageId, after: -1 }))).toBe(
      "after 必须是大于等于 0 的整数",
    );
    expect(await error(h.run("browser_network", { pageId, after: 1.5 }))).toBe(
      "after 必须是大于等于 0 的整数",
    );
    expect(await error(h.run("browser_network", { pageId, id: 0 }))).toBe(
      "id 必须是大于等于 1 的整数",
    );
    expect(page.calls).toHaveLength(before);
  });

  test("给 id：走详情、忽略其余过滤；编号不在缓冲里报错", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.networkItems = [netEntry()];
    page.networkHeaders = { accept: "*/*", cookie: "sid=abc" };
    page.networkResponseHeaders = { "content-type": "application/json" };
    page.networkRequestBodyBytes = 120;
    const out = textOf(
      await h.run("browser_network", { pageId, id: 41, type: "image" }),
    );
    expect(out.split("\n")[0]).toBe(
      "REQUEST #41: 示例页 | https://example.com/a",
    );
    expect(out).toContain("STATUS: 200 · TYPE: xhr");
    expect(out).toContain("  cookie: sid=abc");
    expect(out).toContain("SIZE: response body 4.1 KB · request body 120 B");

    expect(await error(h.run("browser_network", { pageId, id: 99 }))).toBe(
      "没有编号为 99 的请求：它可能已被挤出缓冲（每页只留最近 500 条）",
    );
  });

  test("body 参数：只给 body、取值不对、没有 id 都要在碰页面之前报错", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const before = page.calls.length;
    expect(
      await error(h.run("browser_network", { pageId, body: "request" })),
    ).toBe("body 要和 id 一起给：先用列表找到请求编号");
    expect(
      await error(
        h.run("browser_network", { pageId, id: 41, body: "headers" }),
      ),
    ).toBe(
      "body 只能是 request 或 response：要取请求体给 request，要取响应体给 response",
    );
    expect(page.calls).toHaveLength(before);
  });

  test("取不到：编号不在缓冲里与 ok:false 的 reason 原样给模型", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.networkItems = [netEntry()];
    expect(
      await error(
        h.run("browser_network", { pageId, id: 99, body: "response" }),
      ),
    ).toBe("没有编号为 99 的请求：它可能已被挤出缓冲（每页只留最近 500 条）");

    page.networkBodies = {
      "41:response": {
        ok: false,
        reason: "请求失败了（net::ERR_CONNECTION_RESET），没有响应体",
      },
    };
    expect(
      await error(
        h.run("browser_network", { pageId, id: 41, body: "response" }),
      ),
    ).toBe("请求失败了（net::ERR_CONNECTION_RESET），没有响应体");
    // 取不到就是取不到：不落附件、不调遮罩。
    expect(h.saved).toEqual([]);
    expect(h.masks).toEqual([]);
  });

  test("文本响应体不超预览：内联预览，不存附件", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.networkItems = [netEntry()];
    page.networkBodies = {
      "41:response": {
        ok: true,
        mime: "application/json",
        bytes: Buffer.from('{"token":"abc"}', "utf8"),
      },
    };
    const out = textOf(
      await h.run("browser_network", { pageId, id: 41, body: "response" }),
    );
    expect(out.split("\n")).toEqual([
      "BODY #41 response: 示例页 | https://example.com/a",
      "MIME: application/json · SIZE: 15 B · text",
      '{"token":"abc"}',
    ]);
    expect(h.saved).toEqual([]);
  });

  test("文本请求体超预览：遮罩后落成附件，预览也是遮罩后的字", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.networkItems = [netEntry()];
    page.networkBodies = {
      "41:request": {
        ok: true,
        mime: "application/json",
        bytes: Buffer.from(`{"k":"secret","v":"${"x".repeat(4200)}"}`, "utf8"),
      },
    };
    const out = textOf(
      await h.run("browser_network", { pageId, id: 41, body: "request" }),
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("BODY #41 request: 示例页 | https://example.com/a");
    expect(lines[1]).toContain("· text");
    expect(lines[2]?.startsWith('{"k":"{{@secret}}"')).toBe(true);
    expect(lines.at(-2)).toMatch(/^… \(\+\d+ chars not shown\)$/);
    expect(lines.at(-1)).toBe(
      `FULL BODY: [attach_file] attachment:/2026-01-01/00000000-network-${pageId}-41-request.json (image, 1 KB)`,
    );
    // 落文件前确实遮过：附件里也是遮罩后的字。
    expect(h.saved.map((s) => s.name)).toEqual([
      `network-${pageId}-41-request.json`,
    ]);
    const full = h.saved[0]?.bytes.toString("utf8") ?? "";
    expect(full).toContain("{{@secret}}");
    expect(full).not.toContain('"secret"');
  });

  test("二进制响应体：附件字节与原字节一致，不过遮罩", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.networkItems = [netEntry()];
    // 含非法 UTF-8 的字节：presentBody 按二进制处理。
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    page.networkBodies = {
      "41:response": { ok: true, mime: "image/png", bytes },
    };
    const out = textOf(
      await h.run("browser_network", { pageId, id: 41, body: "response" }),
    );
    const lines = out.split("\n");
    expect(lines[1]).toBe("MIME: image/png · SIZE: 6 B · binary (not shown)");
    expect(lines[2]).toContain("FULL BODY: [attach_file]");
    expect(h.saved.map((s) => s.name)).toEqual([
      `network-${pageId}-41-response.png`,
    ]);
    expect(h.saved[0]?.bytes.equals(bytes)).toBe(true);
    expect(h.masks).toEqual([]);
  });

  test("超过 fileMaxBytes：中文报错，不落附件", async () => {
    const h = makeToolHarness({ fileMaxBytes: () => 4 });
    const { pageId, page } = await openViaTool(h);
    page.networkItems = [netEntry()];
    page.networkBodies = {
      "41:response": {
        ok: true,
        mime: "text/plain",
        bytes: Buffer.from("12345", "utf8"),
      },
    };
    expect(
      await error(
        h.run("browser_network", { pageId, id: 41, body: "response" }),
      ),
    ).toBe("内容有 5 B，超过大小上限（4 B）");
    expect(h.saved).toEqual([]);
  });

  test("超预算：全文遮罩后落成 network-<pageId>.txt，结果里带 FULL LOG 行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.networkItems = Array.from({ length: 200 }, (_, i) =>
      netEntry({
        id: i + 1,
        url: `https://example.com/item-${i}?secret=abc`,
      }),
    );
    const r = await h.run("browser_network", { pageId });
    expect(h.saved.map((s) => s.name)).toEqual([`network-${pageId}.txt`]);
    // 落文件前确实遮过：附件里是遮罩后的字。
    const full = h.saved[0]?.bytes.toString("utf8") ?? "";
    expect(h.masks).toHaveLength(1);
    expect(full).toContain("{{@secret}}");
    expect(full).toContain("#1 GET xhr");
    const out = textOf(r);
    expect(out).toContain("earlier entries omitted (200 shown in total)");
    expect(out).toContain("\nFULL LOG: [attach_file] attachment:");
  });

  test("参数与描述：url 有 maxLength 300、不带 intent，描述点明只读与能取请求体", async () => {
    const h = makeToolHarness();
    const descriptions = new Map<
      string,
      {
        description?: string;
        parameters?: { properties?: Record<string, unknown> };
      }
    >();
    const { browserTools } = await import("./tools.js");
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: { name: string; description?: string }) =>
        descriptions.set(t.name, t as never),
    } as never);
    const tool = descriptions.get("browser_network");
    const props = tool?.parameters?.properties ?? {};
    expect(Object.keys(props)).toEqual([
      "pageId",
      "type",
      "url",
      "failed",
      "after",
      "id",
      "body",
    ]);
    expect(props.body).toMatchObject({
      type: "string",
      enum: ["request", "response"],
    });
    expect(props.url).toMatchObject({ type: "string", maxLength: 300 });
    expect(props).not.toHaveProperty("intent");
    const d = tool?.description ?? "";
    expect(d).toContain("只读观察，不发送也不修改请求");
    expect(d).toContain("每页只留最近 500 条");
    expect(d).toContain("请求体或响应体");
    expect(d).not.toContain("打码");
    expect(d).not.toContain("不含请求体");
    expect(d).toContain("不可信");
  });

  test("观察类只读：不调 cleaner、不写审计、不记回放", async () => {
    const recorded: unknown[] = [];
    const h = makeToolHarness({
      recordStep: async (a) => {
        recorded.push(a);
      },
    });
    const { pageId, page } = await openViaTool(h);
    page.networkItems = [netEntry()];
    page.networkBodies = {
      "41:response": { ok: true, mime: "text/plain", bytes: Buffer.from("hi") },
    };
    const cleaned = h.cleaner.calls.length;
    const audited = h.audit.length;
    recorded.length = 0;
    await h.run("browser_network", { pageId });
    await h.run("browser_network", { pageId, id: 41 });
    await h.run("browser_network", { pageId, id: 41, body: "response" });
    expect(h.cleaner.calls).toHaveLength(cleaned);
    expect(h.audit).toHaveLength(audited);
    expect(recorded).toEqual([]);
    // 只读：不再多读一次快照（打开页面那一步读过）。
    expect(page.calls.filter((c) => c === "snapshot")).toHaveLength(1);
  });
});
