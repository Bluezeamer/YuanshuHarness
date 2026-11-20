import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, type Frame, waitFor } from "../../test/support/frames.js";
import { startStub } from "../../test/support/stub.js";
import {
  isChild,
  type Msg,
  spawnChild,
  subagentWorld,
} from "../../test/support/subagents.js";
import { SessionLibrary } from "../session/library.js";
import { CallStore } from "../store/calls.js";
import type { ChatEntry } from "../store/history.js";
import {
  buildFlows,
  type ExecutionBody,
  type Flows,
  flowsApi,
  logOf,
} from "./flows.js";
import { topologyApi } from "./topology.js";

// 子会话（请求里带开场说明）先调一次未知工具、交付，再给结论；其余请求回一句话。
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Msg[];
  if (!isChild(body)) return "ok";
  const tools = msgs.filter((m) => m.role === "tool").length;
  if (tools === 0) return { tool: "read_file", args: { path: "src/a.ts" } };
  if (tools === 1)
    return { tool: "deliver", args: { summary: "结论：做完了" } };
  return "结论：做完了";
});
afterAll(() => stub.close());

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
});

async function setup() {
  const w = subagentWorld(stub);
  const { data, pool, subagents, rt, presets, jobs, teams, workflowRt } = w;
  const calls = new CallStore(data.db);
  const deps = {
    pool,
    subagents,
    calls,
    presets,
    jobs,
    teams,
    queued: (runId: string) => workflowRt.queued(runId),
  };
  const build = (id: string) => buildFlows(id, deps);
  const app: FastifyInstance = Fastify();
  app.register(flowsApi, deps);
  app.register(topologyApi, { pool, subagents });
  await app.ready();
  cleanups.push(
    () => app.close(),
    () => w.close(),
  );
  const get = (url: string) => app.inject({ method: "GET", url });
  const flows = async (id: string) =>
    (await get(`/api/v1/sessions/${id}/flows`)).json() as Flows;
  // 直接登记一个子会话（不发送，没有任务），用来摆出各种状态。
  const mkChild = async (
    parentId: string,
    depth: number,
    task: string,
    run?: { id: string; phase: string | null },
  ) => {
    const info = await pool.create({
      promptPresetId: w.coder.id,
      child: {
        parentId,
        depth,
        task,
        activeModeId: null,
        ...(run ? { run, counted: false } : {}),
        spec: {
          agentPresetId: w.coder.id,
          directoryIds: [],
          primaryDirectoryId: "",
          tierCap: "auto",
        },
      },
    });
    return info.id;
  };
  return { ...w, data, p: w, subagents, calls, rt, get, flows, build, mkChild };
}

const byId = (f: Flows, id: string) =>
  f.executions.find((e) => e.id === id) as ExecutionBody;

describe("会话库与子代理会话", () => {
  test("子代理会话不进会话库列表，但仍可按 id 取到", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    const child = await ctx.mkChild(root.id, 1, "读文件");
    const library = new SessionLibrary(ctx.pool);
    expect(library.list().map((v) => v.id)).toEqual([root.id]);
    expect(library.get(child)?.id).toBe(child);
  });
});

