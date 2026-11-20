// 会话创建之后才登记的 MCP：重载后工具要能被真正激活（声明给模型、可调用）。
// 用真实会话工厂：生产里创建会话会给 pi 一份工具白名单，桩工厂不传，测不到白名单把后注册的 MCP 工具挡掉。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { testData, testPool, testPresets } from "../../test/support/stub.js";
import { McpRuntime } from "../mcp/runtime.js";
import { CapabilityStore } from "../store/capabilities.js";
import { McpStore } from "../store/mcp.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { createSessionFactory } from "./factory.js";
import type { SessionFactory } from "./pool.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture.mjs", import.meta.url),
);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const until = async (cond: () => boolean, what: string, ms = 20000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
};

function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-allow-"));
  const data = testData(path.join(dir, "data"));
  const secrets = new SecretStore(data.db, loadMasterKey(data.dir));
  const store = new McpStore(data.db);
  const mcp = new McpRuntime({
    mcp: store,
    secrets,
    capabilities: new CapabilityStore(data.db),
  });
  const presets = testPresets(data);
  const sessions = new Map<string, AgentSession>();
  const real = createSessionFactory();
  const factory: SessionFactory = async (o) => {
    const s = await real(o);
    sessions.set(o.id, s);
    return s;
  };
  const t = testPool(factory, data, {
    mcp,
    presetView: presets.view,
    modeView: presets.modeView,
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => mcp.close(),
    () => data.close(true),
    () => t.pool.dispose(),
  );
  const ws = data.directories.create("w", dir, new Date());
  if (!ws) throw new Error("目录没建成");
  const register = (name: string) => {
    store.create(name, {
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: [],
    });
    store.patch(name, { approval: "allow", global: true });
  };
  const create = () =>
    t.pool.create({ directoryIds: [ws.id], promptPresetId: presets.coder.id });
  return { pool: t.pool, sessions, register, create };
}

// 工具只是注册了不算：必须能被设成「启用」（启用才会声明给模型、才能被调用）。
async function activatable(s: AgentSession, tool: string) {
  await until(
    () => s.getAllTools().some((x) => x.name === tool),
    `${tool} 注册`,
  );
  s.setActiveToolsByName([tool]);
  return s.getActiveToolNames().includes(tool);
}

describe("会话创建之后才登记的 MCP", () => {
  test("会话创建时一个 MCP 都没有：之后登记、重载，工具可以激活", async () => {
    const b = boot();
    const info = await b.create();
    b.register("fx");
    expect(await b.pool.refreshContext(info.id)).toBe("refreshed");
    const s = b.sessions.get(info.id) as AgentSession;
    expect(await activatable(s, "mcp__fx__echo")).toBe(true);
  }, 60000);

  test("会话创建时缓存里已有别的 MCP：之后再登记一个、重载，新的也要能激活", async () => {
    const b = boot();
    b.register("old");
    const info = await b.create();
    b.register("fx");
    expect(await b.pool.refreshContext(info.id)).toBe("refreshed");
    const s = b.sessions.get(info.id) as AgentSession;
    expect(await activatable(s, "mcp__old__echo")).toBe(true);
    expect(await activatable(s, "mcp__fx__echo")).toBe(true);
  }, 60000);

  test("登记之后才建的会话本来就可用", async () => {
    const b = boot();
    b.register("fx");
    const info = await b.create();
    const s = b.sessions.get(info.id) as AgentSession;
    expect(await activatable(s, "mcp__fx__echo")).toBe(true);
  }, 60000);
});
