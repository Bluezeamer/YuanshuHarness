// route-tools 的行为：参数形状与每条校验、add / remove / clear 的动作骨架（授权 → 确认 → 做事 → 审计）、
// list 只读、不改地址就不授权。全部用替身：不装浏览器、不起进程、不连网络。
import { afterAll, describe, expect, test } from "vitest";
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

/** 直接在注册表里开一个页面（不经 browser_open，免得站点授权挡在打开那一步）。 */
async function openPage(h: ToolHarness, url = "https://example.com/a") {
  const { page } = await h.registry.open({
    workspaceKey: "w1",
    actor: h.sessionId,
    url,
  });
  return { pageId: page.id, page: h.ctx().pageAt(-1) };
}

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
  return tools.get("browser_route") ?? {};
}

describe("browser_route 参数形状", () => {
  test("pattern 与 body 的长度上限、没有 intent、只 required pageId", async () => {
    const tool = await spec();
    const props = tool.parameters?.properties ?? {};
    expect(props.pattern?.maxLength).toBe(500);
    expect(props.body?.maxLength).toBe(200_000);
    expect(props.op?.enum).toEqual(["add", "list", "remove", "clear"]);
    expect(props.action?.enum).toEqual(["block", "mock", "modify", "patch"]);
    expect(props).not.toHaveProperty("intent");
    expect(tool.parameters?.required).toEqual(["pageId"]);
    expect(tool.description).toContain("Content-Security-Policy");
    expect(tool.description).toContain("不可信");
  });
});

describe("browser_route 参数校验", () => {
  test("add 缺 pattern / action 报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openPage(h);
    expect(
      await error(
        h.run("browser_route", { pageId, op: "add", pattern: "**/a" }),
      ),
    ).toBe("add 要给 action：block、mock、modify、patch 之一");
    expect(
      await error(
        h.run("browser_route", { pageId, op: "add", action: "block" }),
      ),
    ).toContain("pattern 必须是字符串");
  });

  test("remove 缺 id 报错；list / clear 给了 add 的参数报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openPage(h);
    expect(await error(h.run("browser_route", { pageId, op: "remove" }))).toBe(
      "remove 要给 id：先用 op=list 看规则编号",
    );
    expect(
      await error(
        h.run("browser_route", { pageId, op: "list", pattern: "**/a" }),
      ),
    ).toBe("list 不用 pattern：list 只看现有规则，要加规则用 op=add");
    expect(
      await error(h.run("browser_route", { pageId, op: "clear", id: 1 })),
    ).toBe("clear 不用 id：clear 清掉全部规则，要删一条用 op=remove");
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "block",
          id: 2,
        }),
      ),
    ).toBe("add 只用规则参数：id 由引擎分配，要删规则用 op=remove");
  });

  test("不给与动作无关的参数：点名报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openPage(h);
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "block",
          body: "x",
        }),
      ),
    ).toBe(
      "block 不用 body：body 只用于 mock（造响应体）与 modify（改请求体）",
    );
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "mock",
          url: "https://x.test/b",
        }),
      ),
    ).toBe("mock 不用 url：url 只用于 modify（改成别的地址）");
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "patch",
          error: "failed",
        }),
      ),
    ).toBe("patch 不用 error：error 只用于 block（Playwright 的 errorCode）");
  });

  test("headers 的值类型：mock 只能字符串，modify / patch 可以 null", async () => {
    const h = makeToolHarness();
    const { pageId } = await openPage(h);
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "mock",
          headers: { "x-a": null },
        }),
      ),
    ).toBe("headers 的 x-a 必须是字符串：mock 的 headers 是要造出来的响应头");
    const { page } = { page: h.ctx().pageAt(-1) };
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "patch",
      headers: { "x-a": null, "x-b": "1" },
    });
    expect(page.routeAdds.at(-1)?.action).toEqual({
      kind: "patch",
      headers: { "x-a": null, "x-b": "1" },
    });
  });

  test("modify 一项都不改报错；patch 一项都不改报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openPage(h);
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "modify",
        }),
      ),
    ).toBe(
      "modify 没有要改的内容：url、modifyMethod、body、headers 至少给一项",
    );
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "patch",
        }),
      ),
    ).toBe("patch 没有要改的内容：status、headers、replace 至少给一项");
  });

  test("mock 缺省 200 与空体；status / delayMs 越界报错", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openPage(h);
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "mock",
    });
    expect(page.routeAdds.at(-1)?.action).toEqual({
      kind: "mock",
      status: 200,
      headers: {},
      body: "",
    });
    page.routeAdds.length = 0;
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "mock",
          status: 99,
        }),
      ),
    ).toBe("status 必须是 100–599 的整数，如 500");
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "block",
          delayMs: 10_001,
        }),
      ),
    ).toBe("delayMs 必须是 0–10000 的整数（毫秒）");
    expect(page.routeAdds).toEqual([]);
  });

  test("modifyMethod 归一成大写；method 过滤也归一", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openPage(h);
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      method: "post",
      action: "modify",
      modifyMethod: "put",
    });
    expect(page.routeAdds.at(-1)).toEqual({
      pattern: "**/a",
      method: "POST",
      action: { kind: "modify", method: "PUT" },
    });
  });

  test("replace 的形状：数组、对象、每项是字符串", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openPage(h);
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "patch",
          replace: "a",
        }),
      ),
    ).toContain("replace 必须是数组");
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "patch",
          replace: [{ find: "a" }],
        }),
      ),
    ).toContain("replace 第 1 项的 with 必须是字符串");
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "patch",
      replace: [{ find: "a", with: "b" }],
    });
    expect(page.routeAdds.at(-1)?.action).toEqual({
      kind: "patch",
      replace: [{ find: "a", with: "b" }],
    });
  });
});

