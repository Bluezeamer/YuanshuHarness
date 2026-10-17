import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import {
  collector,
  expectContiguous,
  type Frame,
  waitFor,
} from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testPool,
} from "../../test/support/stub.js";
import { PoolError, SessionEntry, type SessionPool } from "./pool.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let pool: SessionPool;
let data: TestData | undefined;
function newPool(factory: ReturnType<typeof stubSessionFactory>) {
  pool?.dispose();
  data?.close();
  const t = testPool(factory);
  pool = t.pool;
  data = t.data;
  return pool;
}
afterEach(() => {
  pool?.dispose();
  data?.close();
  data = undefined;
  stub.mode.delayMs = 0;
  stub.mode.status = 200;
  stub.requests.length = 0;
});

async function open(modelExtra: Record<string, unknown> = {}) {
  newPool(stubSessionFactory(stub, modelExtra));
  const info = await pool.create();
  const entry = pool.get(info.id);
  if (!entry) throw new Error("会话不存在");
  return entry;
}

const typesOf = (frames: Frame[]) => frames.map((f) => f.type);
const finished = (c: ReturnType<typeof collector>) => () =>
  c.types().includes("run.ended");

describe("R4/R5 序号与映射", () => {
  test("一次完整对话：序号连续、映射正确、多订阅者所见逐帧相同", async () => {
    const entry = await open();
    const a = collector();
    const b = collector();
    entry.subscribe(a);
    entry.subscribe(b);
    entry.send("hello");
    await waitFor(finished(a), "run.ended");

    expectContiguous(a.frames);
    expect(a.frames[0]?.seq).toBe(0);
    expect(a.frames[1]?.seq).toBe(1);
    expect(typesOf(a.frames)).toEqual([
      "snapshot",
      "run.started",
      "message.started",
      "message.ended",
      "message.started",
      "message.delta",
      "message.ended",
      "run.ended",
    ]);
    const user = a.frames.find((f) => f.type === "message.ended");
    expect(user?.data).toEqual({ role: "user", text: "hello" });
    expect(a.frames.find((f) => f.type === "message.delta")?.data).toEqual({
      kind: "text",
      text: "reply-1",
    });
    // 事件帧是同一份广播，逐帧相同；快照是各自构造的，时间戳可能差 1ms，故忽略 ts。
    const strip = (fs: Frame[]) => fs.map(({ ts: _ts, ...rest }) => rest);
    expect(strip(b.frames)).toEqual(strip(a.frames));
  });
});

