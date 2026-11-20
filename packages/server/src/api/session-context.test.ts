import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { McpRuntime } from "../mcp/runtime.js";
import { estimateTokens } from "../session/context-files.js";
import type { SessionPool } from "../session/pool.js";
import { SkillRuntime } from "../skills/runtime.js";
import { CapabilityStore } from "../store/capabilities.js";
import { McpStore } from "../store/mcp.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { SessionFileStore } from "../store/session-files.js";
import { SkillStore } from "../store/skills.js";
import { DEFAULTS, sessionsApi } from "./sessions.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture.mjs", import.meta.url),
);

// 新地址规则：绝对路径带主机前缀（相对路径仍相对当前目录）。
// 位置模型：host 说在哪台机器，path 只是路径。
const local = (p: string) => ({ host: "local", path: p });

// 按历史里已有的工具结果条数取下一个调用，一次运行里可以连续调用多个工具。
const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [];
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Array<{ role: string }>;
  return CALLS[msgs.filter((m) => m.role === "tool").length] ?? "done";
});
afterAll(() => stub.close());

type Item = Record<string, unknown>;
interface ContextBody {
  files: Item[];
  filesTruncated?: true;
  skills: Item[];
  mcp: Item[];
}

// 按名字索引一组条目。
const byName = (list: Item[]): Record<string, Item | undefined> =>
  Object.fromEntries(list.map((x) => [x.name as string, x]));

interface Boot {
  data: TestData;
  pool: SessionPool;
  app: FastifyInstance;
  http: string;
  ws: string;
  mcpStore: McpStore;
  capabilities: CapabilityStore;
  skills: SkillStore;
  newSession(): Promise<string>;
  context(id: string): Promise<{ status: number; body: ContextBody }>;
  connect(id: string): Promise<TestClient>;
}

let b: Boot;
let home: string;
let realHome: string | undefined;
const clients: TestClient[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(async () => {
  // LocalEnv.homedir() 取 os.homedir()，指到临时目录，避免写到真实用户目录。
  home = mkdtempSync(path.join(tmpdir(), "yuanshu-home-"));
  realHome = process.env.HOME;
  process.env.HOME = home;
  const data = testData();
  const ws = data.directories.getDefault();
  if (!ws) throw new Error("no ws");
  // 完全允许档：read / edit / write 不弹审批。
  data.defaults.setPermissionTier("full");
  const capabilities = new CapabilityStore(data.db);
  const mcpStore = new McpStore(data.db);
  const skills = new SkillStore(data.db, path.join(data.dir, "skills"));
  const mcp = new McpRuntime({
    mcp: mcpStore,
    secrets: new SecretStore(data.db, loadMasterKey(data.dir)),
    capabilities,
  });
  const pool = testPool(stubSessionFactory(stub, {}, true), data, {
    files: new SessionFileStore(data.db),
    skills: new SkillRuntime({ skills, capabilities }),
    mcp,
  }).pool;
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: DEFAULTS.maxPayloadBytes },
    errorHandler: () => {},
  });
  await app.register(sessionsApi, { ...DEFAULTS, pool });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const http = `http://127.0.0.1:${port}`;
  cleanups.push(
    () => app.close(),
    () => pool.dispose(),
    () => mcp.close(),
    () => data.close(true),
    () => rmSync(home, { recursive: true, force: true }),
  );
  b = {
    data,
    pool,
    app,
    http,
    ws: ws.path,
    mcpStore,
    capabilities,
    skills,
    async newSession() {
      const r = await fetch(`${http}/api/v1/sessions`, { method: "POST" });
      return ((await r.json()) as { id: string }).id;
    },
    async context(id) {
      const r = await fetch(`${http}/api/v1/sessions/${id}/context`);
      return {
        status: r.status,
        body: (await r.json()) as ContextBody,
      };
    },
    async connect(id) {
      const c = await TestClient.connect(
        `ws://127.0.0.1:${port}/api/v1/sessions/${id}/stream`,
      );
      clients.push(c);
      await waitFor(() => c.frames.length > 0, "快照");
      return c;
    },
  };
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const c of cleanups.splice(0).reverse()) await c();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  CALLS.length = 0;
  stub.requests.length = 0;
});

