// 能力分发接进真实会话池：全局项每个会话默认带上，工作区分配只在勾了它的会话里生效。
import { mkdtempSync, rmSync } from "node:fs";
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
import { CapabilityStore } from "../store/capabilities.js";
import { McpStore } from "../store/mcp.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { McpRuntime } from "./runtime.js";

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
  const data = testData();
  const mcpStore = new McpStore(data.db);
  const capabilities = new CapabilityStore(data.db);
  const mcp = new McpRuntime({
    mcp: mcpStore,
    secrets: new SecretStore(data.db, loadMasterKey(data.dir)),
    capabilities,
  });
  const t = testPool(stubSessionFactory(stub, {}, true), data, {
    mcp,
  });
  cleanups.push(
    () => mcp.close(),
    () => data.close(true),
    () => t.pool.dispose(),
  );
  mcpStore.create("fx", {
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    env: [],
  });
  mcpStore.patch("fx", { approval: "allow" });
  return { ...t, mcpStore, capabilities };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const lastToolResult = (): string => {
  const last = stub.requests.at(-1);
  if (!last) throw new Error("桩没收到请求");
  const msgs = (last.body as unknown as { messages: { role: string }[] })
    .messages;
  return JSON.stringify(msgs.filter((m) => m.role === "tool").at(-1));
};

// 一次调用后取最后一个工具结果（成功是 echo:hi，不可用是 error 说明）。
async function echo(x: Ctx): Promise<string> {
  CALLS.push({ tool: "mcp__fx__echo", args: { text: "hi" } });
  const info = await x.pool.create();
  const entry = x.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c);
  entry.send("go");
  await waitFor(() => c.types().includes("run.ended"), "run.ended", 8000);
  return lastToolResult();
}

describe("MCP 的两层分发", () => {
  test("标了全局：不勾预设、不分配工作区，新建会话就能调用", async () => {
    const x = await setup();
    x.mcpStore.patch("fx", { global: true });
    expect(await echo(x)).toContain("echo:hi");
  });

  test("标了全局但禁用的服务不带工具", async () => {
    const x = await setup();
    x.mcpStore.patch("fx", { global: true, enabled: false });
    expect(await echo(x)).not.toContain("echo:hi");
  });

  test("没标全局但勾给了工作区：该工作区的会话能调用", async () => {
    const x = await setup();
    // 先建一个会话拿到工作区，再分配：分配对之后新建的会话生效。
    const first = await x.pool.create();
    const wsId = x.pool.workspaceIdOf(first.id) as string;
    x.capabilities.set(wsId, "mcp", ["fx"]);
    CALLS.push({ tool: "mcp__fx__echo", args: { text: "hi" } });
    const info = await x.pool.create({ workspaceId: wsId });
    const entry = x.pool.get(info.id);
    if (!entry) throw new Error("no entry");
    const c = collector();
    entry.subscribe(c);
    entry.send("go");
    await waitFor(() => c.types().includes("run.ended"), "run.ended", 8000);
    expect(lastToolResult()).toContain("echo:hi");
  });

  test("既没标全局也没勾：调用报工具不可用，服务本身仍可登记", async () => {
    const x = await setup();
    const text = await echo(x);
    expect(text).toContain("not found");
    expect(x.mcpStore.get("fx")).toBeTruthy();
  });
});
