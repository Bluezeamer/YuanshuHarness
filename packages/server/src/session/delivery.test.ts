import { afterAll, afterEach, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testPool,
} from "../../test/support/stub.js";
import { type ModeView, promptSlotsOf } from "./delivery.js";
import type { SessionPool } from "./pool.js";

// 提示词送达的端到端：冻结前缀、模式的进入 / 退出通知、被拦工具的原因、占位工具 call_tool。
// 用 stub 模型服务器记录每次请求里模型实际看到的内容。

const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [];
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Array<{ role: string }>;
  return CALLS[msgs.filter((m) => m.role === "tool").length] ?? "done";
});
afterAll(() => stub.close());

let pool: SessionPool;
let data: TestData;
afterEach(() => {
  pool?.dispose();
  data?.close();
  CALLS.length = 0;
  stub.requests.length = 0;
});

const READ_ONLY: ModeView = {
  id: "m-ro",
  name: "ReadOnly",
  text: "Only read, never write.",
  userText: "",
  ops: { limit: ["tool:read", "tool:ls", "tool:grep"], add: [], remove: [] },
};
const modes = new Map([["m-ro", READ_ONLY]]);

async function open() {
  const t = testPool(stubSessionFactory(stub, {}, true), undefined, {
    modeView: (id) => modes.get(id) ?? null,
  });
  pool = t.pool;
  data = t.data;
  const id = (await pool.create({ modePresetIds: ["m-ro"] })).id;
  const entry = pool.get(id);
  if (!entry) throw new Error("会话不存在");
  // answer：遇到审批弹窗时的回答（switch_mode 要人批）
  const run = async (text: string, answer = "allow") => {
    const c = collector((f) => {
      if (f.type === "prompt.requested")
        entry.answerPrompt(f.data.promptId, { optionId: answer });
    });
    entry.subscribe(c);
    entry.send(text);
    await waitFor(() => c.types().includes("run.ended"), "run.ended", 10_000);
  };
  return { id, run };
}

type Body = {
  tools?: { function: { name: string } }[];
  messages: { role: string; content: unknown }[];
};
const bodyAt = (i = -1): Body => {
  const r = stub.requests.at(i);
  if (!r) throw new Error("没有这次请求");
  return r.body as Body;
};

const toolNames = (i = -1): string[] =>
  (bodyAt(i).tools ?? []).map((t) => t.function.name);

/** 最近一次请求里所有 user 消息的文本（通知作为 user 消息尾注送达）。 */
const userTexts = (): string =>
  bodyAt()
    .messages.filter((m) => m.role === "user")
    .map((m) => JSON.stringify(m.content))
    .join("\n");

const allMessages = (i = -1): string => JSON.stringify(bodyAt(i).messages);

const lastToolResult = (): string =>
  JSON.stringify(
    bodyAt()
      .messages.filter((m) => m.role === "tool")
      .at(-1)?.content,
  );

test("两份 AGENTS.md 与全局附加提示词都不进状态映射", () => {
  const slots = promptSlotsOf({
    preamble: "identity",
    sections: {
      rules: "a",
      global_agentsmd: "b",
      global_extra: "c",
      project_agentsmd: "d",
    },
  });
  expect(slots).toEqual({ identity: "identity", rules: "a" });
});

test("首次请求：声明包含内置工具、call_tool 与 switch_mode，没有状态通知", async () => {
  const { run } = await open();
  await run("hi");
  const names = toolNames();
  expect(names).toEqual(
    expect.arrayContaining(["read", "bash", "call_tool", "switch_mode"]),
  );
  expect(userTexts()).not.toContain("System state update");
});

test("进入模式：前缀（工具声明）不变，通知写明进入与移除的工具；工具调用被拦并给出原因", async () => {
  const { id, run } = await open();
  await run("hi");
  const before = toolNames();

  pool.setActiveMode(id, "m-ro");
  CALLS.push({ tool: "bash", args: { command: "echo nope" } });
  await run("now try bash");
  // 冻结声明不变：缓存前缀不动
  expect(toolNames(-2)).toEqual(before);
  const text = allMessages(-2);
  expect(text).toContain('You entered mode \\"ReadOnly\\"');
  expect(text).toContain("Only read, never write.");
  expect(text).toContain("Tools no longer available:");
  // 被拦：我们写的原因，且没有执行
  expect(lastToolResult()).toContain('currently in \\"ReadOnly\\" mode');
  expect(lastToolResult()).toContain("nothing was executed");
});

test("退出模式后：恢复的工具经通知得知，并能用 call_tool 调用", async () => {
  const { id, run } = await open();
  // 先在模式里冻结：声明里只有只读工具
  pool.setActiveMode(id, "m-ro");
  await run("hi");
  expect(toolNames()).not.toContain("bash");

  pool.setActiveMode(id, null);
  CALLS.push({
    tool: "call_tool",
    args: { name: "ls", arguments: { path: "." } },
  });
  await run("look around");
  const text = allMessages(-2);
  expect(text).toContain('You left mode \\"ReadOnly\\"');
  expect(text).toContain("through call_tool");
  expect(text).toContain("- ls:");
  // 经 call_tool 转发成功：返回目录内容而不是错误
  expect(lastToolResult()).not.toContain("NOT executed");
  expect(lastToolResult()).not.toContain("not available");
});

test("call_tool 参数写错：返回带签名的英文错误，工具没有执行", async () => {
  const { run } = await open();
  CALLS.push({ tool: "call_tool", args: { name: "nope_tool" } });
  await run("go");
  expect(lastToolResult()).toContain("There is no callable tool named");
  expect(lastToolResult()).toContain("NOT executed");
});

test("模型自己用 switch_mode 切换：结果里直接给出通知，下一轮不重复", async () => {
  const { run } = await open();
  CALLS.push({ tool: "switch_mode", args: { mode: "ReadOnly" } });
  await run("switch please");
  expect(lastToolResult()).toContain('You entered mode \\"ReadOnly\\"');
  stub.requests.length = 0;
  await run("next turn");
  expect(userTexts()).not.toContain("System state update");
});

test("switch_mode 被用户拒绝：模式不变，模型看到拒绝原因", async () => {
  const { run } = await open();
  CALLS.push({ tool: "switch_mode", args: { mode: "ReadOnly" } });
  await run("switch please", "deny");
  expect(lastToolResult()).toContain("用户拒绝了切换模式");
  expect(toolNames()).toContain("write");
});
