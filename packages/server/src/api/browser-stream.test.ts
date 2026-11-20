// 画面流路由：升级前的 404、首帧 state、JPEG 帧、输入到达页面、坏消息、关闭与观看计数。
import { request } from "node:http";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { waitFor } from "../../test/support/frames.js";
import {
  cleanupTmpDirs,
  type FakePage,
  type Harness,
  makeRegistry,
} from "../browser/pages/testkit.js";
import type { PageView } from "../browser/pages/types.js";
import { StreamHub } from "../browser/stream/hub.js";
import { browserStreamApi } from "./browser-stream.js";

afterAll(cleanupTmpDirs);

// 画面流客户端：文本帧是 JSON 事件，二进制帧是画面。
class StreamClient {
  readonly events: Array<Record<string, unknown>> = [];
  readonly frames: Buffer[] = [];
  closed: number | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) this.frames.push(raw);
      else
        this.events.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    ws.on("close", (code) => {
      this.closed = code;
    });
  }

  static async connect(url: string): Promise<StreamClient> {
    const ws = new WebSocket(url);
    const c = new StreamClient(ws);
    await new Promise<void>((ok, fail) => {
      ws.once("open", () => ok());
      ws.once("error", fail);
      ws.once("unexpected-response", (_q, res) =>
        fail(new Error(`HTTP ${res.statusCode}`)),
      );
    });
    return c;
  }

  types(): string[] {
    return this.events.map((e) => e.type as string);
  }

  errors(): string[] {
    return this.events.flatMap((e) =>
      e.type === "error" ? [e.message as string] : [],
    );
  }

  states(): Array<{ page: PageView; operator: boolean }> {
    return this.events.filter((e) => e.type === "state") as unknown as Array<{
      page: PageView;
      operator: boolean;
    }>;
  }

  send(raw: unknown): void {
    this.ws.send(typeof raw === "string" ? raw : JSON.stringify(raw));
  }

  close(): void {
    this.ws.terminate();
  }
}

let app: FastifyInstance | undefined;
let harness: Harness | undefined;
let wsBase = "";
let httpBase = "";
const clients: StreamClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await app?.close();
  app = undefined;
  harness = undefined;
});