describe("R1 会话隔离", () => {
  test("A 的事件不会出现在 B 的订阅者上", async () => {
    newPool(stubSessionFactory(stub));
    const a = pool.get((await pool.create()).id);
    const b = pool.get((await pool.create()).id);
    if (!a || !b) throw new Error();
    const ca = collector();
    const cb = collector();
    a.subscribe(ca);
    b.subscribe(cb);
    a.send("only-a");
    await waitFor(finished(ca), "A 结束");
    expect(cb.frames).toHaveLength(1); // 只有订阅时的快照
    expect(cb.frames.every((f) => f.session === b.id)).toBe(true);
    expect(ca.frames.every((f) => f.session === a.id)).toBe(true);
  });

  test("池与映射模块不读进程全局状态，也没有模块级可变状态", () => {
    for (const f of ["pool.ts", "events.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).not.toMatch(/process\.(env|cwd|chdir)/);
      expect(src).not.toMatch(/^(let|var) /m);
    }
  });
});

describe("R6 运行失败", () => {
  test("provider 报错：下发 run.failed 再 run.ended，不吞", async () => {
    const entry = await open();
    const c = collector();
    entry.subscribe(c);
    stub.mode.status = 500;
    entry.send("boom");
    await waitFor(finished(c), "run.ended");
    const types = c.types();
    expect(types).toContain("run.failed");
    expect(types.indexOf("run.failed")).toBeLessThan(
      types.indexOf("run.ended"),
    );
    expect(c.frames.find((f) => f.type === "run.failed")?.data.message).toMatch(
      /stub failure|500/,
    );
    expectContiguous(c.frames);
    // 失败后会话仍可用
    stub.mode.status = 200;
    entry.send("again");
    await waitFor(
      () => c.types().filter((t) => t === "run.ended").length === 2,
      "第二次运行结束",
    );
    expect(c.types().filter((t) => t === "run.failed")).toHaveLength(1);
  });
});

describe("R7 快照与衔接", () => {
  test("生成中途加入：首帧是快照，状态正确，其后序号连续", async () => {
    const entry = await open();
    const early = collector();
    entry.subscribe(early);
    stub.mode.delayMs = 300;
    entry.send("slow");
    await waitFor(
      () => early.types().filter((t) => t === "message.started").length === 2,
      "助手消息开始",
    );
    const late = collector();
    entry.subscribe(late);
    const snap = late.frames[0];
    expect(snap?.type).toBe("snapshot");
    expect(snap?.data.running).toBe(true);
    expect(snap?.data.partial).toEqual({ role: "assistant", text: "" });
    expect(snap?.data.messages).toEqual([{ role: "user", text: "slow" }]);
    await waitFor(finished(late), "run.ended");
    expectContiguous(late.frames);
    expect(late.frames[1]?.seq).toBe((snap?.seq ?? 0) + 1);
  });

  test("广播过程中重入订阅：每个新订阅者的快照都恰好对应其 seq", async () => {
    const entry = await open();
    const all: Frame[] = [];
    const joiners: ReturnType<typeof collector>[] = [];
    // 每收到一帧就加入一个新订阅者——在广播进行中重入。
    const host = collector((f) => {
      all.push(f);
      if (f.type !== "snapshot" && joiners.length < 12) {
        const j = collector();
        joiners.push(j);
        entry.subscribe(j);
      }
    });
    entry.subscribe(host);
    entry.send("hi");
    await waitFor(finished(host), "run.ended");

    expect(joiners.length).toBeGreaterThan(3);
    for (const j of joiners) {
      expectContiguous(j.frames);
      const snap = j.frames[0];
      if (!snap) throw new Error();
      // 快照必须等于"事件流推到 snap.seq 时"的状态
      const upTo = all.filter(
        (f) => f.type !== "snapshot" && f.seq <= snap.seq,
      );
      const ended = upTo.filter((f) => f.type === "message.ended");
      expect(snap.data.messages).toEqual(ended.map((f) => f.data));
      const started = upTo.filter((f) => f.type === "run.started").length;
      const stopped = upTo.filter((f) => f.type === "run.ended").length;
      expect(snap.data.running).toBe(started > stopped);
    }
  });

  test("R8 resync：重发快照，后续事件接着编号", async () => {
    const entry = await open();
    const c = collector();
    entry.subscribe(c);
    entry.send("one");
    await waitFor(finished(c), "run.ended");
    const before = c.frames.length;
    entry.resync(c);
    const snap = c.frames[before];
    expect(snap?.type).toBe("snapshot");
    expect(snap?.seq).toBe(c.frames[before - 1]?.seq);
    expect(snap?.data.messages).toHaveLength(2);
    stub.mode.delayMs = 0;
    entry.send("two");
    await waitFor(
      () => c.frames.slice(before).some((f) => f.type === "run.ended"),
      "第二次结束",
    );
    expectContiguous(c.frames.slice(before));
  });
});

describe("R9 发送与排队", () => {
  test("运行中的消息排队、所有订阅者可见，并在当前一步结束后才送达模型", async () => {
    const entry = await open();
    const a = collector();
    const b = collector();
    entry.subscribe(a);
    entry.subscribe(b);
    stub.mode.delayMs = 300;
    entry.send("first");
    await waitFor(
      () => a.types().filter((t) => t === "message.started").length === 2,
      "助手消息开始",
    );
    entry.send("second");
    for (const c of [a, b]) {
      await waitFor(
        () =>
          c.frames.some(
            (f) =>
              f.type === "queue.updated" &&
              JSON.stringify(f.data.queue) === '["second"]',
          ),
        "queue.updated",
      );
    }
    expect(stub.requests).toHaveLength(1); // 此刻第二条还没到模型
    await waitFor(
      () => a.types().filter((t) => t === "run.ended").length === 1,
      "run.ended",
    );
    expect(stub.requests).toHaveLength(2);
    const msgs = (stub.requests[1]?.body.messages ?? []) as Array<{
      role: string;
      content: unknown;
    }>;
    const roles = msgs.filter((m) => m.role !== "system").map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(msgs.at(-1))).toContain("second");
    expect(
      a.frames.at(-2)?.type === "queue.updated" ||
        a.types().includes("queue.updated"),
    ).toBe(true);
    const last = [...a.frames]
      .reverse()
      .find((f) => f.type === "queue.updated");
    expect(last?.data.queue).toEqual([]);
  });

  test("空白文本被拒，且不产生模型请求", async () => {
    const entry = await open();
    expect(() => entry.send("   \n")).toThrow(PoolError);
    expect(() => entry.send("")).toThrow(/不能为空/);
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.requests).toHaveLength(0);
  });

  test("模型不支持图片时拒绝，而不是让 SDK 悄悄丢图", async () => {
    const entry = await open();
    expect(() =>
      entry.send("see", [{ mimeType: "image/png", data: "AAAA" }]),
    ).toThrow(/不支持图片/);
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.requests).toHaveLength(0);
  });

  test("图片随消息到达模型请求", async () => {
    const entry = await open({ input: ["text", "image"] });
    const c = collector();
    entry.subscribe(c);
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    entry.send("see", [{ mimeType: "image/png", data: png }]);
    await waitFor(finished(c), "run.ended");
    expect(JSON.stringify(stub.requests[0]?.body)).toContain(png);
    // 事件与快照不携带图片字节
    expect(JSON.stringify(c.frames)).not.toContain(png);
  });
});

