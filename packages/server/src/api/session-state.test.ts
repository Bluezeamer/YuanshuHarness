import { SessionManager } from "@earendil-works/pi-coding-agent";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import {
  makeEnv,
  openSession,
  type StubReply,
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
  writeModels,
} from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import type { SessionFactory, SessionPool } from "../session/pool.js";
import { CallStore } from "../store/calls.js";
import type { Goal } from "../store/session-state.js";
import { SessionStateStore } from "../store/session-state.js";
import { DEFAULTS, sessionsApi } from "./sessions.js";

// 下一次模型请求要“决定”的回复；工具结果回来后的那一轮一律回文本，避免循环调用。
const script: StubReply[] = [];
const stub = await startStub((n, body) => {
  const msgs = (body.messages ?? []) as { role: string }[];
  if (msgs.at(-1)?.role === "tool") return "done";
  return script.shift() ?? `reply-${n}`;
});
afterAll(() => stub.close());

// 压缩要求会话里有可压缩的历史：把保留窗口收到最小。
const compactFactory = (): SessionFactory => async (o) => {
  const env = { ...makeEnv(), cwd: o.cwd };
  writeModels(env, stub.url);
  const manager = o.file
    ? SessionManager.open(o.file, o.sessionDir, o.cwd)
    : SessionManager.create(o.cwd, o.sessionDir, { id: o.id });
  const { session } = await openSession(env, {
    sessionManager: manager,
    retry: false,
    compaction: { keepRecentTokens: 1, reserveTokens: 1 },
    loader: { extensionFactories: o.extensions },
  });
  return session;
};

let app: FastifyInstance | undefined;
let pool: SessionPool | undefined;
let data: TestData | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  stub.mode.delayMs = 0;
  stub.requests.length = 0;
  script.length = 0;
  await app?.close();
  pool?.dispose();
  data?.close();
  app = undefined;
  pool = undefined;
  data = undefined;
});

async function boot(factory: SessionFactory = stubSessionFactory(stub)) {
  data = testData();
  pool = testPool(factory, data, {
    calls: new CallStore(data.db),
    states: new SessionStateStore(data.db),
  }).pool;
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: DEFAULTS.maxPayloadBytes },
    errorHandler: () => {},
  });
  await app.register(sessionsApi, { ...DEFAULTS, pool });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const http = `http://127.0.0.1:${port}`;
  const res = await fetch(`${http}/api/v1/sessions`, { method: "POST" });
  const { id } = (await res.json()) as { id: string };
  const connect = async () => {
    const c = await TestClient.connect(
      `ws://127.0.0.1:${port}/api/v1/sessions/${id}/stream`,
    );
    clients.push(c);
    await waitFor(() => c.frames.length > 0, "快照");
    return c;
  };
  const state = async () =>
    (await (await fetch(`${http}/api/v1/sessions/${id}/state`)).json()) as {
      goal: Record<string, unknown> | null;
      todo: { content: string; status: string }[];
      compact: { summary: string; at: string; savedPct: number } | null;
    };
  return { http, id, connect, state };
}

const count = (c: TestClient, type: string) =>
  c.frames.filter((f) => f.type === type).length;
const last = (c: TestClient, type: string) =>
  c.frames.filter((f) => f.type === type).at(-1);
const ended =
  (c: TestClient, n = 1) =>
  () =>
    count(c, "run.ended") >= n;

