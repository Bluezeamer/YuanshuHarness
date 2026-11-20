import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { SessionLibrary } from "../session/library.js";
import type { SessionPool } from "../session/pool.js";
import { SessionFeed } from "../session/session-feed.js";
import { SubagentStore } from "../store/subagents.js";
import { libraryStreamApi } from "./library-stream.js";
import { DEFAULTS, sessionsApi } from "./sessions.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let app: FastifyInstance | undefined;
let pool: SessionPool | undefined;
let data: TestData | undefined;
let http = "";
let wsBase = "";
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  stub.mode.delayMs = 0;
  stub.mode.status = 200;
  stub.requests.length = 0;
  await app?.close();
  pool?.dispose();
  data?.close();
  app = undefined;
  pool = undefined;
  data = undefined;
});

async function boot(): Promise<{ pool: SessionPool; feed: SessionFeed }> {
  data = testData();
  const subagents = new SubagentStore(data.db);
  pool = testPool(stubSessionFactory(stub), data, { subagents }).pool;
  const library = new SessionLibrary(pool);
  const feed = new SessionFeed({
    list: () => library.list(),
    view: (id) => library.get(id),
    topOf: (id) => subagents.rootOf(id),
    isListed: (id) => !pool?.isChild(id),
    clearMarks: (id) => data?.store.clearMarks(id),
  });
  pool.attachFeed(feed);
  subagents.onChange = (id) => feed.touch(id);

  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(sessionsApi, { ...DEFAULTS, pool });
  await app.register(libraryStreamApi, { ...DEFAULTS, feed });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  http = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  return { pool, feed };
}

const call = (method: string, p: string, body?: unknown) =>
  fetch(`${http}/api/v1${p}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
const create = async () =>
  ((await (await call("POST", "/sessions")).json()) as { id: string }).id;

async function connect(): Promise<TestClient> {
  const c = await TestClient.connect(`${wsBase}/api/v1/library/stream`);
  clients.push(c);
  await waitFor(() => c.frames.length > 0, "首帧快照");
  return c;
}

const updated = (c: TestClient, id: string) =>
  c.frames.filter(
    (f) =>
      (f.type === "session.updated" || f.type === "session.added") &&
      (f.data.session as { id: string }).id === id,
  );

describe("列表推送流", () => {
  test("首帧是 snapshot 且 seq = 1；序号逐条递增", async () => {
    await boot();
    const id = await create();
    const c = await connect();
    expect(c.frames[0]?.type).toBe("snapshot");
    expect(c.frames[0]?.seq).toBe(1);
    const sessions = c.frames[0]?.data.sessions as { id: string }[];
    expect(sessions.map((s) => s.id)).toEqual([id]);

    await call("PATCH", `/sessions/${id}`, { title: "改过" });
    await waitFor(() => updated(c, id).length > 0, "改名事件");
    expect(c.frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  test("新建发 added，改名发 updated，删除发 removed", async () => {
    await boot();
    const c = await connect();
    expect(c.frames[0]?.data).toEqual({ sessions: [] });

    const id = await create();
    await waitFor(() => updated(c, id).length > 0, "added");
    expect(updated(c, id)[0]?.type).toBe("session.added");

    await call("PATCH", `/sessions/${id}`, { title: "新名字" });
    await waitFor(
      () =>
        updated(c, id).some(
          (f) =>
            f.type === "session.updated" &&
            (f.data.session as { title: string }).title === "新名字",
        ),
      "updated",
    );

    expect((await call("DELETE", `/sessions/${id}`)).status).toBe(204);
    await waitFor(
      () => c.frames.some((f) => f.type === "session.removed"),
      "removed",
    );
    expect(c.frames.find((f) => f.type === "session.removed")?.data).toEqual({
      id,
    });
  });

  test("一轮结束没人在看：收到带 unreadResult 的 updated；上报 viewing 后标记被清掉", async () => {
    await boot();
    const id = await create();
    const c = await connect();
    const entry = pool?.get(id);
    if (!entry) throw new Error("会话不在池里");
    entry.send("go");
    await waitFor(
      () =>
        updated(c, id).some(
          (f) =>
            f.type === "session.updated" &&
            (f.data.session as { unreadResult: boolean }).unreadResult,
        ),
      "标记推出",
    );

    c.ws.send(JSON.stringify({ type: "viewing", sessionIds: [id] }));
    await waitFor(
      () =>
        updated(c, id).some(
          (f) =>
            f.type === "session.updated" &&
            !(f.data.session as { unreadResult: boolean }).unreadResult,
        ),
      "标记清掉",
    );
  });

  test("viewing 的坏入参被忽略，连接仍可用", async () => {
    const { feed } = await boot();
    const id = await create();
    const c = await connect();
    for (const bad of [
      "not json",
      JSON.stringify({ type: "viewing", sessionIds: "x" }),
      JSON.stringify({ type: "viewing", sessionIds: [1] }),
      JSON.stringify({
        type: "viewing",
        sessionIds: Array.from({ length: 201 }, () => id),
      }),
    ])
      c.ws.send(bad);
    await new Promise((r) => setTimeout(r, 50));
    expect(feed.watched(id)).toBe(false);
    expect(c.closed).toBeNull();

    c.ws.send(JSON.stringify({ type: "viewing", sessionIds: [id] }));
    await waitFor(() => feed.watched(id), "合法消息生效");
  });

  test("ping 回一条 pong 帧（占序号、不改列表），连接照常", async () => {
    await boot();
    const c = await connect();
    c.ws.send(JSON.stringify({ type: "ping" }));
    await waitFor(() => c.frames.some((f) => f.type === "pong"), "pong");
    expect(c.frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(c.closed).toBeNull();
  });

  test("连接关闭后它报告的「在看」不再算数", async () => {
    const { feed } = await boot();
    const id = await create();
    const c = await connect();
    c.ws.send(JSON.stringify({ type: "viewing", sessionIds: [id] }));
    await waitFor(() => feed.watched(id), "在看生效");
    c.close();
    await waitFor(() => !feed.watched(id), "断开后不再算在看");
  });
});
