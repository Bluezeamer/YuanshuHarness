// storage-tools 的行为：参数校验、get 只读、写操作的确认与审计（摘要不含值）、超预算落附件前遮罩。
// 全部用替身：不装浏览器、不起进程、不连网络。
import { afterAll, describe, expect, test } from "vitest";
import type { PageCookie } from "../engine/types.js";
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

/** 经工具打开一个站点：返回页面编号与它的假页面。 */
async function openViaTool(h: ToolHarness, target = "https://example.com/a") {
  await h.run("browser_open", { target });
  const pageId = h.registry.list("w1")[0]?.id as string;
  return { pageId, page: h.ctx().pageAt(-1) };
}

/** 带确认替身的工作台：confirms 记下每次确认的入参。 */
function harness(overrides: Parameters<typeof makeToolHarness>[0] = {}) {
  const confirms: Array<{ tool: string; host: string; summary: string }> = [];
  const h = makeToolHarness({
    async confirmAction(args) {
      confirms.push(args);
      return { allowed: true };
    },
    ...overrides,
  });
  return { h, confirms };
}

const cookie = (p: Partial<PageCookie> = {}): PageCookie => ({
  name: "sid",
  value: "abc123",
  domain: ".x.test",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  ...p,
});

describe("browser_storage：get", () => {
  test("cookies：scope 缺省 page，外壳带页面地址", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.cookieList = { page: [cookie()], all: [] };
    const out = textOf(
      await h.run("browser_storage", { pageId, kind: "cookies" }),
    );
    expect(page.calls).toContain("cookies page");
    expect(out).toBe(
      [
        "STORAGE: cookies · scope page (https://example.com/a) | 示例页",
        "COOKIES: 1",
        "#1 sid  .x.test  /  session  httpOnly secure SameSite=Lax  value: abc123",
      ].join("\n"),
    );
  });

  test("cookies：scope all 与只列一个 name", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.cookieList = {
      page: [],
      all: [
        cookie(),
        cookie({ name: "theme", value: "dark", httpOnly: false }),
      ],
    };
    const all = textOf(
      await h.run("browser_storage", {
        pageId,
        kind: "cookies",
        scope: "all",
        name: "theme",
      }),
    );
    expect(page.calls).toContain("cookies all");
    expect(all.split("\n").slice(0, 2)).toEqual([
      "STORAGE: cookies · scope all | （无标题）",
      "COOKIES: 1",
    ]);
    expect(all).toContain("dark");
    expect(all).not.toContain("abc123");
  });

  test("local / session：head 行写源与对象名，条目按键名顺序", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.webStorageResult = {
      entries: [
        { key: "b", value: "2" },
        { key: "a", value: "1" },
      ],
      changed: 0,
    };
    const out = textOf(
      await h.run("browser_storage", { pageId, kind: "local" }),
    );
    expect(page.storageOps).toEqual([{ kind: "local", op: { op: "get" } }]);
    expect(out).toBe(
      [
        "STORAGE: localStorage · https://example.com | 示例页",
        "#1 b: 2",
        "#2 a: 1",
      ].join("\n"),
    );
  });

  test("local 给 name：只取那一个键", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_storage", { pageId, kind: "session", name: "k" });
    expect(page.storageOps).toEqual([
      { kind: "session", op: { op: "get", key: "k" } },
    ]);
  });

  test("没有条目写 No cookies. / No entries.", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(
      textOf(await h.run("browser_storage", { pageId, kind: "cookies" })),
    ).toContain("\nNo cookies.");
    expect(
      textOf(await h.run("browser_storage", { pageId, kind: "local" })),
    ).toContain("\nNo entries.");
  });

  test("get 只读：不确认、不写审计与回放", async () => {
    const recorded: unknown[] = [];
    const { h, confirms } = harness({
      recordStep: async (a) => {
        recorded.push(a);
      },
    });
    const { pageId } = await openViaTool(h, "https://github.com/a");
    const audited = h.audit.length;
    recorded.length = 0;
    await h.run("browser_storage", { pageId, kind: "cookies" });
    await h.run("browser_storage", { pageId, kind: "local" });
    expect(confirms).toEqual([]);
    expect(h.audit).toHaveLength(audited);
    expect(recorded).toEqual([]);
  });

  test("用户正在操作页面：get 照常读，写操作被拒（读不占操作权）", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.registry.control(pageId, "user");
    expect(
      textOf(await h.run("browser_storage", { pageId, kind: "local" })),
    ).toContain("No entries.");
    const err = await h
      .run("browser_storage", { pageId, kind: "local", op: "clear" })
      .then(
        () => null,
        (e: Error) => e.message,
      );
    expect(err).toContain("用户正在操作");
  });

  test("超预算：全文遮罩后存成附件，末尾带 FULL LIST 行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.cookieList = {
      page: Array.from({ length: 200 }, (_, i) =>
        cookie({ name: `c${i}`, value: `secret ${"x".repeat(100)}` }),
      ),
      all: [],
    };
    const out = textOf(
      await h.run("browser_storage", { pageId, kind: "cookies" }),
    );
    expect(h.saved.map((s) => s.name)).toEqual([`storage-${pageId}.txt`]);
    const saved = h.saved[0]?.bytes.toString("utf8") ?? "";
    // 落文件前确实调了 deps.mask。
    expect(h.masks).toHaveLength(1);
    expect(saved).toContain("{{@secret}}");
    expect(saved).not.toContain("secret ");
    expect(out).toContain("more lines (200 lines total)");
    expect(out).toContain("\nFULL LIST: [attach_file] attachment:");
  });
});

