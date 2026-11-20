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
import type { SessionPool } from "../session/pool.js";
import { DEFAULTS, sessionsApi } from "./sessions.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let app: FastifyInstance | undefined;
let pool: SessionPool;
let data: TestData | undefined;
let http: string;
let wsBase: string;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  stub.mode.delayMs = 0;
  stub.requests.length = 0;
  await app?.close();
  pool?.dispose();
  data?.close();
  app = undefined;
  data = undefined;
});

async function boot() {
  data = testData();
  pool = testPool(stubSessionFactory(stub), data).pool;
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(sessionsApi, { ...DEFAULTS, pool });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  http = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
}

type View = {
  id: string;
  title: string;
  no: string | null;
  name: string | null;
  status: string;
  pinned: boolean;
  lifecycle: string;
  running: boolean;
  directoryId: string;
  promptPresetId: string | null;
  activeModeId: string | null;
  createdAt: string;
  updatedAt: string;
};
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
const json = async <T>(r: Response) => (await r.json()) as T;
const create = async () =>
  (await json<{ id: string }>(await call("POST", "/sessions"))).id;
const list = async (qs = "") =>
  (await json<{ sessions: View[] }>(await call("GET", `/sessions${qs}`)))
    .sessions;
const one = async (id: string) =>
  json<View>(await call("GET", `/sessions/${id}`));
const ids = (vs: View[]) => vs.map((v) => v.id);

describe("会话元数据与编号", () => {
  test("新会话带编号 #NNNN、active/idle；旧字段保留；编号递增且删除后不复用", async () => {
    await boot();
    const a = await create();
    const b = await create();
    const va = await one(a);
    expect(va).toMatchObject({
      id: a,
      title: "新对话",
      no: "#0001",
      name: null,
      status: "idle",
      lifecycle: "active",
      running: false,
      activeModeId: null,
    });
    expect(typeof va.createdAt).toBe("string");
    expect(typeof va.updatedAt).toBe("string");
    expect(typeof va.directoryId).toBe("string");
    // 尚未跑过的会话被写入元数据时补建索引行，编号保持建会话时分配的那个。
    expect((await call("POST", `/sessions/${a}/archive`)).status).toBe(200);
    expect(data?.store.get(a)?.seqNo).toBe(1);
    expect((await one(b)).no).toBe("#0002");
    expect((await call("DELETE", `/sessions/${b}`)).status).toBe(204);
    const c = await create();
    expect((await one(c)).no).toBe("#0003");
  });
});

describe("PATCH /sessions/:id", () => {
  test("pinned 置顶 / 取消置顶：落库、随会话视图给出；非布尔 400", async () => {
    await boot();
    const id = await create();
    expect((await one(id)).pinned).toBe(false);
    let r = await call("PATCH", `/sessions/${id}`, { pinned: true });
    expect(r.status).toBe(200);
    expect((await json<View>(r)).pinned).toBe(true);
    expect(data?.store.get(id)?.pinned).toBe(true);
    expect((await one(id)).pinned).toBe(true);
    r = await call("PATCH", `/sessions/${id}`, { pinned: false });
    expect((await json<View>(r)).pinned).toBe(false);
    expect(
      (await call("PATCH", `/sessions/${id}`, { pinned: "yes" })).status,
    ).toBe(400);
  });

  test("title 改名（别名 name）；旧入参 name 仍可用；非法入参整体不生效", async () => {
    await boot();
    const id = await create();
    let r = await call("PATCH", `/sessions/${id}`, { title: "  重构登录  " });
    expect(r.status).toBe(200);
    expect(await json<View>(r)).toMatchObject({
      title: "重构登录",
      name: "重构登录",
    });
    r = await call("PATCH", `/sessions/${id}`, { name: "旧入参" });
    expect(await json<View>(r)).toMatchObject({
      title: "旧入参",
      name: "旧入参",
    });

    for (const bad of [
      {},
      { title: "" },
      { title: "x".repeat(49) },
      { title: 1 },
      { title: "ok", pinned: 1 },
    ])
      expect((await call("PATCH", `/sessions/${id}`, bad)).status).toBe(400);
    expect((await one(id)).title).toBe("旧入参");
    expect((await call("PATCH", "/sessions/nope", { title: "x" })).status).toBe(
      404,
    );
    r = await call("PATCH", `/sessions/${id}`, { title: "x".repeat(48) });
    expect(r.status).toBe(200);
  });
});

