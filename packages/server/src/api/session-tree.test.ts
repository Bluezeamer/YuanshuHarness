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
import type { SessionPool } from "../session/pool.js";
import type { TreeViewNode } from "../store/session-tree.js";
import { DEFAULTS, sessionsApi } from "./sessions.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let app: FastifyInstance;
let pool: SessionPool;
let data: TestData | undefined;
const clients: TestClient[] = [];

async function boot() {
  data?.close();
  data = testData();
  pool = testPool(stubSessionFactory(stub), data).pool;
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: DEFAULTS.maxPayloadBytes },
    errorHandler: () => {},
  });
  await app.register(sessionsApi, { ...DEFAULTS, pool });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

async function connect(wsBase: string, id: string) {
  const c = await TestClient.connect(`${wsBase}/api/v1/sessions/${id}/stream`);
  clients.push(c);
  return c;
}

async function newSession(http: string): Promise<string> {
  const res = await fetch(`${http}/api/v1/sessions`, { method: "POST" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const json = async <T>(url: string, init?: RequestInit): Promise<T> =>
  (await fetch(url, init)).json() as Promise<T>;

const flat = (nodes: TreeViewNode[]): TreeViewNode[] =>
  nodes.flatMap((n) => [n, ...flat(n.children)]);

// 让 stub 回复等到指定类型的帧出现。
const seen =
  (c: TestClient, type: string, n = 1) =>
  () =>
    c.types().filter((t) => t === type).length >= n;

beforeEach(() => {
  stub.mode.delayMs = 0;
  stub.requests.length = 0;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  stub.mode.delayMs = 0;
  await app?.close();
  pool?.dispose();
  data?.close();
  data = undefined;
});

describe("REST：会话树与指令列表", () => {
  test("空会话返回空树与空列表；不存在的会话 404", async () => {
    const { http } = await boot();
    const id = await newSession(http);

    expect(await json(`${http}/api/v1/sessions/${id}/tree`)).toEqual({
      leafId: null,
      activePath: [],
      nodes: [],
    });
    expect(await json(`${http}/api/v1/sessions/${id}/user-messages`)).toEqual({
      messages: [],
    });

    const nowhere = "019a0000-0000-7000-8000-000000000001";
    expect(
      (await fetch(`${http}/api/v1/sessions/${nowhere}/tree`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${http}/api/v1/sessions/${nowhere}/user-messages`)).status,
    ).toBe(404);
  });

  test("树/列表形状；navigate 返回 editor 且 WS 收到整份快照", async () => {
    const { http, ws } = await boot();
    const id = await newSession(http);
    const client = await connect(ws, id);
    expect(client.frames[0]?.type).toBe("snapshot");

    await client.command("send_message", { text: "第一轮" });
    await waitFor(seen(client, "run.ended"), "run.ended");
    await client.command("send_message", { text: "第二轮" });
    await waitFor(seen(client, "run.ended", 2), "run.ended");

    const tree = await json<{
      leafId: string | null;
      activePath: string[];
      nodes: TreeViewNode[];
    }>(`${http}/api/v1/sessions/${id}/tree`);
    const nodes = flat(tree.nodes);
    const users = nodes.filter((n) => n.role === "user");
    expect(users.map((n) => n.preview)).toEqual(["第一轮", "第二轮"]);
    expect(nodes.some((n) => n.type === "compaction")).toBe(false);
    expect(tree.activePath[0]).toBe(tree.leafId);

    const list = await json<{
      messages: { entryId: string; text: string; timestamp: string | null }[];
    }>(`${http}/api/v1/sessions/${id}/user-messages`);
    expect(list.messages.map((m) => m.text)).toEqual(["第一轮", "第二轮"]);
    expect(list.messages[0]?.entryId).toBe(users[0]?.id);
    expect(list.messages[0]?.timestamp).toEqual(expect.any(String));

    // 回退到第二条用户消息：leaf 落到第一次应答，editor 回填指令原文。
    const target = list.messages[1]?.entryId ?? "";
    expect(target).not.toBe("");
    const res = await fetch(`${http}/api/v1/sessions/${id}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: target }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      editor: { text: "第二轮" },
      leafId: users[1]?.parentId,
    });
    // 旧字段不再出现
    expect(body.editorText).toBeUndefined();

    // 回退后必须收到一帧完整快照替换（不是增量）。
    await waitFor(
      () =>
        client.frames.some(
          (f) =>
            f.type === "snapshot" &&
            f.data.messages.length === 2 &&
            f.data.messages[0].text === "第一轮",
        ),
      "回退后的快照",
    );
    const after = await json<{ leafId: string | null; activePath: string[] }>(
      `${http}/api/v1/sessions/${id}/tree`,
    );
    expect(after.leafId).toBe(users[1]?.parentId);
    const userTexts = await json<{ messages: { text: string }[] }>(
      `${http}/api/v1/sessions/${id}/user-messages`,
    );
    expect(userTexts.messages.map((m) => m.text)).toEqual(["第一轮"]);
    // 快照替换后事件序号按快照序号继续递增（客户端据快照重置期望，不必重连）。
    const replaced = client.frames
      .filter((f) => f.type === "snapshot" && f.data.messages.length === 2)
      .at(-1);
    await client.command("send_message", { text: "继续" });
    await waitFor(seen(client, "run.ended", 3), "run.ended");
    const next = client.frames.find(
      (f) => (f.seq as number) > (replaced?.seq ?? 0),
    );
    expect(next?.seq).toBe((replaced?.seq ?? 0) + 1);
    expect(next?.type).toBe("run.started");
  });

  test("运行中回退 409；请求体非法 400", async () => {
    const { http, ws } = await boot();
    const id = await newSession(http);
    const client = await connect(ws, id);
    await client.command("send_message", { text: "第一轮" });
    await waitFor(seen(client, "run.ended"), "run.ended");
    const entryId =
      (
        await json<{ messages: { entryId: string }[] }>(
          `${http}/api/v1/sessions/${id}/user-messages`,
        )
      ).messages[0]?.entryId ?? "";
    expect(entryId).not.toBe("");

    stub.mode.delayMs = 300;
    await client.command("send_message", { text: "慢请求" });
    await waitFor(seen(client, "run.started"), "run.started");
    const rejected = await fetch(`${http}/api/v1/sessions/${id}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "session_running" });
    await waitFor(seen(client, "run.ended", 2), "run.ended", 10_000);

    const bad = await fetch(`${http}/api/v1/sessions/${id}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: 42 }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${http}/api/v1/sessions/${id}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "no-such-entry" }),
    });
    expect(missing.status).toBe(400);
  });
});

