// browser_* 工具经真实权限扩展的行为：站点审批、同站点免问、其余四个工具不重复审批、非 http 直接拒绝。
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";
import type { BrowserDriver, PageDriver } from "./driver.js";
import { BrowserManager } from "./manager.js";

const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [];
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Array<{ role: string }>;
  return CALLS[msgs.filter((m) => m.role === "tool").length] ?? "done";
});
afterAll(() => stub.close());

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  CALLS.length = 0;
  stub.requests.length = 0;
});

const fakePage = (visited: string[]): PageDriver => {
  let url = "about:blank";
  return {
    goto: async (u) => {
      visited.push(u);
      url = u;
      return { status: 200 };
    },
    url: () => url,
    title: async () => "测试页",
    loading: () => false,
    snapshot: async () => "[1] 链接 示例",
    click: async () => {},
    type: async () => {},
    screenshot: async () => Buffer.from("jpeg"),
    startScreencast: async () => {},
    stopScreencast: async () => {},
    onChange: () => {},
    takeBlocked: () => [],
    close: async () => {},
  };
};

async function setup() {
  const visited: string[] = [];
  const driver: BrowserDriver = {
    newPage: async () => fakePage(visited),
    close: async () => {},
    onDisconnected: () => {},
  };
  const browser = new BrowserManager({
    launch: async () => driver,
    locate: () => "/fake/chromium",
  });
  const t = testPool(stubSessionFactory(stub, {}, true), testData(), {
    browser,
  });
  cleanups.push(
    () => browser.closeAll(),
    () => t.data.close(true),
    () => t.pool.dispose(),
  );
  const info = await t.pool.create();
  const entry = t.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c);
  return { ...t, entry, c, browser, visited, sessionId: info.id };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const prompts = (c: Ctx["c"]) =>
  c.frames.filter((f) => f.type === "prompt.requested");
const ended = (c: Ctx["c"]) => () => c.types().includes("run.ended");
const toolResults = () => {
  const last = stub.requests.at(-1);
  if (!last) throw new Error("no model request recorded");
  return JSON.stringify((last.body as { messages: unknown[] }).messages);
};

describe("browser_open 审批", () => {
  test("规则外站点弹审批，文案含 URL；允许后打开并记住该站点", async () => {
    const x = await setup();
    CALLS.push(
      { tool: "browser_open", args: { url: "http://example.test/a" } },
      { tool: "browser_open", args: { url: "http://example.test/b" } },
    );
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    const p = prompts(x.c)[0]?.data;
    if (!p) throw new Error("prompt not found");
    expect(p.title).toContain("browser_open");
    expect(p.body).toContain("http://example.test/a");
    x.entry.answerPrompt(p.promptId, { optionId: "allow" });
    await waitFor(ended(x.c), "run.ended", 8000);
    // 第二次同站点不再弹窗
    expect(prompts(x.c)).toHaveLength(1);
    expect(x.visited).toEqual([
      "http://example.test/a",
      "http://example.test/b",
    ]);
    expect(x.browser.isApproved(x.sessionId, "http://example.test/x")).toBe(
      true,
    );
  });

  test("拒绝后不打开页面", async () => {
    const x = await setup();
    CALLS.push({ tool: "browser_open", args: { url: "http://example.test/" } });
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, {
      optionId: "deny",
    });
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(x.visited).toEqual([]);
    expect(toolResults()).toContain("用户拒绝了该操作");
  });

  test("完全允许档：不弹审批，直接打开", async () => {
    const x = await setup();
    x.data.workspaces.update(x.entry.workspaceId, { tier: "full" });
    CALLS.push({ tool: "browser_open", args: { url: "http://example.test/" } });
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
    expect(x.visited).toEqual(["http://example.test/"]);
  });

  test("非 http(s) 地址不弹窗，直接拒绝", async () => {
    const x = await setup();
    CALLS.push({ tool: "browser_open", args: { url: "file:///etc/passwd" } });
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
    expect(x.visited).toEqual([]);
    expect(toolResults()).toContain("只能打开 http 或 https 地址");
  });

  test("snapshot 等后续工具不重复审批，且结果带页面内容", async () => {
    const x = await setup();
    x.browser.approve(x.sessionId, "http://example.test/");
    CALLS.push(
      { tool: "browser_open", args: { url: "http://example.test/" } },
      { tool: "browser_snapshot", args: {} },
      { tool: "browser_click", args: { ref: 1 } },
    );
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
    expect(toolResults()).toContain("[1] 链接 示例");
  });

  test("没打开页面就取快照：工具报错而不是崩溃", async () => {
    const x = await setup();
    CALLS.push({ tool: "browser_snapshot", args: {} });
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(toolResults()).toContain("请先调用 browser_open");
  });
});
