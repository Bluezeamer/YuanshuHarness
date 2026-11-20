// cdp-tools 的行为：参数校验、命令透传、结果外壳、超预算落附件前遮罩、30 秒超时。
// 全部用替身：不装浏览器、不起进程。
import { afterAll, describe, expect, test, vi } from "vitest";
import { INLINE_MAX } from "./budget.js";
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

describe("browser_cdp", () => {
  test("方法名与 params 原样交给引擎，结果缩进成 JSON 并带外壳", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.cdpResults = [{ cookies: [{ name: "sid" }] }];
    // 这一类工具不读页面内容，不经清洗器（browser_open 自己读一次）
    const cleaned = h.cleaner.calls.length;
    const out = textOf(
      await h.run("browser_cdp", {
        pageId,
        method: "Network.getCookies",
        params: { urls: ["https://example.com/a"] },
      }),
    );
    expect(page.cdpCalls).toEqual([
      {
        method: "Network.getCookies",
        params: { urls: ["https://example.com/a"] },
      },
    ]);
    const json = JSON.stringify({ cookies: [{ name: "sid" }] }, null, 2);
    expect(out).toBe(
      [
        "CDP: Network.getCookies | 示例页 | https://example.com/a",
        `RESULT (${json.length} chars):`,
        json,
      ].join("\n"),
    );
    expect(h.saved).toEqual([]);
    expect(h.cleaner.calls).toHaveLength(cleaned);
  });

  test("不给 params 时传 undefined；结果为空时写 {}", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.cdpResults = [undefined];
    const out = textOf(
      await h.run("browser_cdp", { pageId, method: "Page.enable" }),
    );
    expect(page.cdpCalls).toEqual([{ method: "Page.enable" }]);
    expect(out.split("\n").slice(1)).toEqual(["RESULT (2 chars):", "{}"]);
  });

  test("审计摘要只含方法名，不含 params", async () => {
    const { h } = harness();
    const { pageId } = await openViaTool(h);
    await h.run("browser_cdp", {
      pageId,
      method: "Network.setCookie",
      params: { name: "sid", value: "secret-token" },
    });
    expect(h.audit.at(-1)).toEqual({
      tool: "browser_cdp",
      pageId,
      summary: "CDP Network.setCookie",
    });
    expect(h.audit.at(-1)?.summary).not.toContain("secret-token");
  });

  test("method 的形状与长度、params 的形状与大小", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    expect(
      await error(h.run("browser_cdp", { pageId, method: "getCookies" })),
    ).toBe("method 要写成 Domain.method，如 Network.getCookies");
    expect(
      await error(h.run("browser_cdp", { pageId, method: "Network." })),
    ).toBe("method 要写成 Domain.method，如 Network.getCookies");
    expect(await error(h.run("browser_cdp", { pageId, method: 1 }))).toBe(
      "method 必须是字符串：Domain.method 形式，如 Network.getCookies",
    );
    expect(
      await error(
        h.run("browser_cdp", {
          pageId,
          method: `Network.${"a".repeat(100)}`,
        }),
      ),
    ).toContain("method 最长 100 个字符");
    expect(
      await error(
        h.run("browser_cdp", {
          pageId,
          method: "Runtime.evaluate",
          params: [],
        }),
      ),
    ).toBe('params 必须是对象，如 {"url": "https://x.test"}');
    expect(
      await error(
        h.run("browser_cdp", {
          pageId,
          method: "Runtime.evaluate",
          params: { expression: "x".repeat(100_001) },
        }),
      ),
    ).toContain("params 序列化后最长 100000 个字符");
    expect(
      await error(h.run("browser_cdp", { pageId: "", method: "Page.enable" })),
    ).toContain("pageId 必须是");
    expect(page.cdpCalls).toEqual([]);
  });

  test("超预算：按行截断、全文落附件，落文件前过遮罩", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    // 一条很长的结果：每行 60 字符、2000 行，远超 12000 的内联上限。
    const rows = Array.from({ length: 2000 }, (_, i) => `"line ${i} secret"`);
    page.cdpResults = [{ rows }];
    const out = textOf(
      await h.run("browser_cdp", { pageId, method: "Performance.getMetrics" }),
    );
    // 落附件前遮过罩：测试替身把 secret 换成 {{@secret}}
    expect(h.masks).toHaveLength(1);
    expect(h.masks[0]).toContain("secret");
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.name).toBe(`cdp-${pageId}.json`);
    const saved = h.saved[0]?.bytes.toString("utf8") ?? "";
    expect(saved).toContain("{{@secret}}");
    // 给模型的文字是截断的那份，并带附件标记行
    expect(out).toContain("more lines");
    expect(out).toContain("full result is saved as an attachment");
    expect(out).toMatch(/FULL RESULT: \[attach_file\]/);
    expect(out.length).toBeLessThan(INLINE_MAX);
  });

  test("命令失败：错误只取一行", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.cdpError = new Error("'Foo.bar' wasn't found\n  at module");
    expect(
      await error(h.run("browser_cdp", { pageId, method: "Foo.bar" })),
    ).toBe("'Foo.bar' wasn't found");
  });

  test("30 秒没有返回就超时", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.cdp = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const pending = h.run("browser_cdp", {
        pageId,
        method: "HeapProfiler.takeHeapSnapshot",
      });
      const failure = error(pending);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await failure).toBe(
        "CDP 命令 HeapProfiler.takeHeapSnapshot 30 秒内没有返回",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("高敏感站点：先逐动作确认，拒绝时不发命令", async () => {
    const { h } = harness();
    h.deps.access = { approved: () => true, known: () => true };
    const confirms: Array<{ tool: string; host: string; summary: string }> = [];
    h.deps.confirmAction = async (args) => {
      confirms.push(args);
      return { allowed: false, note: "" };
    };
    await h.run("browser_open", { target: "https://github.com/a" });
    const pageId = h.registry.list("w1")[0]?.id as string;
    const page = h.ctx().pageAt(-1);
    const msg = await error(
      h.run("browser_cdp", { pageId, method: "Page.reload" }),
    );
    expect(msg).toContain("用户没有批准");
    expect(confirms).toEqual([
      {
        tool: "browser_cdp",
        host: "github.com",
        summary: "发送 CDP 命令 Page.reload",
      },
    ]);
    expect(page.cdpCalls).toEqual([]);
  });
});
