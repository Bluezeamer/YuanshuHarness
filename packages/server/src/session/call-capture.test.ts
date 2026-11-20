import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
  testPresets,
} from "../../test/support/stub.js";
import {
  BRIEF,
  spawnChild,
  subagentWorld,
  type World,
} from "../../test/support/subagents.js";
import { CallStore, type CallTiming, type NewCall } from "../store/calls.js";
import { callCaptureExtension } from "./call-capture.js";
import { splitTokens } from "./call-tokens.js";

const ASK_TOOL = "请读文件";
type Msg = { role: string; content?: unknown };
const textOf = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));

// 子（首条用户消息带开场说明）先交付，再回一句话。
// 用户消息含 ASK_TOOL 时发起一次工具调用，工具返回后的那次请求回「父收尾」。
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Msg[];
  if (msgs.some((m) => m.role === "user" && textOf(m.content).includes(BRIEF)))
    return msgs.at(-1)?.role === "tool"
      ? "子的答复"
      : { tool: "deliver", args: { summary: "交付" } };
  const last = msgs[msgs.length - 1];
  if (last?.role === "user" && textOf(last.content).includes(ASK_TOOL))
    return { tool: "read_file", args: { path: "a.ts" } };
  if (last?.role !== "tool") return `reply-${stub.requests.length}`;
  return "父收尾";
});
afterAll(() => stub.close());

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  stub.requests.length = 0;
});

function setup() {
  let calls: CallStore | undefined;
  const w = subagentWorld(stub, {
    deps: (data) => {
      calls = new CallStore(data.db);
      return { calls };
    },
  });
  cleanups.push(() => void w.close());
  return { ...w, calls: calls as CallStore, w };
}

const runs = async (
  x: ReturnType<typeof setup>,
  texts: string[],
): Promise<string> => {
  const entry = x.pool.get((await x.pool.create()).id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c);
  for (const [i, text] of texts.entries()) {
    entry.send(text);
    await waitFor(
      () => c.types().filter((t) => t === "run.ended").length > i,
      "run.ended",
    );
  }
  return entry.id;
};

const record = (sessionId: string, i: number): NewCall => ({
  sessionId,
  runId: null,
  trigger: "user",
  toolName: null,
  durationMs: 1,
  tokens: {
    system: 1,
    tools: 0,
    history: 0,
    current: 0,
    out: 1,
    cacheRead: 0,
    cacheWrite: 0,
    estimated: false,
  },
  meta: {
    summary: `s${i}`,
    calledTools: [],
    stopReason: "stop",
    model: "m",
    window: null,
  },
  msgCount: i,
  requestJson: "{}",
  responseJson: "{}",
});

