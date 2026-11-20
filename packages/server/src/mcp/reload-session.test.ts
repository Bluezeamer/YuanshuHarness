// 会话里的 MCP：起不来时状态里有原因、不连累别的服务；依赖补上之后重载，工具才注册进来、可以调用。
// 真实会话池 + pi 的 MCP 扩展；模型是桩，服务是 test/support/mcp-fixture.mjs。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { CapabilityStore } from "../store/capabilities.js";
import { type McpConfig, McpStore } from "../store/mcp.js";
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

const lastToolResult = () => {
  const last = stub.requests.at(-1);
  if (!last) throw new Error("桩没收到请求");
  const msgs = (last.body as { messages: { role: string }[] }).messages;
  return JSON.stringify(msgs.filter((m) => m.role === "tool").at(-1));
};

test("命令缺失：状态里有原因；依赖补上后重载：就绪、工具可调；别的服务不受牵连", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-mcp-reload-"));
  const data = testData(path.join(dir, "data"));
  const secrets = new SecretStore(data.db, loadMasterKey(data.dir));
  const mcpStore = new McpStore(data.db);
  const mcp = new McpRuntime({
    mcp: mcpStore,
    secrets,
    capabilities: new CapabilityStore(data.db),
  });
  const t = testPool(stubSessionFactory(stub, {}, true), data, { mcp });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => mcp.close(),
    () => data.close(true),
    () => t.pool.dispose(),
  );

  const later = path.join(dir, "later-npx");
  const entry = (
    command: string,
    env: { key: string; value: string }[] = [],
  ): McpConfig => ({ transport: "stdio", command, args: [], env });
  mcpStore.create("fx", entry(later));
  mcpStore.create(
    "badvar",
    entry(process.execPath, [{ key: "A", value: "${YS_RELOAD_TEST_UNSET}" }]),
  );
  for (const n of ["fx", "badvar"])
    mcpStore.patch(n, { approval: "allow", global: true });

  const ws = data.directories.create("w", dir, new Date());
  if (!ws) throw new Error("目录没建成");
  const info = await t.pool.create({ directoryIds: [ws.id] });
  const items = () => t.pool.contextOf(info.id)?.mcp ?? [];
  const item = (name: string) => items().find((i) => i.name === name);

  // 起不来：fx 找不到命令，badvar 的环境变量没设置；两个都要给出原因，而不是卡在「连接中」
  await waitFor(
    () =>
      items().length === 2 && items().every((i) => i.state !== "connecting"),
    "两个服务都有结果",
    15000,
  );
  expect(item("fx")).toMatchObject({
    state: "failed",
    tools: 0,
    where: "local",
    global: true,
  });
  expect(item("fx")?.error).toContain("later-npx");
  expect(item("badvar")?.state).toBe("failed");
  expect(item("badvar")?.error).toContain("YS_RELOAD_TEST_UNSET");

  // 用户把依赖装好了（这里是写出可执行的启动脚本），重载
  writeFileSync(later, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}"\n`);
  chmodSync(later, 0o755);
  expect(await t.pool.refreshContext(info.id)).toBe("refreshed");
  // 握手应答先到，随后才列工具并注册
  await waitFor(
    () => item("fx")?.state === "ready" && item("fx")?.tools === 3,
    "fx 就绪且工具注册完",
    15000,
  );
  expect(item("fx")?.error).toBeUndefined();
  // badvar 仍然是它自己的问题，没有因为重载被遗漏或连累别人
  expect(item("badvar")?.state).toBe("failed");

  // 工具真的可调：重载前缓存里没有它、也没被注册过
  const live = t.pool.get(info.id);
  if (!live) throw new Error("会话不在池里");
  const c = collector();
  live.subscribe(c);
  CALLS.push({ tool: "mcp__fx__env", args: { name: "HOME" } });
  live.send("go");
  await waitFor(() => c.types().includes("run.ended"), "run.ended", 25000);
  expect(lastToolResult()).not.toContain("not available");
  expect(lastToolResult()).not.toContain("not found");
}, 60000);

test("重载：不存在的会话 not_found；运行中 busy", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-mcp-reload-"));
  const data = testData(path.join(dir, "data"));
  const secrets = new SecretStore(data.db, loadMasterKey(data.dir));
  const mcp = new McpRuntime({
    mcp: new McpStore(data.db),
    secrets,
    capabilities: new CapabilityStore(data.db),
  });
  const t = testPool(stubSessionFactory(stub, {}, true), data, { mcp });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => mcp.close(),
    () => data.close(true),
    () => t.pool.dispose(),
  );
  expect(
    await t.pool.refreshContext("00000000-0000-4000-8000-000000000000"),
  ).toBe("not_found");
  const ws = data.directories.create("w", dir, new Date());
  if (!ws) throw new Error("目录没建成");
  const info = await t.pool.create({ directoryIds: [ws.id] });
  const live = t.pool.get(info.id);
  if (!live) throw new Error("会话不在池里");
  stub.mode.delayMs = 400;
  live.send("slow");
  await waitFor(() => live.busy, "进入运行", 5000);
  expect(await t.pool.refreshContext(info.id)).toBe("busy");
  await waitFor(() => !live.busy, "运行结束", 10000);
  stub.mode.delayMs = 0;
  expect(await t.pool.refreshContext(info.id)).toBe("refreshed");
}, 60000);