describe("browser_route add", () => {
  test("登记规则，返回 ADDED 行（含摘要）", async () => {
    const { h } = harness();
    const { pageId, page } = await openPage(h);
    const out = textOf(
      await h.run("browser_route", {
        pageId,
        op: "add",
        pattern: "**/*.png",
        action: "block",
        type: "image",
        delayMs: 300,
      }),
    );
    expect(page.routeAdds).toEqual([
      {
        pattern: "**/*.png",
        type: "image",
        delayMs: 300,
        action: { kind: "block" },
      },
    ]);
    expect(out).toBe(
      "ADDED rule #1: block * image **/*.png error=failed delay 300 ms",
    );
  });

  test("高敏感站点要确认；摘要只有动作与 pattern，不含 body / headers 的值", async () => {
    const { h, confirms } = harness();
    const { pageId } = await openPage(h, "https://github.com/a");
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/api/**",
      action: "mock",
      headers: { authorization: "Bearer secret-token" },
      body: "top-secret-body",
    });
    expect(confirms).toEqual([
      {
        tool: "browser_route",
        host: "github.com",
        summary: "添加拦截规则 mock **/api/**",
      },
    ]);
    expect(JSON.stringify(confirms)).not.toContain("secret");
  });

  test("高敏感站点：remove 与 clear 也要确认", async () => {
    const { h, confirms } = harness();
    const { pageId } = await openPage(h, "https://github.com/a");
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/x",
      action: "block",
    });
    confirms.length = 0;
    await h.run("browser_route", { pageId, op: "remove", id: 1 });
    await h.run("browser_route", { pageId, op: "clear" });
    expect(confirms.map((c) => c.summary)).toEqual([
      "删除拦截规则 #1",
      "清空拦截规则",
    ]);
  });

  test("页面上挂着对话框时 list 照常能读（规则表在内存里）", async () => {
    const { h } = harness();
    const { pageId, page } = await openPage(h);
    page.emitDialog({ type: "alert", message: "hi", defaultValue: "" });
    expect(textOf(await h.run("browser_route", { pageId }))).toContain(
      "No rules.",
    );
  });

  test("acted 写审计与回放", async () => {
    const { h } = harness();
    const { pageId } = await openPage(h);
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "block",
    });
    expect(h.audit).toEqual([
      {
        tool: "browser_route",
        pageId,
        summary: "添加拦截规则 block **/a",
      },
    ]);
  });

  test("用户拒绝确认：抛错且不登记", async () => {
    const { h } = harness({}, [false]);
    const { pageId, page } = await openPage(h, "https://github.com/a");
    const msg = await error(
      h.run("browser_route", {
        pageId,
        op: "add",
        pattern: "**/a",
        action: "block",
      }),
    );
    expect(msg).toContain("没有批准");
    expect(page.routeAdds).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  test("引擎报错（第 21 条）原样抛给模型，不写审计", async () => {
    const { h } = harness();
    const { pageId, page } = await openPage(h);
    page.routeAddError = new Error("每个页面最多 20 条拦截规则：先删掉不用的");
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "block",
        }),
      ),
    ).toBe("每个页面最多 20 条拦截规则：先删掉不用的");
    expect(h.audit).toEqual([]);
  });
});

