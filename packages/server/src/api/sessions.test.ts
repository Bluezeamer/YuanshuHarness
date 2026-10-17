import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
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
import WebSocket from "ws";
import { expectContiguous, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import type { SessionPool } from "../session/pool.js";
import { DEFAULTS, sessionsApi } from "./sessions.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let app: FastifyInstance;
let pool: SessionPool;
let data: TestData | undefined;
let base: string;
const clients: TestClient[] = [];

async function boot(
  tuning: Partial<typeof DEFAULTS> = {},
  poolOverride?: SessionPool | null,
  backend: { url: string } = stub,
  modelExtra: Record<string, unknown> = {},
) {
  data?.close();
  data = testData();
  pool = testPool(stubSessionFactory(backend, modelExtra), data).pool;
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: DEFAULTS.maxPayloadBytes },
    errorHandler: () => {},
  });
  await app.register(sessionsApi, {
    ...DEFAULTS,
    ...tuning,
    pool: poolOverride === undefined ? pool : poolOverride,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

async function connect(wsBase: string, id: string) {
  const c = await TestClient.connect(`${wsBase}/api/v1/sessions/${id}/stream`);
  clients.push(c);
  return c;
}

async function newSession(httpBase: string): Promise<string> {
  const res = await fetch(`${httpBase}/api/v1/sessions`, { method: "POST" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-api-"));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  stub.mode.delayMs = 0;
  stub.mode.status = 200;
  stub.requests.length = 0;
  await app?.close();
  pool?.dispose();
  data?.close();
  data = undefined;
  await rm(base, { recursive: true, force: true });
});

const ended =
  (c: TestClient, n = 1) =>
  () =>
    c.types().filter((t) => t === "run.ended").length >= n;

describe("R2/R3 REST", () => {
  test("创建、列表、查询；不存在返回 404", async () => {
    const { http } = await boot();
    const id = await newSession(http);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
    const list = (await (await fetch(`${http}/api/v1/sessions`)).json()) as {
      sessions: { id: string; running: boolean }[];
    };
    expect(list.sessions.map((s) => s.id)).toEqual([id]);
    expect(list.sessions[0]?.running).toBe(false);
    const one = await fetch(`${http}/api/v1/sessions/${id}`);
    expect(one.status).toBe(200);
    expect((await fetch(`${http}/api/v1/sessions/nope`)).status).toBe(404);
  });

  test("未配置会话工厂：创建返回 501，列表为空，stream 为 404", async () => {
    const { http, ws } = await boot({}, null);
    const res = await fetch(`${http}/api/v1/sessions`, { method: "POST" });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "no_session_backend" });
    expect(await (await fetch(`${http}/api/v1/sessions`)).json()).toEqual({
      sessions: [],
    });
    await expect(
      TestClient.connect(`${ws}/api/v1/sessions/x/stream`),
    ).rejects.toThrow(/404/);
  });
});

describe("R12 stream 升级", () => {
  test("不存在的会话：握手阶段 404，不建立 WebSocket", async () => {
    const { ws } = await boot();
    await expect(
      TestClient.connect(`${ws}/api/v1/sessions/does-not-exist/stream`),
    ).rejects.toThrow(/404/);
  });
});

describe("流与命令", () => {
  test("连接首帧是快照；send_message 得到 ack 与连续事件；两个连接所见相同", async () => {
    const { http, ws } = await boot();
    const id = await newSession(http);
    const a = await connect(ws, id);
    const b = await connect(ws, id);
    await waitFor(() => a.frames.length > 0 && b.frames.length > 0, "快照");
    expect(a.frames[0]?.type).toBe("snapshot");

    const ack = await a.command("send_message", { text: "hello" });
    expect(ack).toMatchObject({ ok: true });
    await waitFor(ended(a), "a 结束");
    await waitFor(ended(b), "b 结束");
    expectContiguous(a.frames);
    expectContiguous(b.frames);
    expect(a.frames.map((f) => f.seq)).toEqual(b.frames.map((f) => f.seq));
    // ack 不占序号
    expect(a.frames.every((f) => f.type !== "ack")).toBe(true);
    expect(a.frames.find((f) => f.type === "message.delta")?.data.text).toBe(
      "reply-1",
    );
  });

  test("R8 resync：重发快照，之后事件接着编号", async () => {
    const { http, ws } = await boot();
    const id = await newSession(http);
    const c = await connect(ws, id);
    await c.command("send_message", { text: "one" });
    await waitFor(ended(c), "结束");
    const before = c.frames.length;
    expect(await c.command("resync")).toMatchObject({ ok: true });
    await waitFor(() => c.frames.length > before, "新快照");
    const snap = c.frames[before];
    expect(snap?.type).toBe("snapshot");
    expect(snap?.data.messages).toHaveLength(2);
    await c.command("send_message", { text: "two" });
    await waitFor(ended(c, 2), "第二次结束");
    expectContiguous(c.frames.slice(before));
  });

  test("R10 另一连接可以停止运行", async () => {
    const { http, ws } = await boot();
    const id = await newSession(http);
    const a = await connect(ws, id);
    const b = await connect(ws, id);
    stub.mode.delayMs = 2000;
    await a.command("send_message", { text: "long" });
    await waitFor(
      () => a.types().filter((t) => t === "message.started").length === 2,
      "生成中",
    );
    expect(await b.command("stop")).toMatchObject({ ok: true });
    await waitFor(ended(a), "结束");
    expect(a.frames.find((f) => f.type === "run.ended")?.data).toEqual({
      aborted: true,
    });
  });
});

describe("R11 非法输入", () => {
  test("逐项失败 ack，连接保持可用", async () => {
    const { http, ws } = await boot({}, undefined, stub, {
      input: ["text", "image"],
    });
    const id = await newSession(http);
    const c = await connect(ws, id);
    const raw = async (data: string | Buffer, binary = false) => {
      const n = c.acks.length;
      c.ws.send(data, { binary });
      await waitFor(() => c.acks.length > n, "ack");
      return c.acks[n];
    };
    expect(await raw("not json")).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect((await raw("not json"))?.id).toBeUndefined();
    expect(await raw(JSON.stringify([1]))).toMatchObject({ ok: false });
    expect(await raw(JSON.stringify({ type: "stop" }))).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await raw(Buffer.from("x"), true)).toMatchObject({ ok: false });
    expect(await raw(JSON.stringify({ id: "u", type: "fly" }))).toMatchObject({
      id: "u",
      ok: false,
      error: { code: "unknown_command" },
    });
    expect(await c.command("send_message", { text: "   " })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await c.command("send_message", { text: 5 })).toMatchObject({
      ok: false,
    });
    expect(
      await c.command("send_message", { text: "x", images: [{ data: 1 }] }),
    ).toMatchObject({ ok: false });
    expect(
      await c.command("send_message", {
        text: "x",
        images: [{ mimeType: "image/png", data: "!not base64!" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(c.closed).toBeNull();
    expect(await c.command("resync")).toMatchObject({ ok: true });
    expect(stub.requests).toHaveLength(0);
    // 每条带 id 的命令恰好一个 ack
    const ids = c.acks.flatMap((a) => (a.id === undefined ? [] : [a.id]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("超过 50 MiB 的单条消息：以 1009 关闭连接", async () => {
    const { http, ws } = await boot();
    const id = await newSession(http);
    const c = await connect(ws, id);
    c.ws.send(
      JSON.stringify({
        id: "big",
        type: "send_message",
        text: "x".repeat(DEFAULTS.maxPayloadBytes + 1024),
      }),
    );
    expect(await c.waitClosed()).toBe(1009);
    expect(stub.requests).toHaveLength(0);
  });

  test("超长 id 被拒绝且不回显；畸形 base64、空 data 被拒绝", async () => {
    const { http, ws } = await boot({}, undefined, stub, {
      input: ["text", "image"],
    });
    const id = await newSession(http);
    const c = await connect(ws, id);
    const raw = async (obj: unknown) => {
      const n = c.acks.length;
      c.ws.send(JSON.stringify(obj));
      await waitFor(() => c.acks.length > n, "ack");
      return c.acks[n];
    };
    const long = await raw({
      id: "i".repeat(257),
      type: "send_message",
      text: "x",
    });
    expect(long).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(JSON.stringify(long).length).toBeLessThan(1024);
    for (const data of ["", "abc", "ab=c", "a===", "@@@@", "AA=A"]) {
      const ack = await raw({
        id: "b",
        type: "send_message",
        text: "x",
        images: [{ mimeType: "image/png", data }],
      });
      expect(ack, data).toMatchObject({ ok: false });
    }
    const longMime = await raw({
      id: "m",
      type: "send_message",
      text: "x",
      images: [{ mimeType: `image/${"p".repeat(200)}`, data: "AAAA" }],
    });
    expect(longMime).toMatchObject({ ok: false });
    expect(c.closed).toBeNull();
  });

  test("接近上限的带图消息可以接受", async () => {
    const { http, ws } = await boot();
    const id = await newSession(http);
    const c = await connect(ws, id);
    const ack = await c.command("send_message", {
      text: "x",
      images: [{ mimeType: "image/png", data: "A".repeat(20 * 1024 * 1024) }],
    });
    // 本模型不支持图片，所以是业务上的拒绝，而不是连接层的拒绝
    expect(ack).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(c.closed).toBeNull();
  });
});

describe("R13 心跳", () => {
  test("客户端不回 pong：被断开且订阅被释放", async () => {
    const { http, ws } = await boot({ pingIntervalMs: 40, pongTimeoutMs: 40 });
    const id = await newSession(http);
    const raw = new WebSocket(`${ws}/api/v1/sessions/${id}/stream`, {
      autoPong: false,
    });
    await new Promise((r) => raw.once("open", r));
    const entry = pool.get(id);
    await waitFor(() => entry?.subscriberCount === 1, "已订阅");
    await new Promise((r) => raw.once("close", r));
    await waitFor(() => entry?.subscriberCount === 0, "订阅释放");
  });

  test("正常回 pong 的连接不会被断开", async () => {
    const { http, ws } = await boot({ pingIntervalMs: 40, pongTimeoutMs: 40 });
    const id = await newSession(http);
    const c = await connect(ws, id);
    await new Promise((r) => setTimeout(r, 300));
    expect(c.closed).toBeNull();
  });

  test("客户端正常断开后订阅被释放", async () => {
    const { http, ws } = await boot();
    const id = await newSession(http);
    const c = await connect(ws, id);
    const entry = pool.get(id);
    await waitFor(() => entry?.subscriberCount === 1, "已订阅");
    c.close();
    await waitFor(() => entry?.subscriberCount === 0, "订阅释放");
  });
});

describe("R14 背压", () => {
  // 单帧（message.ended 带全文）本身可以很大，所以每轮只产出 ~700KB；
  // 慢连接靠多轮累积，越过内核缓冲后才会出现积压。
  test("读得慢的连接被以 1013 关闭，同会话的其他连接不受影响", async () => {
    const big = await startStub(() => "z".repeat(700 * 1024));
    big.mode.chunkBytes = 64 * 1024;
    const b2 = await boot(
      { maxBufferedBytes: 2 * 1024 * 1024 },
      undefined,
      big,
    );
    try {
      const id = await newSession(b2.http);
      const fast = await connect(b2.ws, id);
      const slow = await connect(b2.ws, id);
      const sock = (slow.ws as unknown as { _socket: net.Socket })._socket;
      sock.pause();
      for (let round = 1; round <= 30; round++) {
        await fast.command("send_message", { text: `r${round}` });
        await waitFor(ended(fast, round), `fast 第 ${round} 轮`, 15000);
      }
      sock.resume();
      expect(await slow.waitClosed()).toBe(1013);
      expect(fast.closed).toBeNull();
      expectContiguous(fast.frames);
    } finally {
      await big.close();
    }
  }, 120000);
});

describe("R9/R10 同一连接的命令顺序", () => {
  test("背靠背的 stop 与 send_message：消息在中止之后开始新的运行，不滞留", async () => {
    const { http, ws } = await boot();
    const id = await newSession(http);
    const c = await connect(ws, id);
    stub.mode.delayMs = 1500;
    await c.command("send_message", { text: "long" });
    await waitFor(
      () => c.types().filter((t) => t === "message.started").length === 2,
      "生成中",
    );
    stub.mode.delayMs = 0;
    c.ws.send(JSON.stringify({ id: "s", type: "stop" }));
    c.ws.send(JSON.stringify({ id: "m", type: "send_message", text: "next" }));
    await waitFor(() => c.acks.some((a) => a.id === "m"), "ack m");
    await waitFor(ended(c, 2), "新的运行完成");
    expect(JSON.stringify(stub.requests.at(-1)?.body)).toContain("next");
  });
});

describe("R16 大载荷截断", () => {
  test("超大回复被截断并标记，连接保持可用；重连的快照也有界且可连上", async () => {
    const big = await startStub(() => "z".repeat(8 * 1024 * 1024));
    const b = await boot({ maxBufferedBytes: 1024 * 1024 }, undefined, big);
    try {
      const id = await newSession(b.http);
      const c = await connect(b.ws, id);
      await c.command("send_message", { text: "go" });
      await waitFor(ended(c), "运行结束", 20000);
      const end = c.frames.filter((f) => f.type === "message.ended").at(-1);
      expect(end?.data.truncated).toBe(true);
      expect(String(end?.data.text).length).toBeLessThanOrEqual(256 * 1024);
      expect(c.closed).toBeNull();
      expectContiguous(c.frames);
      // 快照：每条消息文本不超过 32 KiB，整体远小于 1 MiB 阈值，新连接连得上
      const c2 = await connect(b.ws, id);
      await waitFor(() => c2.frames.length > 0, "快照");
      const snap = c2.frames[0];
      expect(snap?.data.truncated).toBe(true);
      for (const m of snap?.data.messages ?? [])
        expect(m.text.length).toBeLessThanOrEqual(32 * 1024);
      expect(c2.closed).toBeNull();
    } finally {
      await big.close();
    }
  }, 60000);
});

describe("R14 空队列允许整帧", () => {
  test("单帧大于阈值但连接健康（队列为空）：不断开", async () => {
    const big = await startStub(() => "z".repeat(300 * 1024));
    const b = await boot({ maxBufferedBytes: 64 * 1024 }, undefined, big);
    try {
      const id = await newSession(b.http);
      const c = await connect(b.ws, id);
      await c.command("send_message", { text: "go" });
      await waitFor(ended(c), "运行结束", 20000);
      expect(c.frames.some((f) => f.type === "message.ended")).toBe(true);
      expect(c.closed).toBeNull();
    } finally {
      await big.close();
    }
  }, 60000);
});

describe("R11 入站积压", () => {
  test("待处理字节（含正在处理的这条）超限：断开连接而不是无界缓存", async () => {
    const { http, ws } = await boot({ maxPendingBytes: 1024 * 1024 });
    const id = await newSession(http);
    const c = await connect(ws, id);
    c.ws.send("x".repeat(1536 * 1024));
    expect(await c.waitClosed()).toBe(1013);
  });

  test("images 数量有上限", async () => {
    const { http, ws } = await boot({}, undefined, stub, {
      input: ["text", "image"],
    });
    const id = await newSession(http);
    const c = await connect(ws, id);
    const img = { mimeType: "image/png", data: "AAAA" };
    const ack = await c.command("send_message", {
      text: "x",
      images: Array.from({ length: 21 }, () => img),
    });
    expect(ack).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});

describe("连接关闭后资源释放", () => {
  test("背压断开的连接不留在订阅与连接集合里", async () => {
    const big = await startStub(() => "z".repeat(700 * 1024));
    big.mode.chunkBytes = 64 * 1024;
    const b = await boot({ maxBufferedBytes: 1024 * 1024 }, undefined, big);
    try {
      const id = await newSession(b.http);
      const entry = pool.get(id);
      const fast = await connect(b.ws, id);
      const slow = await connect(b.ws, id);
      (slow.ws as unknown as { _socket: net.Socket })._socket.pause();
      for (let round = 1; round <= 30 && slow.closed === null; round++) {
        await fast.command("send_message", { text: `r${round}` });
        await waitFor(ended(fast, round), `第 ${round} 轮`, 15000);
      }
      (slow.ws as unknown as { _socket: net.Socket })._socket.resume();
      expect(await slow.waitClosed()).toBe(1013);
      await waitFor(() => entry?.subscriberCount === 1, "慢连接订阅已释放");
      expect(app.websocketServer.clients.size).toBe(1);
    } finally {
      await big.close();
    }
  }, 120000);
});

describe("R15 服务停止", () => {
  test("stop() 断开所有连接并释放会话", async () => {
    const dataDir = path.join(base, "data");
    const webRoot = path.join(base, "web");
    await mkdir(webRoot, { recursive: true });
    await writeFile(path.join(webRoot, "index.html"), "<title>x</title>");
    const inner = stubSessionFactory(stub);
    let disposed = 0;
    const server: YuanshuServer = createServer(
      { host: "127.0.0.1", port: 0, dataDir },
      {
        webRoot,
        sessionFactory: async (o) => {
          const session = await inner(o);
          const dispose = session.dispose.bind(session);
          session.dispose = () => {
            disposed++;
            dispose();
          };
          return session;
        },
      },
    );
    const addr = await server.start();
    const http = `http://127.0.0.1:${addr.port}`;
    const id = await newSession(http);
    const a = await connect(`ws://127.0.0.1:${addr.port}`, id);
    const b = await connect(`ws://127.0.0.1:${addr.port}`, id);
    stub.mode.delayMs = 1500;
    await a.command("send_message", { text: "inflight" });
    await server.stop();
    // stop() 返回时连接必须已经关闭，而不是之后才关
    expect(a.closed).not.toBeNull();
    expect(b.closed).not.toBeNull();
    expect(disposed).toBe(1);
  });

  test("未配置工厂的真实 Server：POST 返回 501", async () => {
    const webRoot = path.join(base, "web");
    await mkdir(webRoot, { recursive: true });
    await writeFile(path.join(webRoot, "index.html"), "<title>x</title>");
    const server = createServer(
      { host: "127.0.0.1", port: 0, dataDir: path.join(base, "data") },
      { webRoot },
    );
    const addr = await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/sessions`, {
        method: "POST",
      });
      expect(res.status).toBe(501);
    } finally {
      await server.stop();
    }
  });
});