// 按 seq 顺序取每条调用落库的服务端计时（列表 API 不暴露 timing，这里直接读 meta_json）。
const timingsOf = (
  x: ReturnType<typeof setup>,
  sessionId: string,
): Array<CallTiming | undefined> =>
  (
    x.data.db
      .prepare("SELECT meta_json FROM calls WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { meta_json: string }[]
  ).map((r) => (JSON.parse(r.meta_json) as { timing?: CallTiming }).timing);

describe("捕获", () => {
  test("每次调用落一条；只留最新 request，列表带请求里的对话项数", async () => {
    const x = setup();
    const id = await runs(x, ["你好", "再来一次"]);
    const { calls } = x.calls.list(id);
    expect(calls.map((c) => c.seq)).toEqual([2, 1]);
    expect(stub.requests).toHaveLength(2);
    // request 不再逐次存：该会话只留最新一次；对话项数按每次请求的内容落库。
    expect(JSON.stringify(x.calls.latestRequest(id))).toBe(
      JSON.stringify(stub.requests[1]?.body),
    );
    const countOf = (body: Record<string, unknown> | undefined) =>
      ((body?.messages ?? []) as Msg[]).filter(
        (m) => m.role !== "system" && m.role !== "developer",
      ).length;
    expect(calls.map((c) => c.msgCount)).toEqual([
      countOf(stub.requests[1]?.body),
      countOf(stub.requests[0]?.body),
    ]);
    const first = x.calls.get(id, calls[1]?.id ?? "");
    expect(first).toMatchObject({
      sessionId: id,
      trigger: "user",
      toolName: null,
      summary: "你好",
      turn: 1,
      stopReason: "stop",
      calledTools: [],
      response: {
        stopReason: "stop",
        content: [{ type: "text", text: "reply-1" }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(calls[0]?.turn).toBe(2);
    expect(calls[0]?.runId).not.toBe(calls[1]?.runId);
    // 供应商上报 input=10：四段之和对得上，不是估算。
    const t = first?.tokens;
    expect(
      (t?.system ?? 0) +
        (t?.tools ?? 0) +
        (t?.history ?? 0) +
        (t?.current ?? 0),
    ).toBe(10);
    expect(t).toMatchObject({ out: 5, estimated: false });
    expect(x.calls.usage(id)).toMatchObject({
      turns: 2,
      steps: 2,
      tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
      cacheHitRate: 0,
      // 没有工具执行：工具耗时是实测的 0；TTFT 每次调用都测到。
      toolMs: 0,
      ttftMs: expect.any(Number),
    });
  });

  test("一轮里多次模型请求各记一条：工具返回触发的带工具名，请求累积含此前全部消息", async () => {
    const x = setup();
    const id = await runs(x, [`${ASK_TOOL} a.ts`]);
    expect(stub.requests).toHaveLength(2);
    const [second, first] = x.calls.list(id).calls;
    if (!first || !second) throw new Error("应有两条调用记录");
    // 同一轮（同一个 run），按先后各一条
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect([first.turn, second.turn]).toEqual([1, 1]);
    expect(second.runId).toBe(first.runId);
    // 五档筛选依赖的字段：触发类型、来源工具、响应里发起的工具
    expect(first).toMatchObject({
      trigger: "user",
      toolName: null,
      calledTools: ["read_file"],
      stopReason: "toolUse",
    });
    expect(second).toMatchObject({
      trigger: "tool_result",
      toolName: "read_file",
      calledTools: [],
      stopReason: "stop",
    });
    const rec2 = x.calls.get(id, second.id);
    expect(rec2?.response).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "父收尾" }],
    });
    const rec1 = x.calls.get(id, first.id);
    expect(rec1?.response).toMatchObject({
      stopReason: "toolUse",
      content: [
        expect.objectContaining({ type: "toolCall", name: "read_file" }),
      ],
    });
    // 第二次请求的对话项包含第一次的全部内容，末尾是工具结果；
    // 最新请求就是第二次请求，msgCount 与它一致。
    const last = x.calls.latestRequest(id) as { messages?: Msg[] };
    const lastMsgs = (last.messages ?? []).filter(
      (m) => m.role !== "system" && m.role !== "developer",
    );
    expect(second.msgCount).toBeGreaterThan(first.msgCount);
    expect(lastMsgs).toHaveLength(second.msgCount);
    expect(lastMsgs.at(-1)?.role).toBe("tool");
    // 计时：第一次调用之前没有工具，toolMs 为实测的 0；read_file 的执行耗时在下一次调用前
    // 才结束，归到第二次调用记录。第一次只发起工具调用、没有文本 / 思考增量，故没有 TTFT；
    // 第二次是文本回复，测到了 TTFT。
    const timing = timingsOf(x, id);
    expect(timing[0]?.toolMs).toBe(0);
    expect(timing[1]?.toolMs).toEqual(expect.any(Number));
    expect(timing[0]?.ttftMs).toBeUndefined();
    expect(timing[1]?.ttftMs).toEqual(expect.any(Number));
    expect(x.calls.usage(id).toolMs).toEqual(expect.any(Number));
  });

  test("TTFT 从发请求计到第一个非空流式增量：桩的延迟会计入", async () => {
    const x = setup();
    stub.mode.delayMs = 40;
    try {
      const id = await runs(x, ["慢一点"]);
      const [timing] = timingsOf(x, id);
      expect(timing?.ttftMs).toBeGreaterThanOrEqual(30);
      expect(timing?.toolMs).toBe(0);
    } finally {
      stub.mode.delayMs = 0;
    }
  });

  test("计时按事件测量：工具耗时累计并归到下一次调用记录", () => {
    const data = testData();
    cleanups.push(() => data.close(true));
    const store = new CallStore(data.db);
    type Handler = (e: never, ctx: never) => unknown;
    const handlers = new Map<string, Handler>();
    const pi = {
      on(ev: string, h: Handler) {
        handlers.set(ev, h);
        return () => {};
      },
    };
    callCaptureExtension({
      store,
      sessionId: "s",
      subagent: false,
      runId: () => null,
    })(pi as never);
    const fire = (ev: string, e: unknown, ctx: unknown = {}) =>
      handlers.get(ev)?.(e as never, ctx as never);
    const answer = (text: string) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      model: "m",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    // 第 1 次调用：请求 → 首个非空增量 → 消息结束。
    fire(
      "before_provider_request",
      { payload: {} },
      { model: { contextWindow: 1000 } },
    );
    fire("message_update", {
      assistantMessageEvent: { type: "text_delta", delta: "你" },
    });
    fire("message_end", { message: answer("你好") });
    // 调用结束到下一次请求之间执行了一个工具，耗时 120ms。
    fire("tool_execution_end", { durationMs: 120 });
    // 第 2 次调用：这次记录带上上一批工具的执行耗时。
    fire("before_provider_request", { payload: {} });
    fire("message_update", {
      assistantMessageEvent: { type: "text_delta", delta: "好" },
    });
    fire("message_end", { message: answer("好") });
    const timing = (
      data.db
        .prepare(
          "SELECT meta_json FROM calls WHERE session_id = ? ORDER BY seq",
        )
        .all("s") as { meta_json: string }[]
    ).map((r) => (JSON.parse(r.meta_json) as { timing?: CallTiming }).timing);
    expect(timing).toHaveLength(2);
    expect(timing[0]?.toolMs).toBe(0);
    expect(timing[1]?.toolMs).toBe(120);
    expect(timing[0]?.ttftMs).toEqual(expect.any(Number));
    expect(timing[1]?.ttftMs).toEqual(expect.any(Number));
    expect(store.usage("s").toolMs).toBe(120);
  });

  test("子代理会话的调用记在子会话下，触发为 subagent", async () => {
    const x = setup();
    const parent = await runs(x, ["去问子代理"]);
    // 父 stub 第一轮直接文本；手动派发一个子，再等它完成。
    const r = await spawnChild(x.w, parent, { task: "读文件并返回暗号" });
    await waitFor(() => x.subagents.get(r.childId)?.state === "done", "子完成");
    const child = x.calls.list(r.childId).calls;
    // 两次调用：交付，再收尾（列表最新在前）
    expect(child).toHaveLength(2);
    expect(child.every((c) => c.trigger === "subagent")).toBe(true);
    expect(child[0]).toMatchObject({ trigger: "subagent", toolName: null });
    expect(x.calls.get(parent, child[0]?.id ?? "")).toBeNull();
    expect(x.calls.get(r.childId, child[0]?.id ?? "")?.response).toMatchObject({
      content: [{ type: "text", text: "子的答复" }],
    });
    // 父会话自己的调用里没有子的那条。
    expect(
      x.calls.list(parent).calls.every((c) => c.trigger !== "subagent"),
    ).toBe(true);
  });
});

describe("存储", () => {
  test("response 与 latest_request 压缩往返无损（含中文、emoji、转义），且确实压缩了", () => {
    const data = testData();
    cleanups.push(() => data.close(true));
    const store = new CallStore(data.db);
    const req = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: '重复内容 😀 "q" \n\t'.repeat(500) }],
    });
    const res = JSON.stringify({
      content: [{ type: "text", text: '答 复 😀 "r" \n\t'.repeat(500) }],
    });
    const id = store.record({
      ...record("s", 0),
      requestJson: req,
      responseJson: res,
    });
    const rec = store.get("s", id);
    expect(JSON.stringify(rec?.response)).toBe(res);
    expect(JSON.stringify(store.latestRequest("s"))).toBe(req);
    const response = data.db
      .prepare("SELECT length(response_z) AS n FROM calls WHERE id = ?")
      .get(id) as { n: number };
    expect(response.n).toBeLessThan(res.length / 10);
    const request = data.db
      .prepare(
        "SELECT length(request_z) AS n FROM latest_request WHERE session_id = ?",
      )
      .get("s") as { n: number };
    expect(request.n).toBeLessThan(req.length / 10);
  });

  test("latest_request 只留最新一次；删会话时一并清掉", () => {
    const data = testData();
    cleanups.push(() => data.close(true));
    const store = new CallStore(data.db);
    store.record({
      ...record("s", 0),
      requestJson: JSON.stringify({
        messages: [{ role: "user", content: "a" }],
      }),
    });
    store.record({
      ...record("s", 1),
      requestJson: JSON.stringify({
        messages: [{ role: "user", content: "b" }],
      }),
    });
    expect(store.latestRequest("s")).toEqual({
      messages: [{ role: "user", content: "b" }],
    });
    const count = () =>
      (
        data.db
          .prepare(
            "SELECT COUNT(*) AS n FROM latest_request WHERE session_id = ?",
          )
          .get("s") as { n: number }
      ).n;
    expect(count()).toBe(1);
    store.removeSession("s");
    expect(count()).toBe(0);
    expect(store.latestRequest("s")).toBeNull();
  });

  test("倒序分页与游标；不属于该会话的 call 取不到", () => {
    const data = testData();
    cleanups.push(() => data.close(true));
    const store = new CallStore(data.db);
    const ids = [1, 2, 3, 4, 5].map((i) => store.record(record("s", i)));
    store.record(record("other", 9));
    const seqs = (q: { before?: number; limit?: number }) => {
      const p = store.list("s", q);
      return [p.calls.map((c) => c.seq), p.nextBefore];
    };
    expect(seqs({ limit: 2 })).toEqual([[5, 4], 4]);
    expect(seqs({ before: 4, limit: 2 })).toEqual([[3, 2], 2]);
    expect(seqs({ before: 2, limit: 2 })).toEqual([[1], null]);
    expect(seqs({})).toEqual([[5, 4, 3, 2, 1], null]);
    expect(store.get("other", ids[0] ?? "")).toBeNull();
    expect(store.get("s", "nope")).toBeNull();
  });

  test("用量聚合服务端计时：工具耗时求和、TTFT 平均；缺计时数据返回 null", () => {
    const data = testData();
    cleanups.push(() => data.close(true));
    const store = new CallStore(data.db);
    const add = (sessionId: string, i: number, timing?: CallTiming) =>
      store.record({ ...record(sessionId, i), ...(timing ? { timing } : {}) });
    add("s", 1, { toolMs: 0, ttftMs: 900 });
    add("s", 2, { toolMs: 250.6, ttftMs: 301 });
    expect(store.usage("s")).toMatchObject({ toolMs: 251, ttftMs: 601 });
    // 升级前的旧记录没有 timing：工具总耗时不可知，返回 null 而不是偏小的数；
    // TTFT 仍按测到首 token 的调用取平均。
    add("old", 0);
    expect(store.usage("old")).toMatchObject({ toolMs: null, ttftMs: null });
    add("old", 1, { toolMs: 100, ttftMs: 500 });
    expect(store.usage("old")).toMatchObject({ toolMs: null, ttftMs: 500 });
    // 没测到首 token 的调用（非流式 / 提前失败）不进平均；工具耗时照常累计。
    add("no-ttft", 0, { toolMs: 40 });
    expect(store.usage("no-ttft")).toMatchObject({ toolMs: 40, ttftMs: null });
    // timing 只服务 usage() 聚合，不进调用列表与详情。
    const listed = store.list("s").calls;
    expect(listed).toHaveLength(2);
    for (const c of listed) {
      expect(c).not.toHaveProperty("timing");
      expect(store.get("s", c.id)).not.toHaveProperty("timing");
    }
  });
});

describe("token 拆分", () => {
  const payload = {
    system: "s".repeat(300),
    tools: [{ name: "t", description: "d".repeat(100) }],
    messages: [
      { role: "user", content: "u".repeat(200) },
      { role: "assistant", content: "a".repeat(100) },
      { role: "user", content: "c".repeat(50) },
    ],
  };

  test("上报 input 时四段之和恰好等于 input + 缓存读写，缓存另列", () => {
    const t = splitTokens(
      payload,
      { input: 100, output: 7, cacheRead: 40, cacheWrite: 10 },
      20,
    );
    expect(t.system + t.tools + t.history + t.current).toBe(150);
    expect(t).toMatchObject({
      out: 7,
      cacheRead: 40,
      cacheWrite: 10,
      estimated: false,
    });
    expect(t.system).toBeGreaterThan(t.tools);
    expect(t.history).toBeGreaterThan(t.current);
  });

  test("没有上报用量时按字符估算并标记 estimated", () => {
    const t = splitTokens(
      payload,
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      30,
    );
    expect(t.estimated).toBe(true);
    expect(t.out).toBe(10);
    expect(t.system + t.tools + t.history + t.current).toBeGreaterThan(0);
  });
});
