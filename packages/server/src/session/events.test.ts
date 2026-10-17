import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  boundStrings,
  capFrameData,
  FRAME_DATA_MAX,
  mapEvent,
  messageText,
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
  test("字符串截断不切开代理对", () => {
    const r = boundStrings("a".repeat(9) + "😀", 10);
    expect(r.truncated).toBe(true);
    expect(r.value).toBe("a".repeat(9));
  });

  test("宽数组、宽对象、长键、Buffer、深嵌套都被限制并标记", () => {
    const wide = boundStrings(
      { a: Array.from({ length: 5000 }, () => 1) },
      100,
    );
    expect(wide.value.a).toHaveLength(200);
    expect(wide.truncated).toBe(true);
    const keys = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]),
    );
    expect(Object.keys(boundStrings(keys, 100).value)).toHaveLength(200);
    const longKey = boundStrings({ ["k".repeat(5000)]: 1 }, 100);
    expect(Object.keys(longKey.value)[0]?.length).toBe(256);
    const buf = boundStrings({ b: Buffer.alloc(300_000) }, 100);
    expect(buf.value.b).toBeNull();
    expect(buf.truncated).toBe(true);
    let deep: unknown = "x";
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(boundStrings(deep, 100).truncated).toBe(true);
  });

  test("宽度乘长度仍超限时整体兜底，只留短标量", () => {
    const heavy = {
      toolCallId: "c1",
      toolName: "t",
      isError: false,
      result: Array.from({ length: 200 }, () => "y".repeat(100_000)),
    };
    const b = boundStrings(heavy, 256 * 1024);
    const capped = capFrameData(b.value);
    expect(JSON.stringify(capped).length).toBeLessThan(FRAME_DATA_MAX);
    expect(capped).toMatchObject({
      toolCallId: "c1",
      toolName: "t",
      isError: false,
      omitted: true,
      truncated: true,
    });
    expect(capped).not.toHaveProperty("result");
  });
});
