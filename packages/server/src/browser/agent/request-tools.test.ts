// request-tools 的行为：参数形状与校验、身份透传与 JAR 行、站点授权、逐跳授权与重定向规则、
// 逐动作确认、响应体各形态、审计。全部用替身：不装浏览器、不起进程、不连网络。
import { afterAll, describe, expect, test } from "vitest";
import type { HttpResult } from "../engine/types.js";
import {
  cleanupTmpDirs,
  makeToolHarness,
  type ToolHarness,
  verdictOf,
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

/** 经工具打开一个站点：返回页面编号与它的假页面。 */
async function openViaTool(h: ToolHarness, target = "https://example.com/a") {
  await h.run("browser_open", { target });
  const pageId = h.registry.list("w1")[0]?.id as string;
  return { pageId, page: h.ctx().pageAt(-1) };
}

/** 直接在注册表里开一个页面（不经 browser_open，免得站点授权挡在打开那一步）。 */
async function openPage(h: ToolHarness, url = "https://example.com/a") {
  const { page } = await h.registry.open({
    workspaceKey: "w1",
    actor: h.sessionId,
    url,
  });
  return { pageId: page.id, page: h.ctx().pageAt(-1) };
}

const ok = (
  opts: {
    status?: number;
    statusText?: string;
    headers?: [string, string][];
    bytes?: Buffer | string;
    ms?: number;
  } = {},
): HttpResult => ({
  ok: true,
  status: opts.status ?? 200,
  statusText: opts.statusText ?? "OK",
  headers: opts.headers ?? [],
  bytes:
    opts.bytes === undefined
      ? Buffer.alloc(0)
      : typeof opts.bytes === "string"
        ? Buffer.from(opts.bytes)
        : opts.bytes,
  ms: opts.ms ?? 5,
});

/** 带确认替身的工作台：confirms 记下每次确认的入参，answers 按顺序回答。 */
function harness(
  overrides: Parameters<typeof makeToolHarness>[0] = {},
  answers: boolean[] = [],
) {
  const confirms: Array<{ tool: string; host: string; summary: string }> = [];
  const h = makeToolHarness({
    access: { approved: () => true, known: () => true },
    async confirmAction(args) {
      confirms.push(args);
      return verdictOf(answers.shift());
    },
    ...overrides,
  });
  return { h, confirms };
}

/** 直接把工具注册时的描述与参数抓出来。 */
async function spec() {
  const h = makeToolHarness();
  const tools = new Map<
    string,
    {
      description?: string;
      parameters?: {
        properties?: Record<string, { maxLength?: number; enum?: string[] }>;
        required?: string[];
      };
    }
  >();
  const { browserTools } = await import("./tools.js");
  browserTools(
    h.deps,
    h.sessionId,
  )({
    registerTool: (t: { name: string; description?: string }) =>
      tools.set(t.name, t as never),
  } as never);
  return tools.get("browser_request") ?? {};
}

describe("browser_request 参数形状", () => {
  test("url 与 body 的上限、method 的枚举、没有 intent", async () => {
    const tool = await spec();
    const props = tool.parameters?.properties ?? {};
    expect(props.url?.maxLength).toBe(2000);
    expect(props.body?.maxLength).toBe(200000);
    expect(props.method?.enum).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]);
    expect(props.identity?.maxLength).toBe(40);
    expect(props).not.toHaveProperty("intent");
    expect(tool.parameters?.required).toEqual(["pageId", "url"]);
  });

  test("描述写清身份的用法、不自动加头、缺省不跟随、授权与确认", async () => {
    const tool = await spec();
    const d = tool.description ?? "";
    expect(d).toContain("不自动加任何头");
    expect(d).toContain("缺省不跟随重定向");
    expect(d).toContain("站点授权");
    expect(d).toContain("identity");
    expect(d).toContain("不可信");
  });
});

