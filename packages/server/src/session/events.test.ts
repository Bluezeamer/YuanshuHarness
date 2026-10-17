import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  cut,
  FRAME_DATA_MAX,
  mapEvent,
  messageText,
  sanitizeData,
} from "./events.js";

const ev = (e: unknown) => e as AgentSessionEvent;

describe("mapEvent", () => {
  test("运行起止与排队", () => {
    expect(mapEvent(ev({ type: "agent_start" }))).toEqual({
      type: "run.started",
      data: {},
    });
    expect(mapEvent(ev({ type: "agent_settled", aborted: true }))).toEqual({
      type: "run.ended",
      data: { aborted: true },
    });
    expect(
      mapEvent(ev({ type: "queue_update", steering: ["a"], followUp: ["b"] })),
    ).toEqual({ type: "queue.updated", data: { queue: ["a", "b"] } });
  });

  test("消息只映射 user 与 assistant，system 与 toolResult 不下发", () => {
    const m = (role: string) =>
      mapEvent(ev({ type: "message_start", message: { role, content: "hi" } }));
    expect(m("user")).toEqual({
      type: "message.started",
      data: { role: "user", text: "hi" },
    });
    expect(m("assistant")?.type).toBe("message.started");
    expect(m("system")).toBeNull();
    expect(m("toolResult")).toBeNull();
  });

  test("文本块拼接，思考、图片与工具调用块不进 text", () => {
    expect(
      messageText([
        { type: "text", text: "a" },
        { type: "thinking", thinking: "SECRET" },
        { type: "toolCall", id: "1", name: "t", arguments: {} },
        { type: "image", data: "xx", mimeType: "image/png" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  test("增量：文本与思考下发，其余增量种类不下发", () => {
    const u = (assistantMessageEvent: unknown) =>
      mapEvent(ev({ type: "message_update", assistantMessageEvent }));
    expect(u({ type: "text_delta", delta: "x" })?.data).toEqual({
      kind: "text",
      text: "x",
    });
    expect(u({ type: "thinking_delta", delta: "y" })?.data).toEqual({
      kind: "thinking",
      text: "y",
    });
    expect(u({ type: "text_start" })).toBeNull();
    expect(u({ type: "toolcall_delta" })).toBeNull();
  });

  test("工具事件", () => {
    expect(
      mapEvent(
        ev({
          type: "tool_execution_end",
          toolCallId: "c",
          toolName: "t",
          result: 1,
          isError: false,
        }),
      ),
    ).toEqual({
      type: "tool.ended",
      data: { toolCallId: "c", toolName: "t", result: 1, isError: false },
    });
  });

  test("表外事件不下发", () => {
    for (const type of [
      "turn_start",
      "turn_end",
      "compaction_start",
      "agent_end",
    ])
      expect(mapEvent(ev({ type }))).toBeNull();
  });
});

describe("R16 有界", () => {
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

  test("字符串截断不切开代理对", () => {
    expect(cut("a".repeat(9) + "😀", 10)).toBe("a".repeat(9));
  });

  test("长字符串被截断并在顶层标记", () => {
    const r = sanitizeData({ text: "x".repeat(1000), n: 1 }, 100);
    expect(r).toEqual({ text: "x".repeat(100), n: 1, truncated: true });
  });

  test("按 UTF-8 字节判断：80 万个汉字（UTF-16 长度不大，字节超限）被兜底", () => {
    const r = sanitizeData(
      { toolCallId: "c1", result: Array.from({ length: 800_000 }, () => "汉") },
      100,
    );
    expect(bytes(r)).toBeLessThan(FRAME_DATA_MAX);
    expect(r).toMatchObject({
      toolCallId: "c1",
      omitted: true,
      truncated: true,
    });
    expect(r).not.toHaveProperty("result");
  });

  test("字节而非字符：40 万个汉字的单个字符串（UTF-16 长度未超限，UTF-8 超限）被兜底", () => {
    const r = sanitizeData(
      { toolCallId: "c", text: "汉".repeat(400_000) },
      1_000_000,
    );
    expect(bytes(r)).toBeLessThan(FRAME_DATA_MAX);
    expect(r.omitted).toBe(true);
  });

  test("宽度乘长度：200 个 256KiB 字符串被兜底", () => {
    const r = sanitizeData(
      {
        toolName: "t",
        result: Array.from({ length: 200 }, () => "y".repeat(256 * 1024)),
      },
      256 * 1024,
    );
    expect(bytes(r)).toBeLessThan(FRAME_DATA_MAX);
    expect(r.omitted).toBe(true);
  });

  test("会抛错的载荷不会让调用抛错：getter、toJSON、循环引用、Proxy", () => {
    const getter = { toolCallId: "g" };
    Object.defineProperty(getter, "boom", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const cyc: Record<string, unknown> = { toolCallId: "c" };
    cyc.self = cyc;
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    for (const raw of [
      getter,
      cyc,
      { toolCallId: "p", x: proxy },
      {
        toJSON() {
          throw new Error("t");
        },
      },
    ])
      expect(() => sanitizeData(raw as never, 100)).not.toThrow();
    expect(sanitizeData(cyc, 100)).toMatchObject({
      toolCallId: "c",
      omitted: true,
    });
  });

  test("BigInt 转字符串并受长度限制；线上形状以序列化结果为准", () => {
    const r = sanitizeData(
      { big: 10n ** 300000n, f: () => 1, toJSON: undefined },
      100,
    );
    expect(String(r.big).length).toBe(100);
    expect(r.truncated).toBe(true);
    expect(sanitizeData({ id: { toJSON: () => "wire-id" } }, 100)).toEqual({
      id: "wire-id",
    });
  });

  test("含 truncated 标记的最终 data 也不超过 FRAME_DATA_MAX（边界）", () => {
    const part = "a".repeat(262_144);
    const r = sanitizeData({ a: part, b: part, c: part, d: part }, 262_144);
    expect(bytes(r)).toBeLessThanOrEqual(FRAME_DATA_MAX);
    const edge = sanitizeData(
      { a: part, b: part, c: part, d: "x".repeat(262_144) + "y".repeat(1) },
      262_144,
    );
    expect(bytes(edge)).toBeLessThanOrEqual(FRAME_DATA_MAX);
  });

  test("紧贴上限（预留余量内）的载荷被兜底，不会在加标记后越线", () => {
    const r = sanitizeData(
      { a: "x".repeat(FRAME_DATA_MAX - 18) },
      FRAME_DATA_MAX,
    );
    expect(r.omitted).toBe(true);
  });

  test("队列条目数与长度有界", () => {
    const e = mapEvent({
      type: "queue_update",
      steering: Array.from({ length: 500 }, () => "q".repeat(5000)),
      followUp: [],
    } as never);
    const q = e?.data.queue as string[];
    expect(q).toHaveLength(100);
    expect(q[0]?.length).toBe(512);
  });
});
