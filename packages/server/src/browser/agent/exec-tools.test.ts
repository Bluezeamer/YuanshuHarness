// exec-tools 的行为：参数校验、ref 透传、返回外壳、超预算落附件前遮罩、高敏感站点的确认与审计摘要。
// 全部用替身：不装浏览器、不起进程、不连网络。
import { afterAll, describe, expect, test } from "vitest";
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

/** 直接把工具描述与参数抓出来（注册时的那份）。 */
async function spec() {
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
  return tools.get("browser_exec") ?? {};
}

describe("browser_exec", () => {
  test("脚本与 ref 原样交给引擎，返回 EXEC 外壳", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.execResult = { kind: "value", json: '{\n  "a": 1\n}' };
    const out = textOf(
      await h.run("browser_exec", {
        pageId,
        script: "return window.__state.a",
        ref: "e12",
      }),
    );
    expect(page.execScripts).toEqual([
      { script: "return window.__state.a", ref: "e12" },
    ]);
    expect(out).toBe(
      [
        "EXEC: 示例页 | https://example.com/a",
        "RESULT (12 chars):",
        "{",
        '  "a": 1',
        "}",
      ].join("\n"),
    );
    expect(h.saved).toEqual([]);
  });

  test("脚本自己弹出了对话框：不去读标题（页面被卡住会一直等）", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.exec = async () => {
      page.emitDialog({ type: "alert", message: "hi", defaultValue: "" });
      return { kind: "threw", message: "页面弹出了对话框，脚本被挂起" };
    };
    const out = textOf(
      await h.run("browser_exec", { pageId, script: "alert(1)" }),
    );
    expect(out.split("\n")[0]).toBe(
      "EXEC: （页面在等对话框） | https://example.com/a",
    );
  });

  test("不给 ref 时传 null；undefined 结果写一行 RESULT: undefined", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const out = textOf(await h.run("browser_exec", { pageId, script: "1" }));
    expect(page.execScripts[0]).toEqual({ script: "1", ref: null });
    expect(out.split("\n")).toEqual([
      "EXEC: （无标题） | https://example.com/a",
      "RESULT: undefined",
    ]);
  });

  test("脚本抛异常：照写 THREW 与 message 的多行，不算工具失败", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    page.execResult = {
      kind: "threw",
      message: "TypeError: 坏了\n    at foo (a.js:1:2)",
    };
    const out = textOf(await h.run("browser_exec", { pageId, script: "x" }));
    expect(out).toBe(
      [
        "EXEC: 示例页 | https://example.com/a",
        "THREW:",
        "TypeError: 坏了",
        "    at foo (a.js:1:2)",
      ].join("\n"),
    );
  });

  test("超预算：全文遮罩后存成附件，结果末尾带 FULL RESULT 行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.execResult = {
      kind: "value",
      json: Array.from(
        { length: 400 },
        (_, i) => `"secret ${i} ${"x".repeat(40)}"`,
      ).join("\n"),
    };
    const out = textOf(await h.run("browser_exec", { pageId, script: "x" }));
    expect(h.saved.map((s) => s.name)).toEqual([`exec-${pageId}.json`]);
    const saved = h.saved[0]?.bytes.toString("utf8") ?? "";
    // 落文件前确实调了 deps.mask：附件里是遮罩后的字。
    expect(h.masks).toHaveLength(1);
    expect(saved).toContain("{{@secret}}");
    expect(saved).not.toContain('"secret ');
    expect(out).toContain("more lines (400 lines total)");
    expect(out).toContain("\nFULL RESULT: [attach_file] attachment:");
  });

  test("参数：script 必填、有 maxLength 20000、不带 intent", async () => {
    const tool = await spec();
    const props = tool.parameters?.properties ?? {};
    expect(props.script).toMatchObject({ type: "string", maxLength: 20_000 });
    expect(props).not.toHaveProperty("intent");
    expect(tool.description ?? "").toContain("不可信");
    expect(tool.description ?? "").toContain("THREW:");
    expect(tool.description ?? "").toContain("30 秒");
  });

  test("缺 script、script 不是字符串、超长、ref 格式不对都报错，不碰页面", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const before = page.calls.length;
    expect(await error(h.run("browser_exec", { pageId }))).toContain(
      "script 必须是字符串",
    );
    expect(await error(h.run("browser_exec", { pageId, script: 1 }))).toContain(
      "script 必须是字符串",
    );
    expect(
      await error(
        h.run("browser_exec", { pageId, script: "x".repeat(20_001) }),
      ),
    ).toContain("script 最长 20000 字符");
    expect(
      await error(h.run("browser_exec", { pageId, script: "x", ref: "zz" })),
    ).toContain("ref 必须是最近一次快照里的元素编号");
    expect(page.calls).toHaveLength(before);
  });

  test("高敏感站点：走确认，摘要只有脚本长度、不含脚本", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openViaTool(h, "https://github.com/a");
    page.execResult = { kind: "value", json: '"ok"' };
    await h.run("browser_exec", { pageId, script: "return 'my-secret-token'" });
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ tool: "browser_exec" });
    expect(confirms[0]?.summary).toBe(
      `执行脚本（${"return 'my-secret-token'".length} 字符）`,
    );
    expect(JSON.stringify(confirms)).not.toContain("my-secret-token");
  });

  test("确认被拒：不执行脚本", async () => {
    const h = makeToolHarness({
      async confirmAction() {
        return { allowed: false, note: "" };
      },
    });
    const { pageId, page } = await openViaTool(h, "https://github.com/a");
    const msg = await error(
      h.run("browser_exec", { pageId, script: "return 1" }),
    );
    expect(msg).toContain("没有批准");
    expect(page.execScripts).toEqual([]);
  });

  test("审计与回放：摘要同确认那一串，不含脚本内容", async () => {
    const recorded: Array<{ tool: string; summary: string }> = [];
    const h = makeToolHarness({
      recordStep: async (a) => {
        recorded.push({ tool: a.tool, summary: a.summary });
      },
    });
    const { pageId } = await openViaTool(h);
    await h.run("browser_exec", { pageId, script: "return 'secret-value'" });
    const summary = `执行脚本（${"return 'secret-value'".length} 字符）`;
    expect(h.audit.at(-1)).toEqual({
      tool: "browser_exec",
      pageId,
      summary,
    });
    expect(recorded.at(-1)).toEqual({ tool: "browser_exec", summary });
    expect(JSON.stringify(h.audit)).not.toContain("secret-value");
  });

  test("不调清洗器", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const cleaned = h.cleaner.calls.length;
    await h.run("browser_exec", { pageId, script: "1" });
    expect(h.cleaner.calls).toHaveLength(cleaned);
  });
});