describe("生命周期动作", () => {
  test("archive / unarchive：取消归档直接回 active/idle", async () => {
    await boot();
    const id = await create();
    const arch = await json<View>(
      await call("POST", `/sessions/${id}/archive`),
    );
    expect(arch).toMatchObject({ lifecycle: "archived", status: "archived" });
    // 归档后重复归档幂等。
    expect((await call("POST", `/sessions/${id}/archive`)).status).toBe(200);
    const un = await json<View>(
      await call("POST", `/sessions/${id}/unarchive`),
    );
    expect(un).toMatchObject({ lifecycle: "active", status: "idle" });
    expect((await call("POST", `/sessions/${id}/unarchive`)).status).toBe(409);
    expect((await one(id)).lifecycle).toBe("active");
    for (const a of ["archive", "unarchive", "refresh-context"])
      expect((await call("POST", `/sessions/nope/${a}`)).status).toBe(404);
  });

  test("运行中归档返回 409 session_running；运行结束后可归档；已归档会话可删除", async () => {
    await boot();
    const id = await create();
    const c = await TestClient.connect(
      `${wsBase}/api/v1/sessions/${id}/stream`,
    );
    clients.push(c);
    stub.mode.delayMs = 1500;
    await c.command("send_message", { text: "long" });
    await waitFor(() => c.types().includes("message.started"), "生成中");
    expect((await one(id)).status).toBe("running");
    const r = await call("POST", `/sessions/${id}/archive`);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "session_running" });
    expect((await one(id)).lifecycle).toBe("active");
    // 删除运行中仍然 409。
    expect((await call("DELETE", `/sessions/${id}`)).status).toBe(409);
    await c.command("stop");
    await waitFor(() => c.types().includes("run.ended"), "结束");
    expect((await one(id)).status).toBe("idle");
    expect((await call("POST", `/sessions/${id}/archive`)).status).toBe(200);
    expect((await call("DELETE", `/sessions/${id}`)).status).toBe(204);
    expect((await list()).length).toBe(0);
  });

  test("有待答复弹窗的 active 会话对外是 blocked", async () => {
    await boot();
    const id = await create();
    const entry = pool.get(id);
    const pending = entry?.ask({
      source: "question",
      input: "text",
      title: "你好吗",
    });
    expect((await one(id)).status).toBe("blocked");
    expect((await list("?status=blocked")).map((v) => v.id)).toEqual([id]);
    pool.dispose();
    await pending;
  });
});

describe("刷新上下文", () => {
  test("原地：200、同一个会话，名字与配置不动，不新建；不存在 404", async () => {
    await boot();
    const src = await create();
    await call("PATCH", `/sessions/${src}`, { title: "正在做" });
    const before = (await list()).length;

    const r = await call("POST", `/sessions/${src}/refresh-context`);
    expect(r.status).toBe(200);
    const same = await json<View>(r);
    expect(same.id).toBe(src);
    expect(same).toMatchObject({
      title: "正在做",
      lifecycle: "active",
    });
    expect((await list()).length).toBe(before);
    expect((await call("POST", "/sessions/nope/refresh-context")).status).toBe(
      404,
    );
  });
});

describe("列表", () => {
  test("默认按更新时间倒序；?status 多值、?q 搜 title/name/编号/提示词预设；未知 status 400", async () => {
    await boot();
    const a = await create();
    const b = await create();
    const c = await create();
    // 默认按更新时间倒序：跑过一轮的中间那个排到最前（既不是最早建的，也不是 id 最小的）。
    const client = await TestClient.connect(
      `${wsBase}/api/v1/sessions/${b}/stream`,
    );
    clients.push(client);
    await client.command("send_message", { text: "hi" });
    await waitFor(() => client.types().includes("run.ended"), "结束");
    expect((await list())[0]?.id).toBe(b);

    await call("PATCH", `/sessions/${a}`, { title: "Alpha 登录" });
    await call("PATCH", `/sessions/${b}`, { title: "Beta 支付" });
    await call("POST", `/sessions/${b}/archive`);
    await call("POST", `/sessions/${c}/archive`);

    const set = async (qs: string) => new Set(ids(await list(qs)));
    expect(await set("?status=idle")).toEqual(new Set([a]));
    expect(await set("?status=archived")).toEqual(new Set([b, c]));
    expect(await set("?status=blocked")).toEqual(new Set());
    expect(await set("?q=alpha")).toEqual(new Set([a]));
    expect(await set(`?q=${encodeURIComponent("支付")}`)).toEqual(new Set([b]));
    // 编号 "#0002" 可以用 "2"、"#2"、"0002" 命中。
    expect(await set("?q=2")).toEqual(new Set([b]));
    expect(await set(`?q=${encodeURIComponent("#0003")}`)).toEqual(
      new Set([c]),
    );
    expect(await set("?status=idle&q=alpha")).toEqual(new Set([a]));
    expect((await call("GET", "/sessions?status=bogus")).status).toBe(400);
    // done 已不是会话状态：未知即 400。
    expect((await call("GET", "/sessions?status=done")).status).toBe(400);
  });
});