async function boot(
  opts: { frameWindowBytes?: number } = {},
): Promise<Harness> {
  harness = makeRegistry();
  const hub = new StreamHub({
    registry: harness.registry,
    resolveGoto: (_workspaceKey, raw) =>
      raw.startsWith("blocked/")
        ? { ok: false, error: "这个地址不能打开" }
        : { ok: true, url: `https://${raw}/` },
  });
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(browserStreamApi, {
    hub,
    pages: harness.registry,
    ...opts,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  httpBase = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  return harness;
}

const path = (wid: string, pid: string) =>
  `/api/v1/workspaces/${wid}/browser/pages/${pid}/stream`;
const streamUrl = (wid: string, pid: string) => `${wsBase}${path(wid, pid)}`;
const httpStreamUrl = (wid: string, pid: string) =>
  `${httpBase}${path(wid, pid)}`;

async function openPage(h: Harness): Promise<PageView> {
  const { page } = await h.registry.open({
    workspaceKey: "w1",
    actor: null,
    url: "https://a.test/",
  });
  return page;
}

async function connect(pageId: string, wid = "w1"): Promise<StreamClient> {
  const c = await StreamClient.connect(streamUrl(wid, pageId));
  clients.push(c);
  return c;
}

const fake = (h: Harness, id: string) => h.registry.peek(id) as FakePage;

/** 用带升级头的普通请求看服务端是否在握手之前就拒了。 */
function upgrade(url: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request(
      url,
      {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

describe("升级前的校验", () => {
  test("页面不存在：普通 404", async () => {
    await boot();
    const res = await upgrade(httpStreamUrl("w1", "nope"));
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
  });

  test("页面不属于这个工作区：普通 404", async () => {
    const h = await boot();
    const page = await openPage(h);
    const res = await upgrade(httpStreamUrl("other", page.id));
    expect(res.status).toBe(404);
    // 客户端看到的是握手被拒，不是连上再关闭。
    await expect(
      StreamClient.connect(streamUrl("other", page.id)),
    ).rejects.toThrow("HTTP 404");
  });
});

describe("画面与状态", () => {
  test("连上先收到一条 state，operator 为真", async () => {
    const h = await boot();
    const page = await openPage(h);
    const c = await connect(page.id);
    await waitFor(() => c.events.length > 0, "首帧 state");
    expect(c.events[0]?.type).toBe("state");
    expect(c.states()[0]).toMatchObject({
      page: { id: page.id },
      operator: true,
    });
  });

  test("页面出帧后客户端收到二进制帧", async () => {
    const h = await boot();
    const page = await openPage(h);
    const c = await connect(page.id);
    await waitFor(() => c.events.length > 0, "首帧 state");
    await fake(h, page.id).pushFrame(Buffer.from("jpeg-1"));
    await waitFor(() => c.frames.length > 0, "二进制帧");
    expect(c.frames[0]?.toString()).toBe("jpeg-1");
  });

  test("input 消息到达页面", async () => {
    const h = await boot();
    const page = await openPage(h);
    const c = await connect(page.id);
    await waitFor(() => c.events.length > 0, "首帧 state");
    c.send({
      type: "input",
      event: { type: "mouse", action: "down", x: 5, y: 6 },
    });
    await waitFor(() => fake(h, page.id).inputs.length > 0, "输入到达");
    expect(fake(h, page.id).inputs).toEqual([
      { type: "mouse", action: "down", x: 5, y: 6 },
    ]);
  });

  test("非 JSON 文本与二进制帧都回 error，连接保持", async () => {
    const h = await boot();
    const page = await openPage(h);
    const c = await connect(page.id);
    await waitFor(() => c.events.length > 0, "首帧 state");
    c.send("not json");
    c.ws.send(Buffer.from("binary"));
    await waitFor(() => c.errors().length >= 2, "两条 error");
    expect(c.errors()).toEqual([
      "消息必须是 JSON 文本",
      "画面流只接受 JSON 文本消息，不接受二进制帧",
    ]);
    expect(c.closed).toBeNull();

    // 连接还能用
    c.send({ type: "input", event: { type: "text", text: "ok" } });
    await waitFor(() => fake(h, page.id).inputs.length > 0, "后续消息生效");
  });
});

describe("关闭与计数", () => {
  test("页面被关：客户端收到 closed，连接以 1000 关闭", async () => {
    const h = await boot();
    const page = await openPage(h);
    const c = await connect(page.id);
    await waitFor(() => c.events.length > 0, "首帧 state");
    await h.registry.close(page.id, "user");
    await waitFor(() => c.closed !== null, "连接关闭");
    expect(c.types()).toContain("closed");
    expect(c.closed).toBe(1000);
  });

  test("客户端断开后 viewers 归零", async () => {
    const h = await boot();
    const page = await openPage(h);
    const c = await connect(page.id);
    await waitFor(() => h.registry.get(page.id)?.viewers === 1, "计数加一");
    c.close();
    await waitFor(() => h.registry.get(page.id)?.viewers === 0, "计数归零");
  });

  // 窗口 0 字节：一帧在路上就算满了，等于一个一直没确认的客户端。
  test("客户端没确认时只发第一帧，文本事件照发；确认后补发最新的一帧，中间的跳过", async () => {
    const h = await boot({ frameWindowBytes: 0 });
    const page = await openPage(h);
    const c = await connect(page.id);
    await waitFor(() => c.events.length > 0, "首帧 state");
    const f = fake(h, page.id);

    await f.pushFrame(Buffer.from("jpeg-1"));
    await f.pushFrame(Buffer.from("jpeg-2"));
    await f.pushFrame(Buffer.from("jpeg-3"));
    h.registry.control(page.id, "agent");
    await waitFor(() => c.states().length >= 2, "文本事件照发");
    await waitFor(() => c.frames.length >= 1, "第一帧");
    expect(c.frames.map(String)).toEqual(["jpeg-1"]);

    c.send({ type: "ack" });
    await waitFor(() => c.frames.length >= 2, "确认后补发");
    expect(c.frames.map(String)).toEqual(["jpeg-1", "jpeg-3"]);
  });

  test("确认不走中枢的队列：输入还在处理时，确认照样立刻生效", async () => {
    const h = await boot({ frameWindowBytes: 0 });
    const page = await openPage(h);
    const c = await connect(page.id);
    await waitFor(() => c.events.length > 0, "首帧 state");
    const f = fake(h, page.id);
    await f.pushFrame(Buffer.from("jpeg-1"));
    await f.pushFrame(Buffer.from("jpeg-2"));
    await waitFor(() => c.frames.length >= 1, "第一帧");

    // 让输入卡住：中枢按顺序处理，确认要是排在它后面就发不出来
    let release: () => void = () => {};
    f.input = () => new Promise<void>((ok) => (release = ok));
    c.send({ type: "input", event: { type: "text", text: "slow" } });
    c.send({ type: "ack" });
    await waitFor(() => c.frames.length >= 2, "确认不被卡住的输入拦住");
    expect(c.frames.map(String)).toEqual(["jpeg-1", "jpeg-2"]);
    expect(c.errors()).toEqual([]);
    release();
  });

  test("ping 不进中枢，连接层直接回 pong", async () => {
    const h = await boot();
    const page = await openPage(h);
    const c = await connect(page.id);
    await waitFor(() => c.events.length > 0, "首帧 state");
    c.send({ type: "ping" });
    await waitFor(() => c.types().includes("pong"), "pong");
    expect(c.errors()).toEqual([]);
  });
});