describe("browser_storage：写操作", () => {
  test("set cookie：只给 name / value，按页面地址落；返回一句不带值", async () => {
    const h = makeToolHarness({
      async confirmAction() {
        return { allowed: true };
      },
    });
    const { pageId, page } = await openViaTool(h);
    const out = textOf(
      await h.run("browser_storage", {
        pageId,
        kind: "cookies",
        op: "set",
        name: "sid",
        value: "超级秘密",
      }),
    );
    expect(page.cookieWrites).toEqual([{ name: "sid", value: "超级秘密" }]);
    expect(out).toBe("SET cookie sid (domain example.com, path /)");
    expect(out).not.toContain("超级秘密");
  });

  test("set cookie：domain / path / expires / 三个布尔 / SameSite 都透传", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const out = textOf(
      await h.run("browser_storage", {
        pageId,
        kind: "cookies",
        op: "set",
        name: "sid",
        value: "v",
        domain: ".x.test",
        path: "/app",
        expires: 1_800_000_000,
        httpOnly: true,
        secure: false,
        sameSite: "Strict",
      }),
    );
    expect(page.cookieWrites[0]).toEqual({
      name: "sid",
      value: "v",
      domain: ".x.test",
      path: "/app",
      expires: 1_800_000_000,
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
    });
    expect(out).toBe("SET cookie sid (domain .x.test, path /app)");
  });

  test("set cookie 空串值也给；引擎的报错取原始信息", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setCookieError = new Error(
      "browserContext.addCookies: Cookie should have a url or a domain/path pair",
    );
    const msg = await error(
      h.run("browser_storage", {
        pageId,
        kind: "cookies",
        op: "set",
        name: "sid",
        value: "",
      }),
    );
    expect(msg).toContain("Cookie should have a url or a domain/path pair");
    expect(page.cookieWrites).toEqual([{ name: "sid", value: "" }]);
  });

  test("delete / clear：传给引擎的 scope 与 name 对得上，返回计数", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.removedCookies = 2;
    expect(
      textOf(
        await h.run("browser_storage", {
          pageId,
          kind: "cookies",
          op: "delete",
          name: "sid",
        }),
      ),
    ).toBe("DELETED 2 cookies (scope page)");
    expect(page.cookieRemovals).toEqual([{ scope: "page", name: "sid" }]);

    page.removedCookies = 0;
    expect(
      textOf(
        await h.run("browser_storage", {
          pageId,
          kind: "cookies",
          op: "clear",
          scope: "all",
        }),
      ),
    ).toBe("DELETED 0 cookies (scope all)");
    expect(page.cookieRemovals[1]).toEqual({ scope: "all" });
  });

  test("Web 存储的 set / delete / clear：键与值传给引擎，返回文字不带值", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.webStorageResult = {
      entries: [{ key: "theme", value: "dark" }],
      changed: 1,
    };
    expect(
      textOf(
        await h.run("browser_storage", {
          pageId,
          kind: "local",
          op: "set",
          name: "theme",
          value: "dark",
        }),
      ),
    ).toBe('SET localStorage key "theme"');
    page.webStorageResult = { entries: [], changed: 1 };
    expect(
      textOf(
        await h.run("browser_storage", {
          pageId,
          kind: "session",
          op: "delete",
          name: "theme",
        }),
      ),
    ).toBe('DELETED sessionStorage key "theme"');
    page.webStorageResult = { entries: [], changed: 5 };
    expect(
      textOf(
        await h.run("browser_storage", { pageId, kind: "local", op: "clear" }),
      ),
    ).toBe("CLEARED 5 entries from localStorage");
    expect(page.storageOps).toEqual([
      { kind: "local", op: { op: "set", key: "theme", value: "dark" } },
      { kind: "session", op: { op: "delete", key: "theme" } },
      { kind: "local", op: { op: "clear" } },
    ]);
  });

  test("没删到：DELETED 0 是正常结果，不是错误", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.webStorageResult = { entries: [], changed: 0 };
    expect(
      textOf(
        await h.run("browser_storage", {
          pageId,
          kind: "local",
          op: "delete",
          name: "nope",
        }),
      ),
    ).toBe('DELETED 0 entries from localStorage (key "nope")');
    page.removedCookies = 0;
    expect(
      textOf(
        await h.run("browser_storage", {
          pageId,
          kind: "cookies",
          op: "delete",
          name: "nope",
        }),
      ),
    ).toBe("DELETED 0 cookies (scope page)");
  });

  test("高敏感站点：写操作走确认，摘要只有名字不含值；审计与回放同摘要", async () => {
    const recorded: Array<{ tool: string; summary: string }> = [];
    const { h, confirms } = harness({
      recordStep: async (a) => {
        recorded.push({ tool: a.tool, summary: a.summary });
      },
    });
    const { pageId } = await openViaTool(h, "https://github.com/a");
    recorded.length = 0;
    await h.run("browser_storage", {
      pageId,
      kind: "cookies",
      op: "set",
      name: "sid",
      value: "my-secret-token",
    });
    await h.run("browser_storage", {
      pageId,
      kind: "local",
      op: "set",
      name: "theme",
      value: "my-secret-token",
    });
    await h.run("browser_storage", {
      pageId,
      kind: "cookies",
      op: "delete",
      name: "sid",
    });
    await h.run("browser_storage", { pageId, kind: "cookies", op: "clear" });
    await h.run("browser_storage", {
      pageId,
      kind: "local",
      op: "delete",
      name: "theme",
    });
    await h.run("browser_storage", { pageId, kind: "local", op: "clear" });
    const summaries = [
      "写入 cookie sid",
      "写入 localStorage 键 theme",
      "删除 cookie sid",
      "清空 cookies（page）",
      "删除 localStorage 键 theme",
      "清空 localStorage",
    ];
    expect(confirms.map((c) => c.summary)).toEqual(summaries);
    expect(h.audit.at(-1)).toEqual({
      tool: "browser_storage",
      pageId,
      summary: "清空 localStorage",
    });
    expect(recorded.map((r) => r.summary)).toEqual(summaries);
    const json = JSON.stringify({ confirms, audit: h.audit, recorded });
    expect(json).not.toContain("my-secret-token");
  });

  test("确认被拒：不写任何东西", async () => {
    const h = makeToolHarness({
      async confirmAction() {
        return { allowed: false, note: "" };
      },
    });
    const { pageId, page } = await openViaTool(h, "https://github.com/a");
    const msg = await error(
      h.run("browser_storage", {
        pageId,
        kind: "cookies",
        op: "set",
        name: "sid",
        value: "v",
      }),
    );
    expect(msg).toContain("没有批准");
    expect(page.cookieWrites).toEqual([]);
  });
});