describe("GET /api/v1/sessions/:id/flows", () => {
  test("会话不存在返回 404；没有子代理返回空数组", async () => {
    const ctx = await setup();
    const res = await ctx.get("/api/v1/sessions/nope/flows");
    expect(res.statusCode).toBe(404);
    const root = await ctx.pool.create();
    const f = await ctx.flows(root.id);
    expect(f).toEqual({ executions: [], workflow: [] });
  });

  test("一父一子：完整字段，工具与日志来自真实子会话", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    const r = await spawnChild(ctx, root.id, { task: "读文件并返回结论" });
    await waitFor(
      () => ctx.subagents.get(r.childId)?.state === "done",
      "子完成",
    );
    const f = await ctx.flows(root.id);
    expect(f.executions).toHaveLength(1);
    const e = byId(f, r.childId);
    expect(e).toMatchObject({
      id: r.childId,
      parentId: root.id,
      depth: 1,
      source: "task",
      member: null,
      run: null,
      name: "读文件并返回结论",
      role: ctx.presets.get(
        ctx.subagents.get(r.childId)?.spec.agentPresetId ?? "",
      )?.name,
      state: "done",
      outcome: "ok",
      result: "结论：做完了",
      task: "读文件并返回结论",
    });
    expect(e.since).toBe(ctx.pool.info(r.childId)?.createdAt);
    expect(Array.isArray(e.tools)).toBe(true);
    expect(e.model).toBe("stub-model");
    expect(e.log).toEqual([
      { kind: "tool", name: "read_file", text: "src/a.ts" },
      { kind: "tool", name: "deliver", text: "结论：做完了" },
      { kind: "note", text: "结论：做完了" },
    ]);
    expect(f.workflow).toEqual([]);
  });

  test("来源：团队成员 source=team 带名字；自己派发的是 task", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    const plain = await ctx.mkChild(root.id, 1, "自己派的");
    const mate = await ctx.mkChild(root.id, 1, "团队里的活");
    ctx.teams.addMember({
      childId: mate,
      leadId: root.id,
      name: "小王",
      agentName: "coder",
    });
    const f = await ctx.flows(root.id);
    expect(byId(f, plain)).toMatchObject({ source: "task", member: null });
    expect(byId(f, mate)).toMatchObject({
      source: "team",
      member: "小王",
      run: null,
    });
  });

  test("工作流 agent：来源 workflow，带运行与阶段；按运行聚合，排队的单独数", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    const own = await spawnChild(ctx, root.id, { task: "自己派的" });
    await waitFor(
      () => ctx.subagents.get(own.childId)?.state === "done",
      "自己派的完成",
    );
    stub.mode.delayMs = 150;
    const done = ctx.workflowRt.run(
      root.id,
      {
        script: `phase("查"); await Promise.all([agent("a"), agent("b"), agent("c")]); phase("写"); await agent("d"); return 1;`,
        concurrency: 1,
        label: "两阶段",
      },
      { toolCallId: "c", signal: undefined, branch: [] },
    );
    // 并发 1：第一个在跑，另两个在排队
    await waitFor(() => {
      const [run] = ctx.build(root.id).workflow;
      return run?.phases[0]?.queued === 2;
    }, "两个排队");
    const mid = ctx.build(root.id).workflow[0];
    expect(mid).toMatchObject({
      label: "两阶段",
      state: "run",
      ended: null,
      started: 1,
      limit: 1000,
    });
    expect(mid?.phases).toEqual([
      { name: "查", run: 1, done: 0, failed: 0, queued: 2 },
    ]);
    await done;

    const f = await ctx.flows(root.id);
    const [run] = f.workflow;
    expect(run).toMatchObject({ state: "ok", started: 4 });
    expect(run?.ended).toEqual(expect.any(String));
    expect(run?.phases).toEqual([
      { name: "查", run: 0, done: 3, failed: 0, queued: 0 },
      { name: "写", run: 0, done: 1, failed: 0, queued: 0 },
    ]);
    const agents = f.executions.filter((e) => e.source === "workflow");
    expect(agents).toHaveLength(4);
    for (const a of agents) {
      expect(a.run?.id).toBe(run?.id);
      expect(a.member).toBeNull();
    }
    expect(agents.map((a) => a.run?.phase)).toEqual(["查", "查", "查", "写"]);
    // 自己派发的子代理照旧是 task，和工作流 agent 在同一张清单里
    expect(byId(f, own.childId).source).toBe("task");
  });

  test("排队期间脚本换了阶段：agent 仍属于调用它的那一阶段", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    stub.mode.delayMs = 60;
    await ctx.workflowRt.run(
      root.id,
      {
        script: `phase("A"); const p = Promise.all([agent("1"), agent("2")]); phase("B"); await p; return 1;`,
        concurrency: 1,
      },
      { toolCallId: "c", signal: undefined, branch: [] },
    );
    const f = await ctx.flows(root.id);
    expect(f.workflow[0]?.phases).toEqual([
      { name: "A", run: 0, done: 2, failed: 0, queued: 0 },
    ]);
  });

  test("工作流 agent 的状态归并：在跑算 run，异常结束与被停止都算失败；没有阶段的名字为 null", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    const job = ctx.jobs.register(root.id, {
      kind: "tool",
      name: "workflow_run",
      label: "手摆的",
    });
    const run = { id: job.id, phase: null };
    const idle = await ctx.mkChild(root.id, 1, "在跑", run);
    const ok = await ctx.mkChild(root.id, 1, "好", run);
    const bad = await ctx.mkChild(root.id, 1, "坏", run);
    const stopped = await ctx.mkChild(root.id, 1, "停", run);
    ctx.subagents.finish(ok, "done", "好了");
    ctx.subagents.finish(bad, "failed", "boom");
    ctx.subagents.finish(stopped, "interrupted", null);
    const f = await ctx.flows(root.id);
    expect(f.workflow).toHaveLength(1);
    expect(f.workflow[0]?.phases).toEqual([
      { name: null, run: 1, done: 1, failed: 2, queued: 0 },
    ]);
    expect(byId(f, idle).run).toEqual({ id: job.id, phase: null });
  });

  test("父子孙两层：整棵子树，带 parentId 与 depth，先父后子", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    const c = await ctx.mkChild(root.id, 1, "子任务");
    const g = await ctx.mkChild(c, 2, "孙任务");
    const f = await ctx.flows(root.id);
    expect(f.executions.map((e) => [e.id, e.parentId, e.depth])).toEqual([
      [c, root.id, 1],
      [g, c, 2],
    ]);
    // 以子为根只看到孙。
    expect((await ctx.flows(c)).executions.map((e) => e.id)).toEqual([g]);
  });

  test("state 映射：running+在跑=run，running+不在跑=idle，终态=done 并给 outcome", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    const idle = await ctx.mkChild(root.id, 1, "idle");
    const ok = await ctx.mkChild(root.id, 1, "ok");
    const failed = await ctx.mkChild(root.id, 1, "failed");
    const stopped = await ctx.mkChild(root.id, 1, "stopped");
    ctx.subagents.finish(ok, "done", "好了");
    ctx.subagents.finish(failed, "failed", "运行失败：boom");
    ctx.subagents.finish(stopped, "interrupted", null);
    // 在跑：让模型慢一点，派发后立刻查。
    stub.mode.delayMs = 300;
    const live = await spawnChild(ctx, root.id, { task: "慢任务" });
    const f = await ctx.flows(root.id);
    // 结束时间：在跑 / 登记在册但没在执行的为 null，终态取子代理落终态的时间
    expect(byId(f, idle).ended).toBeNull();
    expect(byId(f, live.childId).ended).toBeNull();
    for (const id of [ok, failed, stopped])
      expect(byId(f, id).ended).toBe(ctx.subagents.get(id)?.finishedAt);
    expect(byId(f, ok).ended).toEqual(expect.any(String));
    expect(byId(f, idle)).toMatchObject({ state: "idle", outcome: null });
    expect(byId(f, ok)).toMatchObject({
      state: "done",
      outcome: "ok",
      result: "好了",
    });
    expect(byId(f, failed)).toMatchObject({
      state: "done",
      outcome: "failed",
      result: "运行失败：boom",
    });
    expect(byId(f, stopped)).toMatchObject({
      state: "done",
      outcome: "interrupted",
      result: null,
    });
    expect(byId(f, live.childId)).toMatchObject({
      state: "run",
      outcome: null,
    });
    await waitFor(
      () => ctx.subagents.get(live.childId)?.state === "done",
      "慢任务完成",
    );
  });

  test("ctx 取自最近一次调用记录；没有记录时 used=0、win 取模型窗口", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    const withCall = await ctx.mkChild(root.id, 1, "有记录");
    const noCall = await ctx.mkChild(root.id, 1, "无记录");
    const rec = (window: number | null, system: number, out: number) =>
      ctx.calls.record({
        sessionId: withCall,
        runId: "r1",
        trigger: "user",
        toolName: null,
        durationMs: 1,
        tokens: {
          system,
          tools: 20,
          history: 30,
          current: 40,
          out,
          cacheRead: 0,
          cacheWrite: 0,
          estimated: false,
        },
        meta: {
          summary: "x",
          calledTools: [],
          stopReason: "stop",
          model: "m-from-call",
          window,
        },
        msgCount: 1,
        requestJson: "{}",
        responseJson: "{}",
      });
    rec(1000, 1, 1);
    rec(128000, 10, 5); // 最近一次：10+20+30+40+5
    const f = await ctx.flows(root.id);
    expect(byId(f, withCall)).toMatchObject({
      model: "m-from-call",
      ctx: { used: 105, win: 128000 },
    });
    // 无记录：模型窗口取会话当前模型（stub 模型有窗口则为数字，否则 null）。
    const e = byId(f, noCall);
    expect(e.ctx.used).toBe(0);
    expect(e.ctx.win).toBe(ctx.pool.get(noCall)?.runtimeInfo().window ?? null);
    expect(e.model).toBe("stub-model");
    // 与 /usage 的 context.used 同口径。
    expect(ctx.calls.usage(withCall).context?.used).toBe(105);
  });

  test("旧 /topology 保持原样", async () => {
    const ctx = await setup();
    const root = await ctx.pool.create();
    const c = await ctx.mkChild(root.id, 1, "子任务");
    const res = await ctx.get("/api/v1/topology");
    const { nodes } = res.json() as { nodes: Array<Record<string, unknown>> };
    expect(nodes.map((n) => Object.keys(n).sort())).toEqual([
      expect.arrayContaining(["id", "parentId", "depth", "state", "task"]),
      expect.arrayContaining(["id", "parentId", "depth", "state", "task"]),
    ]);
    expect(nodes.find((n) => n.id === c)).toMatchObject({
      parentId: root.id,
      depth: 1,
      state: "running",
    });
  });
});