const ran = (c: TestClient) => () =>
  c.frames.some((f) => f.type === "run.ended");

// 发一条消息并等这一轮结束。
async function run(c: TestClient): Promise<void> {
  await c.command("send_message", { text: "go" });
  await waitFor(ran(c), "run.ended", 15000);
}

describe("GET /sessions/:id/context：读取的文件", () => {
  test("read 累计 reads，edit / write 置 modified，同路径合并，失败调用不计，按 lastAt 倒序", async () => {
    const a = path.join(b.ws, "a.txt");
    writeFileSync(a, `hello world\n${"x".repeat(300)}`);
    CALLS.push(
      { tool: "read", args: { ...local(a) } },
      { tool: "read", args: { ...local(a) } },
      { tool: "read", args: { ...local(path.join(b.ws, "missing.txt")) } },
      {
        tool: "edit",
        args: { ...local(a), edits: [{ oldText: "hello", newText: "hi" }] },
      },
      {
        tool: "write",
        args: {
          ...local(path.join(b.ws, "b.txt")),
          content: "z".repeat(64),
        },
      },
    );
    const id = await b.newSession();
    const c = await b.connect(id);
    await run(c);

    const { status, body } = await b.context(id);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["files", "mcp", "skills"]);
    expect(body.files).toHaveLength(2);
    // 最近动过的在前：write b.txt 最后发生
    expect(body.files[0]).toMatchObject({
      // 文件表记的是模型写的那个路径（host 是单独的参数）
      path: path.join(b.ws, "b.txt"),
      hostId: "local",
      tokens: 20,
      reads: 0,
      modified: true,
    });
    expect(body.files[0]?.truncated).toBeUndefined();
    expect(body.files[1]).toMatchObject({
      path: a,
      hostId: "local",
      tokens: estimateTokens(`hello world\n${"x".repeat(300)}`),
      reads: 2,
      modified: true,
    });
    expect(typeof body.files[1]?.lastAt).toBe("string");
    expect(body.filesTruncated).toBeUndefined();
    expect(body.skills).toEqual([]);
    expect(body.mcp).toEqual([]);
    // 只存路径与计数，不存内容
    const rows = JSON.stringify(
      b.data.db.prepare("SELECT * FROM session_files").all(),
    );
    expect(rows).not.toContain("zzzz");
    expect(rows).not.toContain("xxxx");
  });

  test("超大文件的 read 结果被截断：按截断后算 token 并带 truncated", async () => {
    const big = path.join(b.ws, "big.log");
    const full = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(big, full);
    CALLS.push({ tool: "read", args: { ...local(big) } });
    const id = await b.newSession();
    const c = await b.connect(id);
    await run(c);

    const f = (await b.context(id)).body.files[0];
    expect(f).toMatchObject({ path: big, reads: 1, truncated: true });
    expect(f?.tokens as number).toBeGreaterThan(0);
    expect(f?.tokens as number).toBeLessThan(estimateTokens(full));
  });

  test("context.updated 紧随 tool.ended 推给本会话订阅者，只带条数；别的会话与 snapshot 不受影响", async () => {
    const a = path.join(b.ws, "a.txt");
    writeFileSync(a, "hello");
    CALLS.push(
      { tool: "read", args: { ...local(a) } },
      {
        tool: "write",
        args: { ...local(path.join(b.ws, "n.txt")), content: "n" },
      },
    );
    const idA = await b.newSession();
    const idB = await b.newSession();
    const ca1 = await b.connect(idA);
    const ca2 = await b.connect(idA);
    const cb = await b.connect(idB);
    // 旧订阅者看到的 snapshot 不带 context
    const snap = ca1.frames.find((f) => f.type === "snapshot");
    expect(snap).toBeDefined();
    expect(JSON.stringify(Object.keys(snap?.data ?? {}))).not.toMatch(
      /context|files|skills|mcp/,
    );

    await run(ca1);
    await waitFor(ran(ca2), "ca2 run.ended");
    for (const c of [ca1, ca2]) {
      const updates = c.frames.filter((f) => f.type === "context.updated");
      expect(updates.map((f) => f.data)).toEqual([{ files: 1 }, { files: 2 }]);
      // 紧随各自的 tool.ended
      const types = c.frames.map((f) => f.type);
      const firstEnd = types.indexOf("tool.ended");
      expect(types[firstEnd + 1]).toBe("context.updated");
    }
    expect(cb.frames.some((f) => f.type === "context.updated")).toBe(false);
    expect((await b.context(idB)).body).toEqual({
      files: [],
      skills: [],
      mcp: [],
    });
  });

  test("没有读写文件的运行不产生 context.updated；旧事件序列不变", async () => {
    const id = await b.newSession();
    const c = await b.connect(id);
    await run(c);
    const types = c.frames.map((f) => f.type);
    expect(types).not.toContain("context.updated");
    expect(types).toEqual(
      expect.arrayContaining([
        "run.started",
        "message.started",
        "message.ended",
        "run.ended",
      ]),
    );
  });

  test("会话重新加载后（池重建）文件表仍在，skills 为空", async () => {
    const a = path.join(b.ws, "a.txt");
    writeFileSync(a, "hello");
    CALLS.push({ tool: "read", args: { ...local(a) } });
    const id = await b.newSession();
    const c = await b.connect(id);
    await run(c);
    await waitFor(() => b.pool.info(id)?.running === false, "空闲");
    const pool2 = testPool(stubSessionFactory(stub, {}, true), b.data, {
      files: new SessionFileStore(b.data.db),
    }).pool;
    cleanups.push(() => pool2.dispose());
    const view = pool2.contextOf(id);
    expect(view?.files.map((f) => f.path)).toEqual([a]);
    expect(view?.skills).toEqual([]);
  });
});

