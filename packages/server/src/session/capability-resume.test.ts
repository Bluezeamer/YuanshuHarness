// 重启后恢复会话：恢复路径也要按工作区取勾选的 skill / MCP（全局项两条路径都默认带上）。
// 第一个池建会话并落盘，换第二个池 acquire 同一个会话，模拟 Server 重启。
import { mkdtempSync, rmSync } from "node:fs";
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
import { McpRuntime } from "../mcp/runtime.js";
import { SkillRuntime } from "../skills/runtime.js";
import { CapabilityStore } from "../store/capabilities.js";
import { McpStore } from "../store/mcp.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { SkillStore } from "../store/skills.js";

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

const md = (name: string) =>
  `---\nname: ${name}\ndescription: 测试 ${name}\n---\n\n正文\n`;

async function run(entry: {
  send(t: string): void;
  subscribe(c: never): void;
}) {
  const c = collector();
  entry.subscribe(c as never);
  entry.send("go");
  await waitFor(() => c.types().includes("run.ended"), "run.ended", 8000);
}

test("恢复会话：全局与工作区勾选的 skill 都在，没勾的项目级 skill 不在", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-resume-"));
  const data = testData(path.join(dir, "data"));
  const capabilities = new CapabilityStore(data.db);
  const skills = new SkillStore(data.db, path.join(dir, "skills"));
  const deps = { skills: new SkillRuntime({ skills, capabilities }) };
  const first = testPool(stubSessionFactory(stub, {}, true), data, deps);
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => data.close(true),
    () => first.pool.dispose(),
  );
  for (const [name, scope] of [
    ["g-skill", "global"],
    ["p-skill", "project"],
    ["unused", "project"],
  ] as const)
    skills.create(name, scope, "test", [
      { path: "SKILL.md", content: Buffer.from(md(name)) },
    ]);

  const info = await first.pool.create();
  const entry = first.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  await run(entry);
  const wsId = first.pool.workspaceIdOf(info.id) as string;
  capabilities.set(wsId, "skill", ["p-skill"]);
  first.pool.dispose();

  const second = testPool(stubSessionFactory(stub, {}, true), data, deps);
  cleanups.push(() => second.pool.dispose());
  const back = await second.pool.acquire(info.id);
  if (!back) throw new Error("恢复失败");
  expect(back.skillsLoaded.map((s) => s.name).sort()).toEqual([
    "g-skill",
    "p-skill",
  ]);
});

test("恢复会话：全局与工作区勾选的 MCP 仍可调用", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-resume-"));
  const data = testData(path.join(dir, "data"));
  const capabilities = new CapabilityStore(data.db);
  const mcpStore = new McpStore(data.db);
  const mcp = new McpRuntime({
    mcp: mcpStore,
    secrets: new SecretStore(data.db, loadMasterKey(data.dir)),
    capabilities,
  });
  const first = testPool(stubSessionFactory(stub, {}, true), data, { mcp });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => mcp.close(),
    () => data.close(true),
    () => first.pool.dispose(),
  );
  mcpStore.create("fx", {
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    env: [],
  });
  mcpStore.patch("fx", { approval: "allow" });

  const info = await first.pool.create();
  const entry = first.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  await run(entry);
  const wsId = first.pool.workspaceIdOf(info.id) as string;
  capabilities.set(wsId, "mcp", ["fx"]);
  first.pool.dispose();

  const second = testPool(stubSessionFactory(stub, {}, true), data, { mcp });
  cleanups.push(() => second.pool.dispose());
  const back = await second.pool.acquire(info.id);
  if (!back) throw new Error("恢复失败");
  CALLS.push({ tool: "mcp__fx__echo", args: { text: "hi" } });
  await run(back);
  const last = stub.requests.at(-1);
  expect(JSON.stringify(last?.body)).toContain("echo:hi");
});