describe("browser_request 校验", () => {
  test("url 解析不了、不是 http(s) 都报错", async () => {
    const { h } = harness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(h.run("browser_request", { pageId, url: "http://" })),
    ).toContain("url 解析不了");
    expect(
      await error(h.run("browser_request", { pageId, url: "ftp://a.test/x" })),
    ).toContain("url 只支持 http 与 https");
  });

  test("method 不在枚举里报错", async () => {
    const { h } = harness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(
        h.run("browser_request", { pageId, url: "/x", method: "TRACE" }),
      ),
    ).toContain("method 只能是");
  });

  test("headers 不是对象或有非字符串值报错", async () => {
    const { h } = harness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(h.run("browser_request", { pageId, url: "/x", headers: [] })),
    ).toContain("headers 必须是对象");
    expect(
      await error(
        h.run("browser_request", {
          pageId,
          url: "/x",
          headers: { "X-N": 1 },
        }),
      ),
    ).toContain("headers 的 X-N 必须是字符串");
  });

  test("GET 与 HEAD 不能带 body", async () => {
    const { h } = harness();
    const { pageId } = await openViaTool(h);
    for (const method of ["GET", "HEAD"])
      expect(
        await error(
          h.run("browser_request", { pageId, url: "/x", method, body: "a" }),
        ),
      ).toBe("GET 与 HEAD 不能带 body：要带 body 请用 POST 等方法");
  });

  test("identity 只许字母数字与 _ . -", async () => {
    const { h } = harness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(
        h.run("browser_request", { pageId, url: "/x", identity: "bob bob" }),
      ),
    ).toContain("identity 只能用字母、数字、下划线、点与连字符");
  });
});

describe("browser_request 基本路径", () => {
  test("相对地址按页面地址解析；不自动加头（引擎收到的就是 agent 给的）", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(
      h,
      "https://example.com/dir/page",
    );
    page.requestResults = [ok({ bytes: "hi" })];
    await h.run("browser_request", {
      pageId,
      url: "sub?q=1",
      headers: { "X-A": "1" },
    });
    expect(page.requests).toEqual([
      {
        url: "https://example.com/dir/sub?q=1",
        method: "GET",
        headers: { "X-A": "1" },
      },
    ]);
  });

  test("identity 透传给引擎；结果末尾有 JAR 行且不含 cookie 值", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.identityJars = { bob: ["sid", "csrf"] };
    page.requestResults = [
      ok({ headers: [["set-cookie", "sid=secret-value; Path=/"]] }),
    ];
    const out = textOf(
      await h.run("browser_request", {
        pageId,
        url: "https://example.com/x",
        identity: "bob",
      }),
    );
    expect(page.requests[0]?.identity).toBe("bob");
    expect(out).toContain("(via identity bob,");
    expect(out).toContain("JAR bob: 2 cookies (sid, csrf)");
    expect(out).toContain("set-cookie: sid=secret-value; Path=/");
    // 名字进 JAR 行，值不进
    expect(out.split("\n").find((l) => l.startsWith("JAR "))).not.toContain(
      "secret-value",
    );
  });

  test("没有这个身份：JAR 写 none", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [ok()];
    const out = textOf(
      await h.run("browser_request", {
        pageId,
        url: "/x",
        identity: "bob",
      }),
    );
    expect(out).toContain("JAR bob: none");
  });

  test("空响应体写 BODY: empty；HEAD 写 BODY: none (HEAD)", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [ok(), ok()];
    expect(
      textOf(await h.run("browser_request", { pageId, url: "/x" })),
    ).toContain("BODY: empty");
    expect(
      textOf(
        await h.run("browser_request", { pageId, url: "/x", method: "HEAD" }),
      ),
    ).toContain("BODY: none (HEAD)");
  });

  test("网络层拒绝：抛错，不写审计", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [{ ok: false, reason: "该地址落在内网" }];
    const msg = await error(h.run("browser_request", { pageId, url: "/x" }));
    expect(msg).toBe("该地址落在内网");
    expect(h.audit.filter((a) => a.tool === "browser_request")).toEqual([]);
  });
});