describe("GET /sessions/:id/context：404 与清理", () => {
  test("会话不存在或 id 非法返回 404", async () => {
    expect(
      (await b.context("01a14000-0000-7000-8000-0000000000ff")).status,
    ).toBe(404);
    expect((await b.context("nope")).status).toBe(404);
  });

  test("删除会话清掉文件表，之后再取 404；旧路由照常", async () => {
    const a = path.join(b.ws, "a.txt");
    writeFileSync(a, "hello");
    CALLS.push({ tool: "read", args: { ...local(a) } });
    const id = await b.newSession();
    const c = await b.connect(id);
    await run(c);
    await waitFor(() => b.pool.info(id)?.running === false, "空闲");

    expect((await b.context(id)).body.files).toHaveLength(1);
    // 旧路由回归：/state 与会话详情形状不变，不带 context 字段
    const st = await fetch(`${b.http}/api/v1/sessions/${id}/state`);
    expect(st.status).toBe(200);
    expect(Object.keys((await st.json()) as object).sort()).toEqual([
      "compact",
      "goal",
      "todo",
    ]);
    expect((await fetch(`${b.http}/api/v1/sessions/${id}`)).status).toBe(200);
    expect((await fetch(`${b.http}/api/v1/sessions`)).status).toBe(200);

    c.close();
    const del = await fetch(`${b.http}/api/v1/sessions/${id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    expect(
      b.data.db.prepare("SELECT COUNT(*) AS n FROM session_files").get(),
    ).toEqual({ n: 0 });
    expect((await b.context(id)).status).toBe(404);
  });
});

const md = (name: string) =>
  Buffer.from(`---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n正文\n`);

describe("GET /sessions/:id/context：已加载能力", () => {
  test("skills 取注入清单：路径是实际注入的 SKILL.md，global 为 library、project 为 directory", async () => {
    for (const [name, scope] of [
      ["g-skill", "global"],
      ["p-skill", "project"],
      ["unused", "project"],
    ] as const)
      b.skills.create(name, scope, "test", [
        { path: "SKILL.md", content: md(name) },
      ]);
    // 先建一个会话拿到工作区，再分配：分配对之后新建的会话生效。
    const first = await b.newSession();
    b.capabilities.set(b.pool.workspaceIdOf(first) as string, "skill", [
      "p-skill",
    ]);
    // g-skill 是全局项，不分配也默认生效。
    const id = await b.newSession();
    const { body } = await b.context(id);
    const by = byName(body.skills);
    expect(Object.keys(by).sort()).toEqual(["g-skill", "p-skill"]);
    expect(by["g-skill"]).toMatchObject({
      source: "library",
      path: path.join(home, ".agents/skills/yuanshu/g-skill/SKILL.md"),
    });
    expect(by["p-skill"]).toMatchObject({
      source: "directory",
      path: path.join(b.ws, ".agents/skills/yuanshu/p-skill/SKILL.md"),
    });
    for (const s of body.skills)
      expect(Number.isNaN(Date.parse(s.loadedAt as string))).toBe(false);
    expect(Object.keys(by["g-skill"] ?? {}).sort()).toEqual([
      "loadedAt",
      "name",
      "path",
      "source",
    ]);
  });

  test("mcp：ready / failed / disabled 及可见工具数", async () => {
    b.mcpStore.create("fx", {
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: [],
    });
    b.mcpStore.create("bad", {
      transport: "stdio",
      command: path.join(home, "no-such-binary"),
      args: [],
      env: [],
    });
    b.mcpStore.create(
      "off",
      {
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE],
        env: [],
      },
      {
        enabled: false,
        exposure: "direct",
        toolExposure: {},
        timeout: null,
        oauth: null,
      },
    );
    b.mcpStore.create("unassigned", {
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: [],
    });
    // 先建一个会话拿到工作区，再分配：分配对之后新建的会话生效。
    const first = await b.newSession();
    b.capabilities.set(b.pool.workspaceIdOf(first) as string, "mcp", [
      "fx",
      "bad",
      "off",
    ]);
    const id = await b.newSession();
    // 连接是后台建的：等到没有「连接中」、且就绪的服务把工具注册完
    let body = (await b.context(id)).body;
    for (let i = 0; i < 200; i++) {
      const fx = byName(body.mcp).fx;
      if (
        !body.mcp.some((m) => m.state === "connecting") &&
        (fx?.tools as number) > 0
      )
        break;
      await new Promise((r) => setTimeout(r, 25));
      body = (await b.context(id)).body;
    }
    const by = byName(body.mcp);
    expect(Object.keys(by).sort()).toEqual(["bad", "fx", "off"]);
    expect(by.fx).toMatchObject({
      state: "ready",
      where: "local",
      global: false,
    });
    expect(by.fx?.tools as number).toBeGreaterThan(0);
    expect(by.fx?.error).toBeUndefined();
    expect(by.bad).toMatchObject({ state: "failed", tools: 0 });
    expect(typeof by.bad?.error).toBe("string");
    expect(by.off).toMatchObject({ name: "off", state: "disabled", tools: 0 });
  });
});

describe("POST /sessions/:id/reload", () => {
  const post = (id: string) =>
    fetch(`${b.http}/api/v1/sessions/${id}/reload`, { method: "POST" });

  test("不存在 404；空闲的会话重载成功，之后上下文照常可读", async () => {
    expect((await post("00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
    const id = await b.newSession();
    const r = await post(id);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "reloaded" });
    expect((await b.context(id)).status).toBe(200);
  });
});