describe("browser_route 改地址的站点授权", () => {
  test("解析阶段被拒的地址原样抛给模型", async () => {
    const { h } = harness();
    const { pageId } = await openPage(h);
    // 本环境的服务地址只支持 http：https 的虚拟主机在解析阶段就抛。
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "modify",
          url: "https://web1.localhost:3000/x",
        }),
      ),
    ).toContain("服务地址只支持 http");
  });

  test("相对地址报错", async () => {
    const { h } = harness();
    const { pageId, page } = await openPage(h);
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "modify",
          url: "/api/items",
        }),
      ),
    ).toBe("modify 的 url 要写完整的 http(s) 地址");
    expect(page.routeAdds).toEqual([]);
  });

  test("授权被拒：抛错且不调 routeAdd", async () => {
    const { h } = harness({
      access: { approved: () => false, known: () => false },
    });
    h.approve = [false];
    const { pageId, page } = await openPage(h);
    expect(
      await error(
        h.run("browser_route", {
          pageId,
          op: "add",
          pattern: "**/a",
          action: "modify",
          url: "https://other.test/x",
        }),
      ),
    ).toBe("用户没有批准访问 https://other.test");
    expect(page.routeAdds).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  test("ask 被批准后登记；授权发生在确认之前", async () => {
    const order: string[] = [];
    const confirms: string[] = [];
    const h = makeToolHarness({
      access: { approved: () => false, known: () => false },
      async approveOpen() {
        order.push("authorize");
        return { allowed: true };
      },
      async confirmAction(args) {
        order.push("confirm");
        confirms.push(args.summary);
        return { allowed: true };
      },
    });
    const { pageId, page } = await openPage(h, "https://github.com/a");
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "modify",
      url: "https://other.test/x",
    });
    expect(order).toEqual(["authorize", "confirm"]);
    expect(page.routeAdds.at(-1)?.action).toEqual({
      kind: "modify",
      url: "https://other.test/x",
    });
  });

  test("不给 url 的 modify 不触发授权", async () => {
    const { h } = harness({
      access: { approved: () => false, known: () => false },
    });
    const { pageId, page } = await openPage(h);
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "modify",
      modifyMethod: "POST",
    });
    expect(h.approvals).toEqual([]);
    expect(page.routeAdds).toHaveLength(1);
  });

  test("block / mock / patch 都不触发授权", async () => {
    const { h } = harness({
      access: { approved: () => false, known: () => false },
    });
    const { pageId } = await openPage(h);
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "block",
    });
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "mock",
    });
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "patch",
      status: 500,
    });
    expect(h.approvals).toEqual([]);
  });
});

describe("browser_route remove / clear / list", () => {
  test("remove：删掉、返回 REMOVED", async () => {
    const { h } = harness();
    const { pageId, page } = await openPage(h);
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "block",
    });
    const out = textOf(
      await h.run("browser_route", { pageId, op: "remove", id: 1 }),
    );
    expect(out).toBe("REMOVED rule #1");
    expect(page.routes).toEqual([]);
    expect(h.audit.at(-1)?.summary).toBe("删除拦截规则 #1");
  });

  test("remove：不存在的编号报错", async () => {
    const { h } = harness();
    const { pageId } = await openPage(h);
    expect(
      await error(h.run("browser_route", { pageId, op: "remove", id: 7 })),
    ).toBe("没有编号为 7 的规则");
    expect(h.audit).toEqual([]);
  });

  test("clear：返回清掉的条数", async () => {
    const { h } = harness();
    const { pageId } = await openPage(h);
    for (const pattern of ["**/a", "**/b"])
      await h.run("browser_route", {
        pageId,
        op: "add",
        pattern,
        action: "block",
      });
    expect(textOf(await h.run("browser_route", { pageId, op: "clear" }))).toBe(
      "CLEARED 2 rules",
    );
    expect(h.audit.at(-1)?.summary).toBe("清空拦截规则");
  });

  test("list：走 observe、不确认、不审计，列出规则与命中次数", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openPage(h);
    page.setTitle("示例页");
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "block",
    });
    // 模拟请求命中过两次。
    const [added] = page.routes;
    if (added) added.hits = 2;
    const before = h.audit.length;
    const out = textOf(await h.run("browser_route", { pageId, op: "list" }));
    expect(out).toBe(
      [
        "ROUTES: 示例页 | https://example.com/a",
        "RULES: 1 (max 20)",
        "#1 block * * **/a error=failed (hits 2)",
      ].join("\n"),
    );
    // 普通站点不确认。
    expect(confirms).toEqual([]);
    expect(h.audit).toHaveLength(before);
    // op 缺省就是 list。
    expect(textOf(await h.run("browser_route", { pageId }))).toContain(
      "#1 block * * **/a",
    );
  });

  test("list：没有规则写 No rules.", async () => {
    const h = makeToolHarness();
    const { pageId } = await openPage(h);
    expect(textOf(await h.run("browser_route", { pageId }))).toBe(
      [
        "ROUTES: （无标题） | https://example.com/a",
        "RULES: 0 (max 20)",
        "No rules.",
      ].join("\n"),
    );
  });

  test("不调 cleaner", async () => {
    const { h } = harness();
    const { pageId } = await openPage(h);
    await h.run("browser_route", {
      pageId,
      op: "add",
      pattern: "**/a",
      action: "block",
    });
    await h.run("browser_route", { pageId });
    expect(h.cleaner.calls).toEqual([]);
  });
});