describe("browser_request 站点授权", () => {
  test("授权被拒：抛错、不调引擎、不写审计", async () => {
    const h = makeToolHarness({
      access: { approved: () => false, known: () => false },
      approveOpen: async () => ({ allowed: false, note: "" }),
    });
    const { pageId, page } = await openPage(h);
    const msg = await error(
      h.run("browser_request", { pageId, url: "https://other.test/x" }),
    );
    expect(msg).toBe("用户没有批准访问 https://other.test");
    expect(page.requests).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  test("解析阶段被拒的地址原样抛给模型（不包成成功结果）", async () => {
    const { h } = harness();
    const { pageId, page } = await openPage(h);
    // 本环境的服务地址只支持 http：https 的虚拟主机在解析阶段就抛。
    const msg = await error(
      h.run("browser_request", {
        pageId,
        url: "https://web1.localhost:3000/x",
      }),
    );
    expect(msg).toBe("服务地址只支持 http；https 只能用于公网域名");
    expect(page.requests).toEqual([]);
  });

  test("ask 时用户拒绝抛错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openPage(h);
    h.deps.access = { approved: () => false, known: () => false };
    h.deps.approveOpen = async () => ({ allowed: false, note: "" });
    expect(
      await error(
        h.run("browser_request", { pageId, url: "https://ask.test/" }),
      ),
    ).toBe("用户没有批准访问 https://ask.test");
  });
});

describe("browser_request 逐动作确认", () => {
  test("GET / HEAD / OPTIONS 不确认", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openViaTool(h, "https://github.com/a");
    page.requestResults = [ok(), ok(), ok()];
    for (const method of ["GET", "HEAD", "OPTIONS"])
      await h.run("browser_request", { pageId, url: "/x", method });
    expect(confirms).toEqual([]);
  });

  test("POST 走确认，host 是请求目标的主机，摘要不含路径、头与 body", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openViaTool(h, "https://example.com/a");
    page.requestResults = [ok({ status: 201, statusText: "Created" })];
    await h.run("browser_request", {
      pageId,
      url: "https://api.github.com/repos/x?token=abc",
      method: "POST",
      headers: { "X-Secret": "s3cr3t" },
      body: '{"password":"p@ss"}',
    });
    expect(confirms).toEqual([
      {
        tool: "browser_request",
        host: "api.github.com",
        summary: "发送 POST 请求到 api.github.com",
      },
    ]);
    expect(JSON.stringify(confirms)).not.toContain("abc");
    expect(JSON.stringify(confirms)).not.toContain("s3cr3t");
    expect(JSON.stringify(confirms)).not.toContain("p@ss");
  });

  test("确认被拒：不调引擎、不写审计", async () => {
    const { h } = harness({}, [false]);
    const { pageId, page } = await openViaTool(h, "https://github.com/a");
    const msg = await error(
      h.run("browser_request", {
        pageId,
        url: "/x",
        method: "POST",
        body: "a",
      }),
    );
    expect(msg).toContain("没有批准");
    expect(page.requests).toEqual([]);
    expect(h.audit.filter((a) => a.tool === "browser_request")).toEqual([]);
  });

  test("普通站点不确认", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [ok()];
    await h.run("browser_request", {
      pageId,
      url: "/x",
      method: "POST",
      body: "a",
    });
    expect(confirms).toEqual([]);
  });
});