describe("R10 停止", () => {
  test("运行中停止：run.ended aborted，且不算失败；空闲时停止是空操作", async () => {
    const entry = await open();
    const c = collector();
    entry.subscribe(c);
    await entry.stop(); // 空闲
    stub.mode.delayMs = 2000;
    entry.send("long");
    await waitFor(
      () => c.types().filter((t) => t === "message.started").length === 2,
      "助手消息开始",
    );
    await entry.stop();
    await waitFor(finished(c), "run.ended");
    const ended = c.frames.find((f) => f.type === "run.ended");
    expect(ended?.data).toEqual({ aborted: true });
    expect(c.types()).not.toContain("run.failed");
    expect(entry.running).toBe(false);
  });
});

describe("R15 释放", () => {
  test("dispose 后订阅清空、命令被拒、池为空", async () => {
    const entry = await open();
    const c = collector();
    entry.subscribe(c);
    expect(entry.subscriberCount).toBe(1);
    pool.dispose();
    expect(entry.subscriberCount).toBe(0);
    expect(pool.list()).toEqual([]);
    expect(() => entry.send("x")).toThrow(PoolError);
    await expect(pool.create()).rejects.toThrow(PoolError);
  });
});

describe("R16 快照形状与有界", () => {
  test("截断后的快照消息只含 role 与 text，truncated 在 data 顶层", async () => {
    const entry = await open();
    const c = collector();
    entry.subscribe(c);
    // 构造过长的助手回复
    stub.requests.length = 0;
    pool.dispose();
    const big = await startStub(() => "z".repeat(300 * 1024));
    try {
      newPool(stubSessionFactory(big));
      const e = pool.get((await pool.create()).id);
      if (!e) throw new Error();
      const cc = collector();
      e.subscribe(cc);
      e.send("go");
      await waitFor(finished(cc), "run.ended");
      const late = collector();
      e.subscribe(late);
      const snap = late.frames[0];
      expect(snap?.data.truncated).toBe(true);
      for (const m of snap?.data.messages ?? [])
        expect(Object.keys(m).sort()).toEqual(["role", "text"]);
    } finally {
      await big.close();
    }
  });
});

