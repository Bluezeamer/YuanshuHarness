import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { testData } from "../../test/support/stub.js";
import { createServer, type YuanshuServer } from "../server.js";
import { CallStore } from "../store/calls.js";

// 审计 v2 的三个接口：calls 的 segment / range / snapshot、compactions 列表、messages 的压缩锚点。
// 数据在服务启动前铺好：calls 用 CallStore 按受控时间写入，JSONL 手写（含一条真实形状的压缩条目）。

const SESSION = "01a14000-0000-7000-8000-0000000000bb";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
type Raw = Record<string, unknown>;
const text = (t: string) => [{ type: "text", text: t }];
const U1 = { role: "user", content: text("一") };
const A1 = { role: "assistant", content: text("答一") };
const U2 = { role: "user", content: text("二") };
const A2 = { role: "assistant", content: text("答二") };
const U3 = { role: "user", content: text("三") };
const A3 = { role: "assistant", content: text("答三") };
// 第三次请求的上下文：上一次压缩的摘要 + 保留的消息 + 新的用户消息。
const SUMMARY = { role: "user", content: text("（摘要）") };
const REQ1 = { model: "m", system: "S", messages: [U1] };
const REQ2 = { model: "m", system: "S", messages: [U1, A1, U2] };
const REQ3 = { model: "m", system: "S", messages: [SUMMARY, U2, A2, U3] };

let server: YuanshuServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await server?.stop().catch(() => {});
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 会话 JSONL 里一条消息条目；message 用原始对象（含 timestamp）。
const msg = (id: string, parentId: string | null, at: number, m: Raw): Raw => ({
  type: "message",
  id,
  parentId,
  timestamp: iso(at),
  message: { ...m, timestamp: at },
});

async function boot(): Promise<string> {
  const data = testData();
  dirs.push(data.dir);
  const calls = new CallStore(data.db);
  data.store.upsert({
    id: SESSION,
    name: "审计二",
    createdAt: iso(T0 - 5000),
    updatedAt: iso(T0 - 5000),
  });
  const record = (
    at: number,
    msgCount: number,
    request: unknown,
    response: unknown,
  ) => {
    vi.setSystemTime(at);
    calls.record({
      sessionId: SESSION,
      runId: `r${msgCount}`,
      trigger: "user",
      toolName: null,
      durationMs: 1,
      tokens: {
        system: 1,
        tools: 0,
        history: 0,
        current: 1,
        out: 1,
        cacheRead: 0,
        cacheWrite: 0,
        estimated: false,
      },
      meta: {
        summary: `s${msgCount}`,
        calledTools: [],
        stopReason: "stop",
        model: "m",
        window: null,
      },
      msgCount,
      requestJson: JSON.stringify(request),
      responseJson: JSON.stringify(response),
    });
  };
  vi.useFakeTimers();
  try {
    record(T0, 1, REQ1, { content: text("答一"), stopReason: "stop" });
    record(T0 + 1000, 3, REQ2, { content: text("答二"), stopReason: "stop" });
    record(T0 + 3000, 4, REQ3, { content: text("答三"), stopReason: "stop" });
  } finally {
    vi.useRealTimers();
  }
  const entries: Raw[] = [
    msg("m1", null, T0, U1),
    msg("m2", "m1", T0 + 1, A1),
    msg("m3", "m2", T0 + 1000, U2),
    msg("m4", "m3", T0 + 1001, A2),
    {
      type: "compaction",
      id: "c1",
      parentId: "m4",
      timestamp: iso(T0 + 2000),
      summary: "摘要一",
      tokensBefore: 1234,
      firstKeptEntryId: "m3",
      systemMessage: { role: "system", content: "S", timestamp: T0 + 2000 },
    },
    msg("m5", "c1", T0 + 3000, U3),
    msg("m6", "m5", T0 + 3001, A3),
  ];
  writeFileSync(
    path.join(data.sessionDir, `2026-01-01T00-00-00-000Z_${SESSION}.jsonl`),
    `${[
      {
        type: "session",
        version: 3,
        id: SESSION,
        timestamp: iso(T0 - 5000),
        cwd: "/work",
      },
      ...entries,
    ]
      .map((e) => JSON.stringify(e))
      .join("\n")}\n`,
  );
  data.close(false);
  mkdirSync(path.join(data.dir, "web"), { recursive: true });
  writeFileSync(path.join(data.dir, "web", "index.html"), "<title>x</title>");
  server = createServer(
    { host: "127.0.0.1", port: 0, dataDir: data.dir, allowCidrs: [] },
    { webRoot: path.join(data.dir, "web"), logStream: { write() {} } },
  );
  const addr = await server.start();
  return `http://127.0.0.1:${addr.port}`;
}