describe("REST：复制会话分叉", () => {
  test("分叉返回新会话；可查询、可打开；标题按派生数递增", async () => {
    const { http } = await boot();
    const id = await newSession(http);
    const patched = await fetch(`${http}/api/v1/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "母会话" }),
    });
    expect(patched.status).toBe(200);

    // 直接在池内发两轮，避免再经过 WS。
    const entry = pool.get(id);
    if (!entry) throw new Error("会话不存在");
    for (const text of ["第一问", "第二问"]) {
      const frames: string[] = [];
      const unsub = entry.subscribe({
        send: (f) => frames.push(JSON.parse(f).type),
      });
      entry.send(text);
      await waitFor(() => frames.includes("run.ended"), "run.ended");
      unsub();
    }

    const tree = await json<{ nodes: TreeViewNode[] }>(
      `${http}/api/v1/sessions/${id}/tree`,
    );
    const assistants = flat(tree.nodes).filter((n) => n.role === "assistant");
    expect(assistants).toHaveLength(2);

    const fork = await fetch(`${http}/api/v1/sessions/${id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: assistants[0]?.id }),
    });
    expect(fork.status).toBe(201);
    const created = (await fork.json()) as { id: string; title: string };
    expect(created.title).toBe("母会话 · 分支1");
    expect(created.id).not.toBe(id);

    const view = await json<{ title: string }>(
      `${http}/api/v1/sessions/${created.id}`,
    );
    expect(view.title).toBe("母会话 · 分支1");
    const list = await json<{ sessions: { id: string }[] }>(
      `${http}/api/v1/sessions`,
    );
    expect(list.sessions.map((s) => s.id)).toContain(created.id);
    const forkTree = await json<{ leafId: string | null }>(
      `${http}/api/v1/sessions/${created.id}/tree`,
    );
    expect(forkTree.leafId).toBe(assistants[0]?.id);
    const forkMessages = await json<{ messages: { text: string }[] }>(
      `${http}/api/v1/sessions/${created.id}/user-messages`,
    );
    expect(forkMessages.messages.map((m) => m.text)).toEqual(["第一问"]);

    const second = await fetch(`${http}/api/v1/sessions/${id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: assistants[1]?.id }),
    });
    expect(((await second.json()) as { title: string }).title).toBe(
      "母会话 · 分支2",
    );

    // 请求体非法与分叉点不存在。
    const bad = await fetch(`${http}/api/v1/sessions/${id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${http}/api/v1/sessions/${id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "no-such-entry" }),
    });
    expect(missing.status).toBe(400);
  });
});
