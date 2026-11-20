// 矩阵与 MCP 审批接进真实会话池：改规则 / 审批档对进行中的会话即时生效。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { McpRuntime } from "../mcp/runtime.js";
import { CapabilityStore } from "../store/capabilities.js";
import { McpStore } from "../store/mcp.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { ToolRuleStore } from "../store/tool-rules.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture.mjs", import.meta.url),
);

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

async function setup() {
  const outside = mkdtempSync(path.join(tmpdir(), "yuanshu-out-"));
  const data = testData();
  const toolRules = new ToolRuleStore(data.db);
  const mcpStore = new McpStore(data.db);
  const capabilities = new CapabilityStore(data.db);
  const mcp = new McpRuntime({
    mcp: mcpStore,
    secrets: new SecretStore(data.db, loadMasterKey(data.dir)),
    capabilities,
  });
  const t = testPool(stubSessionFactory(stub, {}, true), data, {
    toolRules,
    mcp,
  });
  cleanups.push(
    () => rmSync(outside, { recursive: true, force: true }),
    () => mcp.close(),
    () => data.close(true),
    () => t.pool.dispose(),
  );
  const ws = data.directories.getDefault();
  if (!ws) throw new Error("no ws");
  mcpStore.create("fx", {
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    env: [],
  });
  mcpStore.patch("fx", { global: true });
  const info = await t.pool.create();
  const entry = t.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c);
  return { ...t, entry, c, outside, ws, toolRules, mcpStore };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const ended = (c: Ctx["c"]) => () => c.types().includes("run.ended");
const prompts = (c: Ctx["c"]) =>
  c.frames.filter((f) => f.type === "prompt.requested");
const results = () =>
  JSON.stringify(
    (
      stub.requests.at(-1)?.body as unknown as
        | { messages: unknown[] }
        | undefined
    )?.messages,
  );

describe("内置工具矩阵接进权限扩展", () => {
  test("改规则对进行中的会话下一轮立刻生效：cwd 外写入先弹窗，改成放行后不再弹", async () => {
    const x = await setup();
    const f = path.join(x.outside, "a.txt");
    CALLS.push({
      tool: "write",
      args: { host: "local", path: f, content: "hi" },
    });
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested", 8000);
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { optionId: "deny" });
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);

    x.c.frames.length = 0;
    x.toolRules.set("write", { inside: "allow", outside: "allow" });
    // 桩按历史里的工具结果条数取下一个调用，第二轮接着往后排
    CALLS.push({
      tool: "write",
      args: { host: "local", path: f, content: "hi" },
    });
    x.entry.send("again");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
    expect(existsSync(f)).toBe(true);
  });
});

describe("MCP 审批档接进会话", () => {
  const call = { tool: "mcp__fx__echo", args: { text: "hi" } };

  test("放行：不弹窗，工具直接执行", async () => {
    const x = await setup();
    x.mcpStore.patch("fx", { approval: "allow" });
    CALLS.push(call);
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
    expect(results()).toContain("echo:hi");
  });

  test("审批：弹窗；改成放行后同一会话下一轮不再弹", async () => {
    const x = await setup();
    x.mcpStore.patch("fx", { approval: "ask" });
    CALLS.push(call);
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested", 8000);
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { optionId: "allow" });
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(results()).toContain("echo:hi");

    x.c.frames.length = 0;
    x.mcpStore.patch("fx", { approval: "allow" });
    CALLS.push(call);
    x.entry.send("again");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
  });
});