const get = (http: string, p: string) => fetch(`${http}/api/v1/sessions${p}`);

test("calls：带 msgCount 与压缩段；详情按段回放最新请求或压缩前快照", async () => {
  const http = await boot();
  const page = (await (await get(http, `/${SESSION}/calls`)).json()) as {
    calls: Array<Record<string, unknown>>;
  };
  // 时间：call1 < call2 < 压缩1 < call3 → call1/call2 归第一次压缩段，call3 在当前段。
  expect(page.calls.map((c) => [c.seq, c.msgCount, c.segment])).toEqual([
    [3, 4, 0],
    [2, 3, 1],
    [1, 1, 1],
  ]);
  const idOf = new Map(page.calls.map((c) => [c.seq, c.id]));
  const detail = async (seq: number) =>
    (await (
      await get(http, `/${SESSION}/calls/${idOf.get(seq)}`)
    ).json()) as Record<string, unknown>;

  // 当前段：request 是该会话最新一次请求体；最后一次调用的区间可以等于起点。
  const third = await detail(3);
  expect(third).toMatchObject({ segment: 0, snapshot: false, msgCount: 4 });
  expect(third.request).toEqual(REQ3);
  expect(third.range).toEqual({ from: 4, to: 4 });

  // 压缩段：request 是从 JSONL 的压缩条目重建的压缩前快照（原始消息对象 + 条目的 system）。
  const first = await detail(1);
  expect(first).toMatchObject({ segment: 1, snapshot: true, msgCount: 1 });
  expect(first.request).toEqual({
    system: "S",
    messages: [U1, A1, U2, A2].map((m, i) => ({
      ...m,
      timestamp: [T0, T0 + 1, T0 + 1000, T0 + 1001][i],
    })),
  });
  // 区间：本次调用 msgCount → 同段下一次调用的 msgCount；段内最后一次到快照消息数。
  expect(first.range).toEqual({ from: 1, to: 3 });
  const second = await detail(2);
  expect(second).toMatchObject({ segment: 1, snapshot: true });
  expect(second.range).toEqual({ from: 3, to: 4 });
});

test("compactions：按时间编号，带调用序号范围与快照消息数", async () => {
  const http = await boot();
  const body = (await (await get(http, `/${SESSION}/compactions`)).json()) as {
    compactions: unknown[];
  };
  expect(body.compactions).toEqual([
    {
      seq: 1,
      createdAt: iso(T0 + 2000),
      summary: "摘要一",
      tokensBefore: 1234,
      callSeqFrom: 1,
      callSeqTo: 2,
      messageCount: 4,
    },
  ]);
  expect((await get(http, "/nope/compactions")).status).toBe(404);
});

test("messages：压缩锚点给出 afterIndex，原有投影不变", async () => {
  const http = await boot();
  const body = (await (await get(http, `/${SESSION}/messages`)).json()) as {
    messages: Array<{ role: string; text: string }>;
    nextBefore: string | null;
    compactions: unknown[];
  };
  expect(body.messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "一"],
    ["assistant", "答一"],
    ["user", "二"],
    ["assistant", "答二"],
    ["user", "三"],
    ["assistant", "答三"],
  ]);
  expect(body.nextBefore).toBeNull();
  expect(body.compactions).toEqual([
    {
      afterIndex: 4,
      seq: 1,
      summary: "摘要一",
      tokensBefore: 1234,
      createdAt: iso(T0 + 2000),
    },
  ]);
});