describe("logOf", () => {
  const assistant = (text: string, tools: string[] = []): ChatEntry => ({
    index: 0,
    role: "assistant",
    text,
    blocks: [
      ...tools.map((args, i) => ({
        type: "tool" as const,
        id: `t${i}`,
        name: "bash",
        args,
      })),
      { type: "text" as const, text },
    ],
  });

  test("每条文本截断到 200 字，参数 JSON 取第一个字符串值", () => {
    const long = "x".repeat(500);
    const log = logOf([
      assistant(long, [JSON.stringify({ command: long, cwd: "/" })]),
    ]);
    expect(log).toHaveLength(2);
    for (const l of log) expect(l.text.length).toBeLessThanOrEqual(201);
    expect(log[0]?.text.startsWith("xxx")).toBe(true);
    expect(log[0]).toMatchObject({ kind: "tool", name: "bash" });
    expect(log[1]?.kind).toBe("note");
  });

  test("最多 50 条，保留最近的", () => {
    const history = Array.from({ length: 80 }, (_, i) => assistant(`n${i}`));
    const log = logOf(history);
    expect(log).toHaveLength(50);
    expect(log[0]?.text).toBe("n30");
    expect(log.at(-1)?.text).toBe("n79");
  });

  test("用户消息不进日志；没有 blocks 的纯文本助手消息算 note", () => {
    const log = logOf([
      { index: 0, role: "user", text: "任务" },
      { index: 1, role: "assistant", text: "纯文本" },
    ]);
    expect(log).toEqual([{ kind: "note", text: "纯文本" }]);
  });
});