describe("R16 SDK 载荷异常与快照有界", () => {
  // 直接构造 SessionEntry，向它的 SDK 监听器喂事件。
  function fake() {
    let listener: (e: unknown) => void = () => {};
    const session = {
      subscribe: (l: (e: unknown) => void) => {
        listener = l;
        return () => {};
      },
      dispose() {},
    };
    const entry = new SessionEntry(session as never);
    return { entry, emit: (e: unknown) => listener(e) };
  }

  test("会抛错的工具参数不会把异常抛回 SDK，序号不乱，后续事件照常", () => {
    const { entry, emit } = fake();
    const c = collector();
    entry.subscribe(c);
    const args = {};
    Object.defineProperty(args, "x", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    expect(() =>
      emit({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "n",
        args,
      }),
    ).not.toThrow();
    emit({ type: "agent_start" });
    expectContiguous(c.frames);
    expect(c.types()).toContain("tool.started");
    expect(c.types()).toContain("run.started");
  });

  test("mapEvent 自身抛错（消息内容 getter）也不会抛回 SDK", () => {
    const { entry, emit } = fake();
    const c = collector();
    entry.subscribe(c);
    const message = { role: "assistant" };
    Object.defineProperty(message, "content", {
      get() {
        throw new Error("content boom");
      },
    });
    expect(() => emit({ type: "message_start", message })).not.toThrow();
    emit({ type: "agent_start" });
    expect(c.types()).toContain("run.started");
  });

  test("事件线上形状与状态一致：toJSON 改写的 id 在快照里也是同一个", () => {
    const { entry, emit } = fake();
    const c = collector();
    entry.subscribe(c);
    emit({
      type: "tool_execution_start",
      toolCallId: { toJSON: () => "wire-id" },
      toolName: "n",
      args: {},
    });
    const late = collector();
    entry.subscribe(late);
    expect(late.frames[0]?.data.activeTools).toEqual([
      { toolCallId: "wire-id", toolName: "n" },
    ]);
  });

  test("函数/Symbol/对象型 toJSON/超长的工具 id：事件与快照说的是同一件事，不出现 undefined 或 [object Object]", () => {
    const { entry, emit } = fake();
    const c = collector();
    entry.subscribe(c);
    emit({
      type: "tool_execution_start",
      toolCallId: () => 1,
      toolName: "n",
      args: {},
    });
    emit({
      type: "tool_execution_start",
      toolCallId: Symbol("s"),
      toolName: "n",
      args: {},
    });
    emit({
      type: "tool_execution_start",
      toolCallId: { toJSON: () => ({ a: 1 }) },
      toolName: "n",
      args: {},
    });
    emit({
      type: "tool_execution_start",
      toolCallId: "L".repeat(300),
      toolName: "n",
      args: {},
    });
    emit({
      type: "tool_execution_start",
      toolCallId: "ok",
      toolName: "n",
      args: {},
    });
    const late = collector();
    entry.subscribe(late);
    expect(late.frames[0]?.data.activeTools).toEqual([
      { toolCallId: "ok", toolName: "n" },
    ]);
    expect(JSON.stringify(late.frames[0])).not.toMatch(
      /undefined|\[object Object\]/,
    );
  });

  test("活动工具最多登记 100 个", () => {
    const { entry, emit } = fake();
    for (let i = 0; i < 150; i++)
      emit({
        type: "tool_execution_start",
        toolCallId: `t${i}`,
        toolName: "n",
        args: {},
      });
    const c = collector();
    entry.subscribe(c);
    expect(c.frames[0]?.data.activeTools).toHaveLength(100);
  });

  test("转义放大后的最坏快照仍不超过 1 MiB", () => {
    const { entry, emit } = fake();
    for (let i = 0; i < 100; i++)
      emit({
        type: "tool_execution_start",
        toolCallId: `${"\u0000".repeat(250)}${i}`.slice(0, 256),
        toolName: "\u0000".repeat(256),
        args: {},
      });
    emit({
      type: "queue_update",
      steering: Array.from({ length: 100 }, () => "\u0000".repeat(512)),
      followUp: [],
    });
    const c = collector();
    entry.subscribe(c);
    expect(Buffer.byteLength(JSON.stringify(c.frames[0]))).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });

  test("活动工具超大 id/name、过多条目与超长 queue：快照仍然有界且字段齐全", () => {
    const { entry, emit } = fake();
    for (let i = 0; i < 400; i++)
      emit({
        type: "tool_execution_start",
        toolCallId: `${i}-${"i".repeat(300_000)}`,
        toolName: "n".repeat(300_000),
        args: {},
      });
    emit({
      type: "queue_update",
      steering: Array.from({ length: 300 }, () => "q".repeat(9000)),
      followUp: [],
    });
    const c = collector();
    entry.subscribe(c);
    const raw = JSON.stringify(c.frames[0]);
    expect(Buffer.byteLength(raw)).toBeLessThan(1024 * 1024 + 4096);
    const d = c.frames[0]?.data;
    expect(d?.activeTools.length).toBeLessThanOrEqual(200);
    expect(d?.queue.length).toBeLessThanOrEqual(100);
    expect(Array.isArray(d?.queue)).toBe(true);
    expect(Array.isArray(d?.messages)).toBe(true);
  });
});

test("默认背压阈值为 64 MiB", async () => {
  const { DEFAULTS } = await import("../api/sessions.js");
  expect(DEFAULTS.maxBufferedBytes).toBe(64 * 1024 * 1024);
});
