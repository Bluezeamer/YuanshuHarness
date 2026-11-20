// 会话开着的时候才新增的能力：下一条消息前接上，并用尾部通知告诉模型（前缀不动、只通知一次）。
// 真实会话池 + 桩模型；每次发送后看「最新一次发给模型的请求」里有没有通知。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
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
const stub = await startStub(() => "好的");
afterAll(() => stub.close());

const cleanups: Array<() => void | Promise<void>> = [];
let home: string;
let realHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "yuanshu-sync-home-"));
  realHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  stub.requests.length = 0;
});

const md = (name: string, desc = `测试 ${name}`) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n正文\n`;

function boot(withMcp: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-sync-"));
  const data = testData(path.join(dir, "data"));
  const capabilities = new CapabilityStore(data.db);
  const skills = new SkillStore(data.db, path.join(dir, "skills"));
  const mcpStore = new McpStore(data.db);
  const mcp = new McpRuntime({
    mcp: mcpStore,
    secrets: new SecretStore(data.db, loadMasterKey(data.dir)),
    capabilities,
  });
  const t = testPool(stubSessionFactory(stub, {}, true), data, {
    skills: new SkillRuntime({ skills, capabilities }),
    ...(withMcp ? { mcp } : {}),
  });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => mcp.close(),
    () => data.close(true),
    () => t.pool.dispose(),
  );
  return { pool: t.pool, skills, mcpStore, data };
}

// 发一条消息、等这一轮结束，返回「最新一次发给模型的请求」序列化后的文本
async function say(
  entry: { send(t: string): void; subscribe(c: never): void },
  c: ReturnType<typeof collector>,
  text: string,
): Promise<string> {
  c.frames.length = 0;
  stub.requests.length = 0;
  entry.send(text);
  await waitFor(() => c.types().includes("run.ended"), "run.ended", 30000);
  const last = stub.requests.at(-1);
  if (!last) throw new Error("桩没收到请求");
  return JSON.stringify(last.body);
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

test("会话开着时新增全局技能：先同步进环境，再用尾部通知给出名字、描述与 SKILL.md 路径，只通知一次", async () => {
  const b = boot(false);
  const info = await b.pool.create();
  const entry = b.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c as never);
  // 第一条消息冻结前缀；这时库里没有技能
  expect(await say(entry, c, "one")).not.toContain("New skills are available");

  b.skills.create("ub-mode", "global", "test", [
    { path: "SKILL.md", content: Buffer.from(md("ub-mode", "遵循精简原则")) },
  ]);
  const second = await say(entry, c, "two");
  expect(second).toContain("New skills are available");
  expect(second).toContain("ub-mode: 遵循精简原则");
  expect(second).toContain("yuanshu/ub-mode/SKILL.md");
  // 路径指向的文件真的已经同步到环境里
  expect(
    existsSync(path.join(home, ".agents/skills/yuanshu/ub-mode/SKILL.md")),
  ).toBe(true);
  expect(entry.skillsLoaded.map((s) => s.name)).toEqual(["ub-mode"]);

  // 再发一条：历史里那条通知还在，但不会再发第二条
  const third = await say(entry, c, "three");
  expect(count(third, "New skills are available")).toBe(1);
}, 60000);

test("会话开着时下掉技能：通知它不再可用", async () => {
  const b = boot(false);
  b.skills.create("ub-mode", "global", "test", [
    { path: "SKILL.md", content: Buffer.from(md("ub-mode")) },
  ]);
  const info = await b.pool.create();
  const entry = b.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c as never);
  await say(entry, c, "one");
  b.skills.setEnabled("ub-mode", false);
  const second = await say(entry, c, "two");
  expect(second).toContain("Skills no longer available: ub-mode");
}, 60000);

test("会话开着时新增全局 MCP：显示待加载，下一条消息前自动重连，工具用尾部通知告诉模型", async () => {
  const b = boot(true);
  const info = await b.pool.create();
  const entry = b.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c as never);
  expect(await say(entry, c, "one")).not.toContain("New tools are available");

  b.mcpStore.create("fx", {
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    env: [],
  });
  b.mcpStore.patch("fx", { approval: "allow", global: true });
  // 这个会话开着时才登记：还没加载，状态说明白，而不是一直「连接中」
  expect(b.pool.contextOf(info.id)?.mcp[0]).toMatchObject({
    name: "fx",
    state: "pending",
  });

  const second = await say(entry, c, "two");
  expect(second).toContain("New tools are available");
  expect(second).toContain("mcp__fx__echo");
  expect(b.pool.contextOf(info.id)?.mcp[0]).toMatchObject({
    name: "fx",
    state: "ready",
    tools: 3,
  });
  const third = await say(entry, c, "three");
  expect(count(third, "New tools are available")).toBe(1);
}, 90000);

test("MCP 登记没变：发消息不重连（不会每条消息都重启进程）", async () => {
  const b = boot(true);
  b.mcpStore.create("fx", {
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    env: [],
  });
  b.mcpStore.patch("fx", { approval: "allow", global: true });
  const info = await b.pool.create();
  const entry = b.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c as never);
  await say(entry, c, "one");
  let reconnects = 0;
  const orig = entry.reconnect.bind(entry);
  entry.reconnect = () => {
    reconnects++;
    return orig();
  };
  await say(entry, c, "two");
  await say(entry, c, "three");
  expect(reconnects).toBe(0);
}, 90000);