describe("browser_storage：参数校验", () => {
  /** 每次都新开一个工具调用：报错要在碰页面之前抛出来。 */
  const setup = async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const before = page.calls.length;
    const run = (params: Record<string, unknown>) =>
      error(h.run("browser_storage", { pageId, ...params }));
    return { h, page, run, untouched: () => page.calls.length - before };
  };

  test("kind 必填且只能是三个值；op / scope / sameSite 只接受枚举值", async () => {
    const { run, untouched } = await setup();
    expect(await run({})).toBe("kind 必填：cookies、local 或 session");
    expect(await run({ kind: "indexeddb" })).toContain("kind 只能是");
    expect(await run({ kind: "cookies", op: "list" })).toContain("op 只能是");
    expect(await run({ kind: "cookies", scope: "browser" })).toContain(
      "scope 只能是",
    );
    expect(
      await run({
        kind: "cookies",
        op: "set",
        name: "a",
        value: "b",
        sameSite: "None ",
      }),
    ).toContain("sameSite 只能是");
    expect(untouched()).toBe(0);
  });

  test("set / delete 必须给 name，set 必须给 value；clear 不要 name", async () => {
    const { run } = await setup();
    expect(await run({ kind: "cookies", op: "set", value: "v" })).toBe(
      "set 要给 name：要写哪个 Cookie 或哪个存储键",
    );
    expect(await run({ kind: "cookies", op: "delete" })).toBe(
      "delete 要给 name：要删哪个 Cookie 或哪个存储键",
    );
    expect(await run({ kind: "cookies", op: "set", name: "a" })).toBe(
      "set 要给 value（可以是空串）：要写进去的值",
    );
    expect(await run({ kind: "cookies", op: "clear", name: "a" })).toBe(
      "clear 清掉整个范围，不要给 name；要删一个用 delete",
    );
  });

  test("非 cookies 的 kind 给了 Cookie 属性或 scope 就报错，不静默忽略", async () => {
    const { run } = await setup();
    expect(
      await run({
        kind: "local",
        op: "set",
        name: "a",
        value: "b",
        secure: true,
      }),
    ).toBe(
      "secure 只能跟 kind=cookies 一起给：domain、path、expires、httpOnly、secure、sameSite 只对 kind=cookies 的 set 有意义，localStorage 没有这些属性",
    );
    expect(await run({ kind: "session", domain: ".x.test" })).toContain(
      "domain 只能跟 kind=cookies 一起给",
    );
    expect(await run({ kind: "local", scope: "all" })).toBe(
      "scope 只对 kind=cookies 有意义：Cookie 分当前页面的与整个浏览器的，Web 存储没有这个区分",
    );
  });

  test("Cookie 属性的类型不对就报错", async () => {
    const { run } = await setup();
    const set = (extra: Record<string, unknown>) =>
      run({ kind: "cookies", op: "set", name: "a", value: "b", ...extra });
    expect(await set({ domain: 1 })).toBe(
      "domain 必须是字符串，如 example.com",
    );
    expect(await set({ path: 1 })).toBe("path 必须是字符串，如 /app");
    expect(await set({ expires: "明天" })).toContain("expires 必须是 Unix 秒");
    expect(await set({ httpOnly: "yes" })).toBe("httpOnly 必须是布尔值");
    expect(await set({ secure: "yes" })).toBe("secure 必须是布尔值");
  });

  test("value 有 maxLength 100000，参数里没有 intent", async () => {
    const h = makeToolHarness();
    const tools = new Map<
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
        tools.set(t.name, t as never),
    } as never);
    const tool = tools.get("browser_storage") ?? {};
    const props = tool.parameters?.properties ?? {};
    expect(props.value).toMatchObject({ type: "string", maxLength: 100_000 });
    expect(props.kind).toMatchObject({ enum: ["cookies", "local", "session"] });
    expect(props.op).toMatchObject({ enum: ["get", "set", "delete", "clear"] });
    expect(props.scope).toMatchObject({ enum: ["page", "all"] });
    expect(props).not.toHaveProperty("intent");
    const d = tool.description ?? "";
    expect(d).toContain("HttpOnly");
    expect(d).toContain("browser_exec");
    expect(d).toContain("不可信");
  });
});