describe("browser_request 重定向", () => {
  test("缺省不跟随：3xx 原样返回，含 Location", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [
      ok({
        status: 302,
        statusText: "Found",
        headers: [["location", "/next"]],
        bytes: "go",
      }),
    ];
    const out = textOf(await h.run("browser_request", { pageId, url: "/x" }));
    expect(page.requests).toHaveLength(1);
    expect(out).toContain("STATUS: 302 Found");
    expect(out).toContain("  location: /next");
    expect(out).not.toContain("REDIRECTS:");
  });

  test("follow：逐跳授权，换站点时再问一次；303 把 POST 改成 GET 并去掉 body", async () => {
    const approvals: string[] = [];
    const h = makeToolHarness({
      async approveOpen(args) {
        approvals.push(args.origin);
        return { allowed: true };
      },
      access: { approved: () => false, known: () => true },
    });
    const { pageId, page } = await openPage(h);
    page.requestResults = [
      ok({
        status: 303,
        statusText: "See Other",
        headers: [["location", "https://other.test/next"]],
      }),
      ok({ bytes: "done" }),
    ];
    const out = textOf(
      await h.run("browser_request", {
        pageId,
        url: "https://example.com/x",
        method: "POST",
        body: "a=1",
        follow: true,
      }),
    );
    expect(page.requests).toEqual([
      {
        url: "https://example.com/x",
        method: "POST",
        headers: {},
        body: "a=1",
      },
      { url: "https://other.test/next", method: "GET", headers: {} },
    ]);
    expect(approvals).toEqual(["https://example.com", "https://other.test"]);
    expect(out).toContain("REDIRECTS:");
    expect(out).toContain(
      "  303 POST https://example.com/x → https://other.test/next",
    );
    expect(out).toContain("STATUS: 200 OK");
    // 头行写起点，跟到哪去看 REDIRECTS
    expect(out.split("\n")[0]).toBe(
      `REQUEST: POST https://example.com/x  (via page ${pageId}, 10 ms)`,
    );
  });

  test("307 保持方法与 body", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [
      ok({
        status: 307,
        statusText: "Temporary Redirect",
        headers: [["location", "/next"]],
      }),
      ok({ bytes: "done" }),
    ];
    await h.run("browser_request", {
      pageId,
      url: "/x",
      method: "POST",
      body: "a=1",
      follow: true,
    });
    expect(page.requests[1]).toEqual({
      url: "https://example.com/next",
      method: "POST",
      headers: {},
      body: "a=1",
    });
  });

  test("307 跟到别的主机：非只读方法在新主机上再确认一次，同主机不再问", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openPage(h, "https://github.com/a");
    page.requestResults = [
      ok({
        status: 307,
        statusText: "Temporary Redirect",
        headers: [["location", "https://gist.github.com/next"]],
      }),
      ok({
        status: 307,
        statusText: "Temporary Redirect",
        headers: [["location", "/again"]],
      }),
      ok({ bytes: "done" }),
    ];
    await h.run("browser_request", {
      pageId,
      url: "https://github.com/x",
      method: "POST",
      body: "a=1",
      follow: true,
    });
    expect(confirms.map((c) => c.host)).toEqual([
      "github.com",
      "gist.github.com",
    ]);
  });

  test("页面上挂着对话框时也能发请求：这个工具不碰页面线程", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [ok({ bytes: "fine" })];
    page.emitDialog({ type: "alert", message: "hi", defaultValue: "" });
    const out = textOf(await h.run("browser_request", { pageId, url: "/x" }));
    expect(out).toContain("STATUS: 200 OK");
  });

  test("最多跟 10 跳：第 11 跳停下并写明", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [
      ...Array.from({ length: 11 }, () =>
        ok({
          status: 302,
          statusText: "Found",
          headers: [["location", "/next"]],
        }),
      ),
      ok({ bytes: "too late" }),
    ];
    const out = textOf(
      await h.run("browser_request", { pageId, url: "/x", follow: true }),
    );
    // 初始这一跳加上跟随的 10 跳
    expect(page.requests).toHaveLength(11);
    expect(out).toContain("已经跟随了 10 跳重定向");
    expect(out).toContain("STATUS: 302 Found");
  });

  test("跟随中的下一跳解析不了：停在上一跳并写 stopped", async () => {
    const { h } = harness();
    const { pageId, page } = await openPage(h);
    page.requestResults = [
      ok({
        status: 302,
        statusText: "Found",
        headers: [["location", "https://web1.localhost:3000/x"]],
      }),
    ];
    const out = textOf(
      await h.run("browser_request", {
        pageId,
        url: "https://example.com/x",
        follow: true,
      }),
    );
    expect(page.requests).toHaveLength(1);
    expect(out).toContain(
      "(stopped: 服务地址只支持 http；https 只能用于公网域名)",
    );
    expect(out).toContain("STATUS: 302 Found");
  });

  test("跟随中下一跳的 Location 解析不了：停在这一跳并写明", async () => {
    const { h } = harness();
    const { pageId, page } = await openPage(h);
    page.requestResults = [
      ok({
        status: 302,
        statusText: "Found",
        headers: [["location", "http://[bad"]],
      }),
    ];
    const out = textOf(
      await h.run("browser_request", {
        pageId,
        url: "https://example.com/x",
        follow: true,
      }),
    );
    expect(page.requests).toHaveLength(1);
    expect(out).toContain("(stopped: 下一跳的地址解析不了：http://[bad)");
  });

  test("跟随中某一跳授权被拒：停在上一跳并写 stopped", async () => {
    const h = makeToolHarness({
      access: {
        approved: (w, origin) => w === "w1" && origin === "https://example.com",
        known: () => true,
      },
      approveOpen: async () => ({ allowed: false, note: "" }),
    });
    const { pageId, page } = await openPage(h);
    page.requestResults = [
      ok({
        status: 302,
        statusText: "Found",
        headers: [["location", "https://other.test/n"]],
      }),
    ];
    const out = textOf(
      await h.run("browser_request", {
        pageId,
        url: "https://example.com/x",
        follow: true,
      }),
    );
    expect(page.requests).toHaveLength(1);
    expect(out).toContain("(stopped: 用户没有批准访问 https://other.test)");
    expect(out).toContain("STATUS: 302 Found");
  });
});

