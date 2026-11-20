import { expect, test } from "vitest";
import { parseAttachments } from "../../../api";
import {
  type ConvState,
  type Frame,
  initial,
  parseUsage,
  reduce,
  USAGE_LOADED,
} from "./conversation";

let seq = 0;
const f = (type: string, data: Record<string, unknown> = {}): Frame => ({
  session: "s",
  seq: ++seq,
  type,
  data,
});
const run = (frames: Frame[], from: ConvState = initial) =>
  frames.reduce(reduce, from);

// ---- 从旧 conversation.test.ts 迁移 ----

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

test("R4 思考增量单独累积，不串进正文；结束后清空", () => {
  const s = run([
    f("message.started", { role: "assistant" }),
    f("message.delta", { kind: "thinking", text: "内心" }),
    f("message.delta", { kind: "thinking", text: "独白" }),
    f("message.delta", { kind: "text", text: "你好" }),
  ]);
  expect(s.partial).toBe("你好");
  expect(s.partialThinking).toBe("内心独白");
  const e = reduce(s, f("message.ended", { role: "assistant", text: "你好" }));
  expect(e.partialThinking).toBe("");
  expect(e.pendingTools).toEqual([]);
});

test("R4 工具参数增量先累积成 pendingTools，tool.started 后落成运行中工具行", () => {
  const s = run([
    f("message.started", { role: "assistant" }),
    f("message.delta", {
      kind: "toolstart",
      toolCallId: "c1",
      toolName: "write",
    }),
    f("message.delta", {
      kind: "toolarg",
      toolCallId: "c1",
      toolName: "write",
      text: '{"path":"a',
    }),
    f("message.delta", {
      kind: "toolarg",
      toolCallId: "c1",
      toolName: "write",
      text: '.ts"}',
    }),
  ]);
  expect(s.pendingTools).toEqual([
    { id: "c1", name: "write", args: '{"path":"a.ts"}' },
  ]);
  const started = reduce(
    s,
    f("tool.started", {
      toolCallId: "c1",
      toolName: "write",
      args: { path: "a.ts" },
    }),
  );
  expect(started.pendingTools).toEqual([]);
  expect(started.tools).toEqual([
    { id: "c1", name: "write", status: "running", args: { path: "a.ts" } },
  ]);
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

test("工具实时输出随 tool.updated 更新，结束时落定，带上耗时", () => {
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
    f("tool.ended", {
      toolCallId: "a",
      output: "done",
      isError: false,
      durationMs: 120,
    }),
  );
  expect(e.tools[0]).toMatchObject({
    status: "ok",
    output: "done",
    durationMs: 120,
  });
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

test("R6 run.ended 清掉还挂着的工具（没等到 tool.ended 的不滞留）", () => {
  const s = run([
    f("run.started"),
    f("tool.started", { toolCallId: "a", toolName: "bash" }),
    f("tool.started", { toolCallId: "b", toolName: "read" }),
    f("tool.ended", { toolCallId: "b", output: "ok" }),
    f("run.ended", { aborted: true }),
  ]);
  expect(s.tools).toEqual([]);
});

test("R6 queue.updated 替换队列", () => {
  expect(
    reduce(initial, f("queue.updated", { queue: ["a", "b"] })).queue,
  ).toEqual(["a", "b"]);
});

test("R6 停止后服务端发空的 queue.updated：队列被清空，而不是保留旧值", () => {
  const queued = reduce(initial, f("queue.updated", { queue: ["a", "b"] }));
  expect(reduce(queued, f("queue.updated", { queue: [] })).queue).toEqual([]);
});

test("R3 新快照整体替换此前累积的状态（只有 flows / context / turn / jobs 版本号继续累加）", () => {
  const dirty = run([
    f("message.ended", { role: "user", text: "旧" }),
    f("tool.started", { toolCallId: "a", toolName: "bash" }),
    f("goal.updated", { goal }),
    f("plan.updated", { todos: [{ content: "旧", status: "pending" }] }),
    f("run.failed", { message: "旧错误" }),
  ]);
  const s = reduce(dirty, f("snapshot", { messages: [], running: false }));
  expect(s).toEqual({
    ...initial,
    flowsRev: 1,
    contextRev: 1,
    turnRev: 1,
    jobsRev: 1,
  });
});

const jobData = {
  id: "j1",
  kind: "command",
  name: "bash",
  label: "npm run build",
  ref: null,
  state: "done",
  exitCode: 0,
  startedAt: "2026-11-17T08:00:00.000Z",
  endedAt: "2026-11-17T08:01:00.000Z",
};

test("notice（任务）：按到达时窗口里已有的消息条数落点，并带动右栏重取", () => {
  let s = reduce(initial, f("message.ended", { role: "user", text: "跑一下" }));
  s = reduce(
    s,
    f("notice", { kind: "job", job: jobData, ts: "2026-11-17T08:01:01Z" }),
  );
  expect(s.notices).toEqual([
    { kind: "job", at: 1, ts: "2026-11-17T08:01:01Z", job: jobData },
  ]);
  expect(s.jobsRev).toBe(1);
  // 之后的消息不挪动它
  s = reduce(s, f("message.ended", { role: "assistant", text: "好" }));
  expect(s.notices[0]?.at).toBe(1);
});

test("notice（任务）：快照清空本连接收到的卡（持久的由历史接口给），坏数据丢弃", () => {
  let s = reduce(initial, f("notice", { kind: "job", job: jobData }));
  expect(s.notices).toHaveLength(1);
  s = reduce(
    s,
    f("notice", { kind: "job", job: { ...jobData, state: "弄错了" } }),
  );
  s = reduce(s, f("notice", { kind: "job", nope: 1 }));
  expect(s.notices).toHaveLength(1);
  s = reduce(s, f("snapshot", { messages: [], running: false }));
  expect(s.notices).toEqual([]);
});

test("notice（目标）：按到达位置落点，不动右栏的任务版本号；形状不对的丢弃", () => {
  const n = {
    event: "paused",
    goalId: "g1",
    revision: 4,
    reason: { code: "user-stopped" },
  };
  let s = reduce(initial, f("message.ended", { role: "user", text: "做" }));
  s = reduce(s, f("notice", { kind: "goal", goal: n, ts: "t9" }));
  expect(s.notices).toEqual([{ kind: "goal", at: 1, ts: "t9", goal: n }]);
  expect(s.jobsRev).toBe(0);
  // 边界：没有 goalId、事件名不认识
  s = reduce(s, f("notice", { kind: "goal", goal: { ...n, goalId: "" } }));
  s = reduce(s, f("notice", { kind: "goal", goal: { ...n, event: "乱写" } }));
  expect(s.notices).toHaveLength(1);
  // edited 里 maxRounds: null 是「改成不限」，要保留；没带就是没改
  s = reduce(
    s,
    f("notice", {
      kind: "goal",
      goal: { event: "edited", goalId: "g1", revision: 5, maxRounds: null },
    }),
  );
  s = reduce(
    s,
    f("notice", {
      kind: "goal",
      goal: { event: "edited", goalId: "g1", revision: 6, text: "新" },
    }),
  );
  const last = s.notices.slice(-2).map((x) => (x.kind === "goal" ? x.goal : x));
  expect(last[0]).toHaveProperty("maxRounds", null);
  expect(last[1]).not.toHaveProperty("maxRounds");
});

test("jobs.updated 只让版本号加一", () => {
  const s = reduce(initial, f("jobs.updated", {}));
  expect(s).toEqual({ ...initial, jobsRev: 1 });
});

test("未知帧类型与坏数据不抛错", () => {
  expect(reduce(initial, f("future.thing"))).toBe(initial);
  expect(
    reduce(initial, f("message.ended", { role: "system", text: "x" })),
  ).toBe(initial);
});

// ---- 弹窗（旧 prompt.test.tsx 的 reduce 部分） ----

const approval = {
  promptId: "p1",
  source: "approval",
  title: "允许执行 bash？",
  input: "text",
  options: [
    { id: "allow", label: "允许" },
    { id: "deny", label: "拒绝" },
  ],
  detail: { tool: "bash", summary: "rm -rf build" },
  expiresAt: 1_800_000_000_000,
};

test("prompt：丢弃坏数据、去重，resolved 移除对应弹窗", () => {
  let s = reduce(initial, f("prompt.requested", { nope: 1 }));
  expect(s.prompts).toEqual([]);
  s = reduce(s, f("prompt.requested", approval));
  s = reduce(s, f("prompt.requested", approval));
  expect(s.prompts).toHaveLength(1);
  expect(s.prompts[0]).toMatchObject({
    promptId: "p1",
    source: "approval",
    detail: { tool: "bash", summary: "rm -rf build" },
    expiresAt: 1_800_000_000_000,
  });
  s = reduce(s, f("prompt.resolved", { promptId: "zz", outcome: "answered" }));
  expect(s.prompts).toHaveLength(1);
  s = reduce(s, f("prompt.resolved", { promptId: "p1", outcome: "timeout" }));
  expect(s.prompts).toEqual([]);
});

test("prompt：快照补发待处理弹窗；重连快照里没有则消失", () => {
  const s = reduce(initial, f("snapshot", { prompts: [approval] }));
  expect(s.prompts).toHaveLength(1);
  expect(reduce(s, f("snapshot", { prompts: [] })).prompts).toEqual([]);
});

// ---- 新事件 ----

const goal = {
  id: "g1",
  revision: 2,
  text: "把测试补齐",
  by: "user",
  state: "active",
  maxRounds: 50,
  rounds: 3,
  since: "t0",
  updatedAt: "t1",
};

test("goal.updated 设置、暂停（带原因）、不限轮数、清空；坏数据忽略", () => {
  let s = reduce(initial, f("goal.updated", { goal }));
  expect(s.goal).toEqual(goal);
  s = reduce(
    s,
    f("goal.updated", {
      goal: {
        ...goal,
        by: "model",
        state: "paused",
        reason: { code: "request-failed", detail: "502" },
        maxRounds: null,
      },
    }),
  );
  expect(s.goal).toMatchObject({
    by: "model",
    state: "paused",
    reason: { code: "request-failed", detail: "502" },
    maxRounds: null,
  });
  // 状态或原因不认识的当坏数据
  expect(
    reduce(s, f("goal.updated", { goal: { ...goal, state: "run" } })),
  ).toBe(s);
  const same = reduce(s, f("goal.updated", { goal: "坏的" }));
  expect(same).toBe(s);
  expect(reduce(s, f("goal.updated", { goal: null })).goal).toBeNull();
});

test("plan.updated 整份替换，丢弃无效项；缺 todos 不改", () => {
  let s = reduce(
    initial,
    f("plan.updated", {
      todos: [
        { content: "甲", status: "completed" },
        { content: "乙", status: "in_progress" },
        { content: "丙", status: "nope" },
        { status: "pending" },
      ],
    }),
  );
  expect(s.todos).toEqual([
    { content: "甲", status: "completed" },
    { content: "乙", status: "in_progress" },
  ]);
  s = reduce(s, f("plan.updated", { todos: [] }));
  expect(s.todos).toEqual([]);
  expect(reduce(s, f("plan.updated", {}))).toBe(s);
});

test("context.compacted 记摘要与降幅并清掉失败；compact_failed 记原因", () => {
  const failed = reduce(
    initial,
    f("context.compact_failed", { message: "模型不可用" }),
  );
  expect(failed.compactError).toBe("模型不可用");
  const s = reduce(failed, {
    ...f("context.compacted", { summary: "摘要", savedPct: 62 }),
    ts: "T",
  });
  expect(s.compact).toEqual({ summary: "摘要", savedPct: 62, at: "T" });
  expect(s.compactError).toBeNull();
  // 降幅钳到 0-100，缺失按 0
  expect(
    reduce(s, f("context.compacted", { summary: "x", savedPct: 300 })).compact
      ?.savedPct,
  ).toBe(100);
  expect(
    reduce(s, f("context.compacted", { summary: "x" })).compact?.savedPct,
  ).toBe(0);
});

test("flows.updated 版本号递增并记下变更的 id", () => {
  let s = reduce(initial, f("flows.updated", { changed: ["a", "b"] }));
  expect(s.flowsRev).toBe(1);
  expect(s.flowsChanged).toEqual(["a", "b"]);
  s = reduce(s, f("flows.updated", {}));
  expect(s.flowsRev).toBe(2);
  expect(s.flowsChanged).toEqual([]);
});

// 轮末改动清单由服务端落库后才推 turn.changes：界面据此重取，不能只看「空闲」，
// 因为写库是 run.ended 之后异步做的，那一刻拉清单还拿不到本轮。
test("turn.changes 让 turnRev 加 1，未知载荷也不抛错", () => {
  const s = reduce(initial, f("turn.changes", { turn: 1, total: 2 }));
  expect(s.turnRev).toBe(1);
  expect(reduce(s, f("turn.changes", {})).turnRev).toBe(2);
});

// 文件浏览器 / 预览按环境各自计数：只重取自己那台主机
test("fs.changed 按环境分别计数，坏载荷忽略", () => {
  const a = reduce(initial, f("fs.changed", { env: "local", paths: ["/w"] }));
  expect(a.fsRev).toEqual({ local: 1 });
  const b = reduce(a, f("fs.changed", { env: "ssh-1", paths: ["/s"] }));
  expect(b.fsRev).toEqual({ local: 1, "ssh-1": 1 });
  const c = reduce(b, f("fs.changed", { env: "local", paths: [] }));
  expect(c.fsRev).toEqual({ local: 2, "ssh-1": 1 });
  expect(reduce(c, f("fs.changed", {}))).toBe(c);
});

test("context.updated 与快照都让 contextRev 加 1", () => {
  let s = reduce(initial, f("context.updated", { files: 3 }));
  expect(s.contextRev).toBe(1);
  s = reduce(s, f("context.updated", {}));
  expect(s.contextRev).toBe(2);
  expect(reduce(s, f("snapshot", { messages: [] })).contextRev).toBe(3);
});

const usage = {
  turns: 2,
  steps: 5,
  tokensPerSecond: 40.5,
  modelMs: 8000,
  tokens: { input: 1000, output: 200, cacheRead: 600, cacheWrite: 0 },
  cacheHitRate: 0.6,
  context: { used: 1200, window: 8000, system: 100, tools: 200, messages: 900 },
};

test("snapshot 带 goal / todos / compact / usage", () => {
  const s = reduce(
    initial,
    f("snapshot", {
      goal,
      todos: [{ content: "甲", status: "pending" }],
      compact: { summary: "旧摘要", at: "t", savedPct: 40 },
      usage,
    }),
  );
  expect(s.goal).toEqual(goal);
  expect(s.todos).toEqual([{ content: "甲", status: "pending" }]);
  expect(s.compact).toEqual({ summary: "旧摘要", at: "t", savedPct: 40 });
  expect(s.usage).toMatchObject({
    turns: 2,
    steps: 5,
    tokensPerSecond: 40.5,
    modelMs: 8000,
    toolMs: null,
    ttftMs: null,
    cacheHitRate: 0.6,
    context: { used: 1200, window: 8000, system: 100, tools: 200 },
  });
});

test("snapshot 缺新字段：goal/todos/compact 归零，usage 沿用已有值", () => {
  const withUsage = reduce(initial, f("snapshot", { usage }));
  const s = reduce(
    run(
      [
        f("goal.updated", { goal }),
        f("plan.updated", { todos: [{ content: "甲", status: "pending" }] }),
      ],
      withUsage,
    ),
    f("snapshot", { messages: [] }),
  );
  expect(s.goal).toBeNull();
  expect(s.todos).toEqual([]);
  expect(s.compact).toBeNull();
  expect(s.usage).toEqual(withUsage.usage);
  // 坏的新字段同样容错
  const bad = reduce(
    initial,
    f("snapshot", { goal: 1, todos: "x", compact: [], usage: { tokens: 3 } }),
  );
  expect(bad).toMatchObject({
    goal: null,
    todos: [],
    compact: null,
    usage: null,
  });
});

test("run.ended 带 usage / steps / turn：累加进会话累计并记下步数轮数", () => {
  const base = reduce(initial, f("snapshot", { usage }));
  const s = reduce(
    base,
    f("run.ended", {
      aborted: false,
      usage: { input: 100, output: 50, cacheRead: 80, cacheWrite: 0 },
      steps: 3,
      turn: 3,
    }),
  );
  expect(s.running).toBe(false);
  expect(s.steps).toBe(3);
  expect(s.turn).toBe(3);
  expect(s.usage).toMatchObject({
    turns: 3,
    steps: 8,
    tokens: { input: 1100, output: 250, cacheRead: 680, cacheWrite: 0 },
  });
});

test("run.ended 没有这些字段（无调用记录库）：只切运行态，usage 不变", () => {
  const s = run([f("run.started"), f("run.ended", { aborted: false })]);
  expect(s.running).toBe(false);
  expect(s.usage).toBeNull();
  expect(s.steps).toBeNull();
  expect(s.turn).toBeNull();
  // 没有快照 usage 时，本轮增量不凭空造出累计
  const noBase = reduce(
    initial,
    f("run.ended", {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      steps: 1,
      turn: 1,
    }),
  );
  expect(noBase.usage).toBeNull();
  expect(noBase.turn).toBe(1);
});

test("本地 usage_loaded 帧用精确值覆盖累计；坏数据忽略", () => {
  const s = reduce(initial, f(USAGE_LOADED, usage));
  expect(s.usage?.tokens.input).toBe(1000);
  expect(reduce(s, f(USAGE_LOADED, { nope: 1 }))).toBe(s);
});

test("parseUsage：context 缺失为 null；messages 缺失时取 used", () => {
  expect(parseUsage({ ...usage, context: null })?.context).toBeNull();
  expect(
    parseUsage({ ...usage, context: { used: 10, window: null } })?.context,
  ).toEqual({ used: 10, window: null, messages: 10 });
  expect(parseUsage(null)).toBeNull();
});

// ---- 附件引用 ----

const attachment = {
  name: "a.html",
  mime: "text/html",
  sizeText: "3 B",
  path: "./2026-10-27/ab-a.html",
};

test("快照解析 user 消息的附件引用；形状不对的当没有附件", () => {
  const s = run([
    f("snapshot", {
      messages: [
        { role: "user", text: "看这个", attachments: [attachment] },
        { role: "assistant", text: "好", attachments: "bad" },
      ],
      activeTools: [],
      partial: null,
      running: false,
      queue: [],
    }),
  ]);
  expect(s.messages[0]).toEqual({
    role: "user",
    text: "看这个",
    attachments: [attachment],
  });
  expect(s.messages[1]).toEqual({ role: "assistant", text: "好" });
});

test("message.ended 带 attachments 也解析", () => {
  const s = run([
    f("message.ended", {
      role: "user",
      text: "文件",
      attachments: [attachment],
    }),
  ]);
  expect(s.messages[0]?.attachments).toEqual([attachment]);
});

test("parseAttachments：缺失 / 空数组 / 坏字段都返回 null", () => {
  expect(parseAttachments(undefined)).toBeNull();
  expect(parseAttachments([])).toBeNull();
  expect(parseAttachments([{ name: "x" }])).toBeNull();
  expect(parseAttachments([{ name: "x", path: "./x" }])).toEqual([
    { name: "x", mime: "", sizeText: "", path: "./x" },
  ]);
});

test("工具结果晚到：tool.updated/ended 回填到消息块，已渲染的工具行不会一直显示运行中", () => {
  const s = run([
    f("message.started", { role: "assistant" }),
    f("message.ended", {
      role: "assistant",
      text: "",
      blocks: [
        {
          type: "tool",
          id: "c1",
          name: "bash",
          args: '{"command":"echo hi"}',
        },
      ],
    }),
    f("tool.started", {
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "echo hi" },
    }),
    f("tool.updated", { toolCallId: "c1", output: "hi\n" }),
  ]);
  expect(s.messages[0]?.blocks?.[0]).toMatchObject({ live: "hi\n" });
  const end = reduce(
    s,
    f("tool.ended", { toolCallId: "c1", output: "hi\n", isError: false }),
  );
  expect(end.messages[0]?.blocks?.[0]).toMatchObject({
    result: "hi\n",
    isError: false,
  });
  expect(end.tools[0]?.status).toBe("ok");
});

test("消息时间：快照与 message.ended 都解析 ts，缺 ts / 类型不对时不带字段", () => {
  const s = reduce(
    initial,
    f("snapshot", {
      messages: [
        { role: "assistant", text: "a", ts: "2026-10-28T01:23:00.000Z" },
        { role: "user", text: "q" },
      ],
      startIndex: 0,
    }),
  );
  expect(s.messages[0]?.ts).toBe("2026-10-28T01:23:00.000Z");
  expect(s.messages[1]).not.toHaveProperty("ts");

  const ended = reduce(
    s,
    f("message.ended", {
      role: "assistant",
      text: "b",
      ts: "2026-10-28T01:24:00.000Z",
    }),
  );
  expect(ended.messages[2]?.ts).toBe("2026-10-28T01:24:00.000Z");

  const bad = reduce(
    ended,
    f("message.ended", { role: "assistant", text: "c", ts: 123 }),
  );
  expect(bad.messages[3]).not.toHaveProperty("ts");
});

// ---- 目标带附件 ----

test("目标快照与目标卡片带附件：附件按引用解析，坏项丢弃", () => {
  const goal = {
    id: "g1",
    revision: 2,
    text: "按规格书实现",
    by: "user",
    state: "active",
    maxRounds: 50,
    rounds: 0,
    since: "t",
    updatedAt: "t",
    attachments: [
      {
        name: "spec.pdf",
        mime: "application/pdf",
        sizeText: "20 KB",
        path: "spec.pdf",
      },
      { name: "没有路径" },
    ],
  };
  const s = run([f("goal.updated", { goal })]);
  expect(s.goal?.attachments).toEqual([
    {
      name: "spec.pdf",
      mime: "application/pdf",
      sizeText: "20 KB",
      path: "spec.pdf",
    },
  ]);
  const none = run([
    f("goal.updated", { goal: { ...goal, attachments: undefined } }),
  ]);
  expect(none.goal).not.toHaveProperty("attachments");

  const n = run([
    f("notice", {
      kind: "goal",
      afterIndex: 0,
      goal: {
        event: "set",
        goalId: "g1",
        revision: 1,
        by: "user",
        text: "x",
        files: ["spec.pdf", 3],
      },
    }),
  ]);
  expect(n.notices[0]).toMatchObject({ goal: { files: ["spec.pdf"] } });
});