// 某次模型请求里的系统提示（OpenAI 兼容请求的第一条 system 消息）。
const systemOf = (body: Record<string, unknown> | undefined): string => {
  const messages = (body?.messages ?? []) as {
    role: string;
    content: unknown;
  }[];
  const sys = messages.find(
    (m) => m.role === "system" || m.role === "developer",
  );
  return typeof sys?.content === "string"
    ? sys.content
    : JSON.stringify(sys?.content);
};
describe("goal 命令", () => {
  // 目标卡片的帧（kind: goal）
  const cards = (c: TestClient) =>
    c.frames.filter((f) => f.type === "notice" && f.data.kind === "goal");
  const goalOf = (c: TestClient) => last(c, "goal.updated")?.data.goal;

  test("设置、编辑、暂停、恢复、清除：逐条 ack，每次变更都广播并出一张卡片", async () => {
    const { connect } = await boot();
    const a = await connect();
    const b = await connect();

    expect(
      await a.command("set_goal", { text: "  把测试跑绿  " }),
    ).toMatchObject({ ok: true });
    await waitFor(() => goalOf(b)?.state === "active", "b 收到设置");
    const set = goalOf(b);
    expect(set).toMatchObject({
      text: "把测试跑绿",
      by: "user",
      state: "active",
      maxRounds: 50,
    });
    expect(typeof set.id).toBe("string");
    expect(typeof set.since).toBe("string");
    await waitFor(() => cards(b).length >= 1, "set 卡片");
    expect(cards(b)[0]?.data.goal).toMatchObject({ event: "set", by: "user" });
    // 进行中的目标不能点继续
    expect(await a.command("resume_goal")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });

    // 已有未完成的目标时再立一个：冲突，错误指向改或清除
    expect(await a.command("set_goal", { text: "另一个" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });

    const rev = goalOf(b)?.revision as number;
    expect(
      await b.command("edit_goal", { text: "把测试和类型检查跑绿" }),
    ).toMatchObject({ ok: true });
    await waitFor(
      () => goalOf(a)?.text === "把测试和类型检查跑绿",
      "a 收到编辑",
    );
    expect(goalOf(a)?.revision).toBeGreaterThan(rev);
    expect(goalOf(a)).toMatchObject({ since: set.since, id: set.id });

    expect(await a.command("edit_goal", { maxRounds: null })).toMatchObject({
      ok: true,
    });
    expect(goalOf(b)?.maxRounds).toBeNull();
    // 等目标轮自己跑完（无人干预时连续三轮没有工具调用就会被判受阻）
    await waitFor(() => goalOf(b)?.state === "blocked", "受阻", 10_000);
    await waitFor(
      () => cards(b).some((f) => f.data.goal.event === "blocked"),
      "blocked 卡片",
    );
    expect(goalOf(b)?.reason).toEqual({ code: "no-tool-calls" });

    // 继续：状态回到 active，原因清掉（紧接着就会续跑，轮数很快又变成 1）
    const beforeResume = goalOf(b)?.revision as number;
    expect(await a.command("resume_goal")).toMatchObject({ ok: true });
    expect(goalOf(b)?.revision).toBeGreaterThan(beforeResume);
    expect(goalOf(b)?.state).toBe("active");
    expect(goalOf(b)?.reason).toBeUndefined();
    await waitFor(
      () => cards(b).some((f) => f.data.goal.event === "resumed"),
      "resumed 卡片",
    );

    // 暂停后停止 bot 的自动续跑；再暂停一次不重复出卡片
    expect(await a.command("pause_goal")).toMatchObject({ ok: true });
    expect(goalOf(b)?.state).toBe("paused");
    expect(goalOf(b)?.reason).toEqual({ code: "user-paused" });
    const pausedCards = cards(b).filter(
      (f) => f.data.goal.event === "paused",
    ).length;
    expect(pausedCards).toBe(1);
    expect(await a.command("pause_goal")).toMatchObject({ ok: true });
    expect(cards(b).filter((f) => f.data.goal.event === "paused")).toHaveLength(
      1,
    );

    expect(await a.command("clear_goal")).toMatchObject({ ok: true });
    expect(goalOf(b)).toBeNull();
    expect(cards(b).at(-1)?.data.goal.event).toBe("cleared");
    // 清除后再清除：空操作
    expect(await a.command("clear_goal")).toMatchObject({ ok: true });
  }, 20_000);

  test("非法输入逐项失败 ack，连接仍可用", async () => {
    const { connect } = await boot();
    const c = await connect();
    expect(await c.command("edit_goal", { text: "x" })).toMatchObject({
      ok: false,
      error: { code: "no_goal" },
    });
    expect(await c.command("pause_goal")).toMatchObject({
      ok: false,
      error: { code: "no_goal" },
    });
    expect(await c.command("resume_goal")).toMatchObject({
      ok: false,
      error: { code: "no_goal" },
    });
    expect(await c.command("set_goal", { text: "   " })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await c.command("set_goal", {})).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(
      await c.command("set_goal", { text: "x".repeat(4001) }),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await c.command("set_goal", { text: "ok" })).toMatchObject({
      ok: true,
    });
    expect(await c.command("edit_goal", {})).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await c.command("edit_goal", { maxRounds: 0 })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    // 立目标会立刻开第一轮（用户设完目标就续跑）：等这些轮次跑完，目标自己受阻
    await waitFor(() => goalOf(c)?.state === "blocked", "目标轮跑完", 10_000);
    const before = goalOf(c)?.revision as number;
    // blocked 的目标可以继续（轮数归零）
    expect(await c.command("resume_goal")).toMatchObject({ ok: true });
    expect(goalOf(c)?.revision).toBeGreaterThan(before);
    expect(goalOf(c)?.state).toBe("active");
    // active 不能再继续
    expect(await c.command("resume_goal")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  test("快照与 GET /state 带新形状的 goal；目标文本不进系统提示", async () => {
    const { connect, state } = await boot();
    const a = await connect();
    await a.command("set_goal", { text: "GOAL-MARK-1" });
    // 没有工具调用的目标轮：连续三轮后由 harness 判定受阻
    await waitFor(
      () => last(a, "goal.updated")?.data.goal.state === "blocked",
      "受阻",
      10_000,
    );
    const g = last(a, "goal.updated")?.data.goal;
    expect(g).toMatchObject({
      state: "blocked",
      rounds: 3,
      reason: { code: "no-tool-calls" },
    });

    const b = await connect();
    expect(b.frames[0]?.type).toBe("snapshot");
    expect(b.frames[0]?.data.goal).toMatchObject({
      text: "GOAL-MARK-1",
      state: "blocked",
    });
    expect(b.frames[0]?.data.todos).toEqual([]);
    expect(b.frames[0]?.data.compact).toBeNull();
    expect(await state()).toMatchObject({
      goal: { text: "GOAL-MARK-1", state: "blocked" },
      todo: [],
      compact: null,
    });

    // 三轮注入 + 一条收尾消息；目标文本只出现在注入消息里，系统提示里没有
    const bodies = stub.requests.map((r) => JSON.stringify(r.body));
    expect(
      bodies.filter((s) => s.includes("[Goal round ")).length,
    ).toBeGreaterThanOrEqual(3);
    expect(bodies.at(-1)).toContain("made no tool calls");
    for (const r of stub.requests) {
      expect(systemOf(r.body)).not.toContain("GOAL-MARK-1");
    }
    // 卡片：set + 每轮一张 round + 1 张 blocked 收尾，没有多余的
    expect(cards(a).map((f) => f.data.goal.event)).toEqual([
      "set",
      "round",
      "round",
      "round",
      "blocked",
    ]);
  });

  test("目标落库：换一个池（同一数据库）加载会话后 active 变成 paused", async () => {
    const { connect, id } = await boot();
    const a = await connect();
    await a.command("send_message", { text: "hi" });
    await waitFor(ended(a), "结束");
    await a.command("set_goal", { text: "持久目标" });
    await waitFor(() => goalOf(a)?.state !== null, "设置完成");
    // 停掉第一个池（重启），否则它还会继续续跑并改写库里的状态
    a.close();
    pool?.dispose();
    await app?.close();
    pool = undefined;
    app = undefined;

    // 库里留着当时的目标，重启前它是 active
    const store = new SessionStateStore((data as TestData).db);
    const before = store.get(id).goal;
    expect(before?.text).toBe("持久目标");
    store.save(id, {
      ...store.get(id),
      goal: { ...(before as Goal), state: "active", rounds: 0 },
    });

    const second = testPool(stubSessionFactory(stub), data, {
      states: store,
    }).pool;
    try {
      expect(second.stateOf(id).goal?.text).toBe("持久目标");
      expect(second.stateOf(id).goal?.state).toBe("active");
      const entry = await second.acquire(id);
      expect(entry?.state.goal).toMatchObject({
        text: "持久目标",
        state: "paused",
        reason: { code: "server-restart" },
      });
    } finally {
      second.dispose();
    }
  });
});

describe("plan / todo_write", () => {
  test("模型调用 todo_write：落库、广播 plan.updated、快照与 /state 带上", async () => {
    const { connect, state } = await boot();
    const a = await connect();
    const b = await connect();
    script.push({
      tool: "todo_write",
      args: {
        todos: [
          { content: "读代码", status: "completed" },
          { content: "写实现", status: "in_progress" },
          { content: "补测试", status: "pending" },
        ],
      },
    });
    await a.command("send_message", { text: "开始" });
    await waitFor(ended(a), "结束");

    const plan = last(b, "plan.updated");
    expect(plan?.data.todos).toEqual([
      { content: "读代码", status: "completed" },
      { content: "写实现", status: "in_progress" },
      { content: "补测试", status: "pending" },
    ]);
    // 工具调用本身走正常事件，且不需要审批
    expect(a.frames.find((f) => f.type === "tool.ended")?.data).toMatchObject({
      toolName: "todo_write",
      isError: false,
    });
    expect(a.types()).not.toContain("prompt.requested");

    expect((await state()).todo).toHaveLength(3);
    const c = await connect();
    expect(c.frames[0]?.data.todos).toHaveLength(3);
  });

  test("参数无效时工具报错、清单不变", async () => {
    const { connect, state } = await boot();
    const a = await connect();
    script.push({
      tool: "todo_write",
      args: { todos: [{ content: "x", status: "bogus" }] },
    });
    await a.command("send_message", { text: "开始" });
    await waitFor(ended(a), "结束");
    expect(count(a, "plan.updated")).toBe(0);
    expect((await state()).todo).toEqual([]);
  });
});

describe("compact", () => {
  test("成功：写 compact 状态、广播 context.compacted，快照与 /state 带上", async () => {
    const { connect, state } = await boot(compactFactory());
    const a = await connect();
    const b = await connect();
    for (const [i, t] of ["alpha", "beta", "gamma"].entries()) {
      await a.command("send_message", { text: t });
      await waitFor(ended(a, i + 1), `第 ${i + 1} 轮`);
    }

    expect(await a.command("compact")).toMatchObject({ ok: true });
    await waitFor(() => count(b, "context.compacted") === 1, "压缩完成");
    const ev = last(b, "context.compacted")?.data;
    expect(ev?.summary).toBeTypeOf("string");
    expect(ev?.summary.length).toBeGreaterThan(0);
    expect(ev?.savedPct).toBeGreaterThanOrEqual(0);
    expect(ev?.savedPct).toBeLessThanOrEqual(100);

    const s = await state();
    expect(s.compact).toMatchObject({
      summary: ev?.summary,
      savedPct: ev?.savedPct,
    });
    expect(typeof s.compact?.at).toBe("string");
    const c = await connect();
    expect(c.frames[0]?.data.compact).toMatchObject({ summary: ev?.summary });
  });

  test("运行中拒绝：ack 报 session_running，不发起压缩", async () => {
    const { connect } = await boot(compactFactory());
    const a = await connect();
    stub.mode.delayMs = 2000;
    await a.command("send_message", { text: "long" });
    await waitFor(() => count(a, "run.started") === 1, "开始运行");
    expect(await a.command("compact")).toMatchObject({
      ok: false,
      error: { code: "session_running" },
    });
    await a.command("stop");
    await waitFor(ended(a), "结束");
    expect(count(a, "context.compacted")).toBe(0);
  });

  test("会话太小压不动：广播 context.compact_failed，之后仍可发送", async () => {
    // 默认保留窗口远大于一两句话：SDK 报 Nothing to compact
    const { connect } = await boot();
    const a = await connect();
    await a.command("send_message", { text: "hi" });
    await waitFor(ended(a), "结束");
    expect(await a.command("compact")).toMatchObject({ ok: true });
    await waitFor(() => count(a, "context.compact_failed") === 1, "失败事件");
    expect(last(a, "context.compact_failed")?.data.message).toBeTypeOf(
      "string",
    );
    await a.command("send_message", { text: "again" });
    await waitFor(ended(a, 2), "仍可发送");
  });
});

describe("usage", () => {
  test("run.ended 带本轮用量与计数；快照带累计用量", async () => {
    const { connect } = await boot();
    const a = await connect();
    await a.command("send_message", { text: "one" });
    await waitFor(ended(a, 1), "第一轮");
    const first = last(a, "run.ended")?.data;
    expect(first).toMatchObject({
      aborted: false,
      steps: 1,
      turn: 1,
      usage: { output: 5 },
    });
    // stub 上报 prompt_tokens=10：整次请求输入量 = input + 缓存读写
    expect(first?.usage.input).toBe(10);
    expect(first?.usage.cacheRead).toBe(0);
    expect(first?.usage.cacheWrite).toBe(0);

    await a.command("send_message", { text: "two" });
    await waitFor(ended(a, 2), "第二轮");
    const second = last(a, "run.ended")?.data;
    expect(second).toMatchObject({ steps: 1, turn: 2 });
    // 本轮累计只算本轮，不含上一轮
    expect(second?.usage.output).toBe(5);

    const b = await connect();
    const usage = b.frames[0]?.data.usage;
    expect(usage.turns).toBe(2);
    expect(usage.steps).toBe(2);
    expect(usage.tokens.output).toBe(10);
    expect(usage.context).not.toBeNull();
  });
});

describe("旧命令回归", () => {
  test("send_message / stop / resync / 未知命令的 ack 与事件形状不变", async () => {
    const { connect } = await boot();
    const a = await connect();
    expect(await a.command("send_message", { text: "hi" })).toMatchObject({
      ok: true,
    });
    await waitFor(ended(a), "结束");
    expect(a.types().slice(1, 3)).toEqual(["run.started", "message.started"]);
    expect(await a.command("stop")).toMatchObject({ ok: true });
    expect(await a.command("resync")).toMatchObject({ ok: true });
    expect(await a.command("nope")).toMatchObject({
      ok: false,
      error: { code: "unknown_command" },
    });
    // 旧字段原样存在，新字段只增不删
    const snap = last(a, "snapshot")?.data ?? {};
    for (const k of [
      "messages",
      "startIndex",
      "running",
      "activeTools",
      "partial",
      "queue",
      "prompts",
    ])
      expect(snap).toHaveProperty(k);
  });
});
