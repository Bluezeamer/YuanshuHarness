import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let base: string;
let server: YuanshuServer | null = null;
const clients: TestClient[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-calls-"));
  await mkdir(path.join(base, "web"), { recursive: true });
  await writeFile(path.join(base, "web", "index.html"), "<title>x</title>");
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.stop().catch(() => {});
  server = null;
  stub.requests.length = 0;
  await rm(base, { recursive: true, force: true });
});

const TOKEN = process.env.YUANSHU_TEST_TOKEN;
const authInit = (init: RequestInit = {}): RequestInit =>
  TOKEN
    ? {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${TOKEN}`,
        },
      }
    : init;

async function launch() {
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, "data"),
      allowCidrs: [],
      ...(TOKEN ? { token: TOKEN } : {}),
    },
    {
      webRoot: path.join(base, "web"),
      sessionFactory: stubSessionFactory(stub),
    },
  );
  const addr = await server.start();
  return {
    http: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}`,
  };
}
type Srv = Awaited<ReturnType<typeof launch>>;

const get = (s: Srv, p: string) =>
  fetch(`${s.http}/api/v1/sessions${p}`, authInit());

async function newSession(s: Srv, texts: string[]): Promise<string> {
  const res = await fetch(
    `${s.http}/api/v1/sessions`,
    authInit({ method: "POST" }),
  );
  const { id } = (await res.json()) as { id: string };
  const c = await TestClient.connect(
    `${s.ws}/api/v1/sessions/${id}/stream`,
    TOKEN ? { token: TOKEN } : {},
  );
  clients.push(c);
  for (const [i, text] of texts.entries()) {
    await c.command("send_message", { text });
    await waitFor(
      () => c.types().filter((t) => t === "run.ended").length > i,
      "run.ended",
    );
  }
  return id;
}

type Page = {
  calls: Array<Record<string, unknown>>;
  nextBefore: number | null;
};

test("列表：倒序分页，摘要不含请求/响应原文", async () => {
  const s = await launch();
  const id = await newSession(s, ["一", "二", "三"]);
  const p1 = (await (await get(s, `/${id}/calls?limit=2`)).json()) as Page;
  expect(p1.calls.map((c) => c.seq)).toEqual([3, 2]);
  expect(p1.nextBefore).toBe(2);
  expect(p1.calls[0]).toMatchObject({
    trigger: "user",
    toolName: null,
    turn: 3,
    summary: "三",
    stopReason: "stop",
    calledTools: [],
    tokens: { out: 5, cacheRead: 0, cacheWrite: 0, estimated: false },
    // 每轮一前一后各加一条消息；没有压缩历史时所有调用都在当前段。
    msgCount: 5,
    segment: 0,
  });
  expect(p1.calls[1]).toMatchObject({ msgCount: 3, segment: 0 });
  expect(p1.calls[0]).not.toHaveProperty("request");
  expect(p1.calls[0]).not.toHaveProperty("response");
  const p2 = (await (
    await get(s, `/${id}/calls?before=2&limit=2`)
  ).json()) as Page;
  expect(p2.calls.map((c) => c.seq)).toEqual([1]);
  expect(p2.nextBefore).toBeNull();
});

test("详情：当前段 request 是该会话最新一次请求体，range 标出这条调用的新增内容", async () => {
  const s = await launch();
  const id = await newSession(s, ["一", "二"]);
  const { calls } = (await (await get(s, `/${id}/calls`)).json()) as Page;
  const first = calls.at(-1);
  const res = await get(s, `/${id}/calls/${first?.id}`);
  expect(res.status).toBe(200);
  const rec = (await res.json()) as Record<string, unknown>;
  // 请求不再逐次存：当前段统一回放该会话的最新请求体，区间是 [本次请求项数, 同段下一次的项数)。
  expect(JSON.stringify(rec.request)).toBe(
    JSON.stringify(stub.requests.at(-1)?.body),
  );
  expect(rec.response).toMatchObject({
    stopReason: "stop",
    content: [{ type: "text", text: "reply-1" }],
  });
  expect(rec).toMatchObject({
    sessionId: id,
    seq: 1,
    turn: 1,
    msgCount: 1,
    segment: 0,
    snapshot: false,
  });
  expect(rec.range).toEqual({ from: 1, to: 3 });
});

test("用量：聚合字段，不含成本", async () => {
  const s = await launch();
  const id = await newSession(s, ["一", "二"]);
  const u = (await (await get(s, `/${id}/usage`)).json()) as Record<
    string,
    unknown
  >;
  expect(u).toMatchObject({
    turns: 2,
    steps: 2,
    tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
    cacheHitRate: 0,
    // 服务端旁路统计：没有工具执行时工具耗时是实测的 0；首 token 每次调用都测到。
    toolMs: 0,
    ttftMs: expect.any(Number),
    context: { used: 15, messages: expect.any(Number) },
  });
  expect(JSON.stringify(u)).not.toMatch(/cost/i);
  const empty = await (
    await get(s, `/${await newSession(s, [])}/usage`)
  ).json();
  expect(empty).toMatchObject({
    turns: 0,
    steps: 0,
    toolMs: null,
    ttftMs: null,
    cacheHitRate: null,
    context: null,
  });
});

test("404 / 400：会话不存在、call 不属于该会话、非法分页参数", async () => {
  const s = await launch();
  const a = await newSession(s, ["一"]);
  const b = await newSession(s, ["二"]);
  const callA = ((await (await get(s, `/${a}/calls`)).json()) as Page).calls[0]
    ?.id;
  expect((await get(s, "/nope/calls")).status).toBe(404);
  expect((await get(s, `/nope/calls/${callA}`)).status).toBe(404);
  expect((await get(s, "/nope/usage")).status).toBe(404);
  expect((await get(s, `/${b}/calls/${callA}`)).status).toBe(404);
  expect((await get(s, `/${a}/calls/nope`)).status).toBe(404);
  expect((await get(s, `/${a}/calls?before=0`)).status).toBe(400);
  expect((await get(s, `/${a}/calls?limit=abc`)).status).toBe(400);
  expect((await get(s, `/${a}/calls?limit=99999`)).status).toBe(400);
});