describe("flows.updated 事件", () => {
  const changed = (c: ReturnType<typeof collector>): Frame[] =>
    c.frames.filter((f) => f.type === "flows.updated");

  test("只发给祖先会话的订阅者，只含变化的执行体 id；快照不带 flows", async () => {
    const ctx = await setup();
    const root = ctx.pool.get((await ctx.pool.create()).id);
    const other = ctx.pool.get((await ctx.pool.create()).id);
    if (!root || !other) throw new Error("no entry");
    const rc = collector();
    const oc = collector();
    root.subscribe(rc);
    other.subscribe(oc);
    const r = await spawnChild(ctx, root.id, { task: "读文件并返回结论" });
    await waitFor(
      () => ctx.subagents.get(r.childId)?.state === "done",
      "子完成",
    );
    // 派发一次、终态一次，且都只带这一个 id。
    expect(changed(rc).map((f) => f.data)).toEqual([
      { changed: [r.childId] },
      { changed: [r.childId] },
    ]);
    expect(changed(oc)).toEqual([]);
    expect(Object.keys(rc.frames[0]?.data ?? {})).not.toContain("flows");
    // 序号连续：事件和普通事件一样占 seq。
    const seqs = rc.frames.map((f) => f.seq);
    for (let i = 1; i < seqs.length; i++)
      expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
  });

  test("停掉运行中的子：先后收到派发与停止两次通知，流里 outcome=interrupted", async () => {
    const ctx = await setup();
    stub.mode.delayMs = 300;
    const root = ctx.pool.get((await ctx.pool.create()).id);
    if (!root) throw new Error("no entry");
    const rc = collector();
    root.subscribe(rc);
    const r = await spawnChild(ctx, root.id, { task: "慢任务" });
    await ctx.jobs.stop(
      root.id,
      ctx.jobs.byRef(r.childId)?.id as string,
      "owner",
    );
    expect(changed(rc).map((f) => f.data)).toEqual([
      { changed: [r.childId] },
      { changed: [r.childId] },
    ]);
    expect(byId(await ctx.flows(root.id), r.childId)).toMatchObject({
      state: "done",
      outcome: "interrupted",
    });
  });

  test("孙的状态变化通知它的父和祖父，不通知孙自己", async () => {
    const ctx = await setup();
    const root = ctx.pool.get((await ctx.pool.create()).id);
    if (!root) throw new Error("no entry");
    const c = await ctx.mkChild(root.id, 1, "子");
    stub.mode.delayMs = 500;
    const g = (await spawnChild(ctx, c, { task: "孙" })).childId;
    const child = ctx.pool.get(c);
    const grand = ctx.pool.get(g);
    if (!child || !grand) throw new Error("no entry");
    const rc = collector();
    const cc = collector();
    const gc = collector();
    root.subscribe(rc);
    child.subscribe(cc);
    grand.subscribe(gc);
    ctx.rt.runEnded(grand, { aborted: false, error: "boom", text: "" });
    expect(changed(rc).map((f) => f.data)).toEqual([{ changed: [g] }]);
    expect(changed(cc).map((f) => f.data)).toEqual([{ changed: [g] }]);
    expect(changed(gc)).toEqual([]);
    const f = await ctx.flows(root.id);
    expect(byId(f, g)).toMatchObject({ outcome: "failed" });
    expect(byId(f, g).result).toContain("boom");
    // 终态已落，重复结束不再通知。
    ctx.rt.runEnded(grand, { aborted: false, error: undefined, text: "x" });
    expect(changed(rc)).toHaveLength(1);
  });
});