describe("browser_request 响应体", () => {
  test("文本内联；超长存附件，落文件前过 mask", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    const long = `secret ${"x".repeat(5000)}`;
    page.requestResults = [
      ok({
        headers: [["content-type", "text/plain; charset=utf-8"]],
        bytes: long,
      }),
    ];
    const out = textOf(await h.run("browser_request", { pageId, url: "/x" }));
    expect(out).toMatch(/BODY: text\/plain · [45]\.[0-9] KB · text/);
    expect(out).toContain("… (+");
    expect(out).toContain("FULL BODY: [attach_file]");
    expect(h.masks.length).toBe(1);
    expect(h.saved[0]?.name).toBe(`request-${pageId}.txt`);
    expect(h.saved[0]?.bytes.toString("utf8")).toContain("{{@secret}}");
  });

  test("二进制存附件，文件名带 pageId 与扩展名", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [
      ok({
        headers: [["content-type", "image/png"]],
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
      }),
    ];
    const out = textOf(await h.run("browser_request", { pageId, url: "/img" }));
    expect(out).toContain("binary (not shown)");
    expect(out).toContain("FULL BODY: [attach_file]");
    expect(h.saved[0]?.name).toBe(`request-${pageId}.png`);
  });

  test("超过附件上限：写 BODY: not saved，状态与头照给", async () => {
    const { h } = harness({ fileMaxBytes: () => 10 });
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [
      ok({
        status: 201,
        statusText: "Created",
        headers: [["content-type", "text/plain"]],
        bytes: "x".repeat(100),
      }),
    ];
    const out = textOf(await h.run("browser_request", { pageId, url: "/x" }));
    expect(out).toContain("BODY: not saved — 内容有");
    expect(out).toContain("超过大小上限");
    expect(out).toContain("STATUS: 201 Created");
    expect(out).toContain("  content-type: text/plain");
  });
});

describe("browser_request 审计", () => {
  test("发出请求后写审计，摘要只有方法与主机", async () => {
    const h = makeToolHarness({
      access: { approved: () => true, known: () => true },
    });
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [ok()];
    await h.run("browser_request", {
      pageId,
      url: "https://api.example.com/a/b?token=abc",
      method: "POST",
      body: "x=1",
    });
    expect(h.audit.at(-1)).toEqual({
      tool: "browser_request",
      pageId,
      summary: "POST api.example.com",
    });
    expect(JSON.stringify(h.audit)).not.toContain("token");
  });

  test("跟随时写最后一跳", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [
      ok({
        status: 302,
        statusText: "Found",
        headers: [["location", "https://b.test/n"]],
      }),
      ok(),
    ];
    await h.run("browser_request", {
      pageId,
      url: "https://a.test/x",
      follow: true,
    });
    expect(h.audit.at(-1)?.summary).toBe("GET b.test");
  });

  test("不调清洗器", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.requestResults = [ok()];
    const cleaned = h.cleaner.calls.length;
    await h.run("browser_request", { pageId, url: "/x" });
    expect(h.cleaner.calls).toHaveLength(cleaned);
  });
});
