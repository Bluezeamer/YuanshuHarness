import { expect, test } from "vitest";
import { type ConvState, type Frame, initial, reduce } from "./conversation";

let seq = 0;
const f = (type: string, data: Record<string, unknown> = {}): Frame => ({
  session: "s",
  seq: ++seq,
  type,
  data,
});
const run = (frames: Frame[], from: ConvState = initial) =>
  frames.reduce(reduce, from);

test("R4 delta 追加到进行中的助手消息，ended 后落入消息列表并清除光标", () => {
  const s = run([
    f("message.started", { role: "assistant", text: "" }),
    f("message.delta", { kind: "text", text: "你" }),
    f("message.delta", { kind: "text", text: "好" }),
  ]);
  expect(s.partial).toBe("你好");
  const e = reduce(
    s,
    f("message.ended", { role: "assistant", text: "你好！" }),
  );
  expect(e.partial).toBeNull();
  expect(e.messages).toEqual([{ role: "assistant", text: "你好！" }]);
});

test("R4 非 text 的 delta 被忽略", () => {
  const s = run([
    f("message.started", { role: "assistant" }),
    f("message.delta", { kind: "thinking", text: "内心独白" }),
  ]);
  expect(s.partial).toBe("");
});

test("R4 用户消息 started 不渲染，ended 只渲染一次", () => {
  const s = run([
    f("message.started", { role: "user", text: "hi" }),
    f("message.ended", { role: "user", text: "hi" }),
  ]);
  expect(s.messages).toEqual([{ role: "user", text: "hi" }]);
  expect(s.partial).toBeNull();
});

test("R5 工具起止与失败", () => {
  const s = run([
    f("tool.started", { toolCallId: "a", toolName: "bash" }),
    f("tool.started", { toolCallId: "b", toolName: "read" }),
    f("tool.ended", { toolCallId: "a", isError: false }),
    f("tool.ended", { toolCallId: "b", isError: true }),
  ]);
  expect(s.tools).toEqual([
    { id: "a", name: "bash", status: "ok", output: "" },
    { id: "b", name: "read", status: "error", output: "" },
  ]);
});

test("工具实时输出随 tool.updated 更新，结束时落定", () => {
  const s = run([
    f("tool.started", { toolCallId: "a", toolName: "bash" }),
    f("tool.updated", { toolCallId: "a", output: "line1" }),
    f("tool.updated", { toolCallId: "a", output: "line1\nline2" }),
  ]);
  expect(s.tools[0]).toMatchObject({
    status: "running",
    output: "line1\nline2",
  });
  const e = reduce(
    s,
    f("tool.ended", { toolCallId: "a", output: "done", isError: false }),
  );
  expect(e.tools[0]).toMatchObject({ status: "ok", output: "done" });
});

test("R5 快照恢复进行中的工具与半截消息", () => {
  const s = reduce(
    initial,
    f("snapshot", {
      messages: [{ role: "user", text: "q" }],
      running: true,
      activeTools: [{ toolCallId: "a", toolName: "bash" }],
      partial: { role: "assistant", text: "半" },
      queue: ["下一条"],
    }),
  );
  expect(s).toMatchObject({
    running: true,
    partial: "半",
    queue: ["下一条"],
    tools: [{ id: "a", name: "bash", status: "running" }],
  });
});

test("R5 run.failed 记录错误，下一次 run.started 清除", () => {
  const failed = reduce(initial, f("run.failed", { message: "模型不可用" }));
  expect(failed.error).toBe("模型不可用");
  expect(reduce(failed, f("run.started")).error).toBeNull();
});

test("R6 run.started/ended 切换运行态，ended 清掉半截消息", () => {
  const s = run([
    f("run.started"),
    f("message.started", { role: "assistant" }),
    f("run.ended", { aborted: true }),
  ]);
  expect(s.running).toBe(false);
  expect(s.partial).toBeNull();
});

test("R6 queue.updated 替换队列", () => {
  expect(
    reduce(initial, f("queue.updated", { queue: ["a", "b"] })).queue,
  ).toEqual(["a", "b"]);
});

test("R3 新快照整体替换此前累积的状态", () => {
  const dirty = run([
    f("message.ended", { role: "user", text: "旧" }),
    f("tool.started", { toolCallId: "a", toolName: "bash" }),
  ]);
  const s = reduce(dirty, f("snapshot", { messages: [], running: false }));
  expect(s).toEqual({ ...initial });
});

test("未知帧类型与坏数据不抛错", () => {
  expect(reduce(initial, f("future.thing"))).toBe(initial);
  expect(
    reduce(initial, f("message.ended", { role: "system", text: "x" })),
  ).toBe(initial);
});
