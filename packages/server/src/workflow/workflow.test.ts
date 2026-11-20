import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import {
  isChild,
  type Msg,
  spawnChild,
  subagentWorld,
  textOf,
  type World,
} from "../../test/support/subagents.js";
import { WORKFLOW_AGENT } from "../job/messages.js";
import { WORKFLOW_LIMITS } from "./runtime.js";

type Body = Record<string, unknown>;
const plain = (c: unknown): string =>
  Array.isArray(c)
    ? c.map((p) => (p as { text?: string }).text ?? "").join("")
    : textOf(c);
const lastOf = (body: Body) => ((body.messages ?? []) as Msg[]).at(-1);

// 子代理：任务是开场消息里 "Task:" 之后的全部文字。含 FAIL 的只说话不交付（被催 3 次后记为未交付）；
// 含 BADJSON 的交付一个不符合 schema 的 JSON；带 schema 的任务交付 {"n":1}；其余交付「done:任务」。
let peak = 0;
const taskOf = (body: Body): string => {
  const first = ((body.messages ?? []) as Msg[]).find((m) => m.role === "user");
  return plain(first?.content).split("\nTask:\n")[1] ?? "";
};
const defaultChild = (task: string, body: Body): StubReply => {
  if (lastOf(body)?.role === "tool") return "finished";
  if (task.includes("FAIL")) return "I will not deliver";
  if (task.includes("BADJSON"))
    return { tool: "deliver", args: { summary: '{"n":"not a number"}' } };
  if (task.includes("JSON Schema"))
    return { tool: "deliver", args: { summary: '{"n":1}' } };
  return { tool: "deliver", args: { summary: `done:${task.split("\n")[0]}` } };
};
const CHILD: { reply: (task: string, body: Body) => StubReply } = {
  reply: defaultChild,
};
const LEAD: { reply: (body: Body) => StubReply } = { reply: () => "ack" };

const stub = await startStub((_n, body) => {
  if (isChild(body)) return CHILD.reply(taskOf(body), body);
  return LEAD.reply(body);
});
afterAll(() => stub.close());

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0).reverse()) await w.close();
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
  CHILD.reply = defaultChild;
  LEAD.reply = () => "ack";
  peak = 0;
});

function setup(o: Parameters<typeof subagentWorld>[1] = {}) {
  const w = subagentWorld(stub, o);
  worlds.push(w);
  return w;
}
const call = { toolCallId: "c", signal: undefined, branch: [] };

async function lead(w: World) {
  const e = w.pool.get((await w.pool.create()).id);
  if (!e) throw new Error("no entry");
  return e;
}
const runJob = (w: World, leadId: string) =>
  w.jobs.list(leadId).find((j) => j.name === "workflow_run");
const log = (w: World, id: string) => w.jobs.tail(id, 200);

describe("脚本调度子代理", () => {
  test("并行：结果有序，同时在跑的不超过 concurrency；进度写进任务日志", async () => {
    const w = setup({ limits: { maxDepth: 3, perCaller: 10, perTree: 50 } });
    stub.mode.delayMs = 80;
    const e = await lead(w);
    // 每次有子代理请求到达，记下此刻在跑的子代理数（工作流的 agent 不计入存活计数，直接数登记行）
    const inFlight = () =>
      w.subagents.children(e.id).filter((c) => c.state === "running").length;
    const sample = setInterval(() => {
      const n = inFlight();
      if (n > peak) peak = n;
    }, 5);
    const r = await w.workflowRt.run(
      e.id,
      {
        script: `phase("go"); const r = await parallel(args.map((n) => () => agent("work " + n, { label: "w" + n }))); log("count " + r.length); return r;`,
        args: [1, 2, 3, 4, 5],
        concurrency: 2,
      },
      call,
    );
    clearInterval(sample);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("Workflow finished (agents: 5 started, 0 failed)");
    expect(r.text).toContain(
      '["done:work 1","done:work 2","done:work 3","done:work 4","done:work 5"]',
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);

    const job = runJob(w, e.id);
    expect(job).toMatchObject({ kind: "tool", state: "done" });
    const text = log(w, job?.id as string);
    expect(text).toContain("== go");
    expect(text).toContain("#1 [go] started: w1");
    expect(text).toContain("#5 [go] done");
    expect(text).toContain("log: count 5");
    // 5 个子代理都登记成 workflow_agent，挂在调用方名下
    const agents = w.jobs.list(e.id).filter((j) => j.name === WORKFLOW_AGENT);
    expect(agents).toHaveLength(5);
    expect(agents.every((j) => j.state === "done" && j.told)).toBe(true);
    expect(w.subagents.children(e.id)).toHaveLength(5);
  });

  test("失败的 agent 是 null，脚本自己处理；统计里算失败", async () => {
    const w = setup();
    const e = await lead(w);
    const r = await w.workflowRt.run(
      e.id,
      {
        script: `const r = await parallel(["ok 1", "FAIL 2", "ok 3"].map((p) => () => agent(p))); return { r, failed: r.filter((x) => x === null).length };`,
      },
      call,
    );
    expect(r.text).toContain("agents: 3 started, 1 failed");
    expect(r.text).toContain('"failed":1');
    expect(r.text).toContain('"r":["done:ok 1",null,"done:ok 3"]');
    expect(log(w, runJob(w, e.id)?.id as string)).toContain(
      "#2 failed: finished without delivering",
    );
  });

  test("pipeline：每个条目依次穿过各阶段，后一阶段拿到前一阶段的结果", async () => {
    const w = setup();
    const e = await lead(w);
    const r = await w.workflowRt.run(
      e.id,
      {
        script: `return await pipeline(args, (x) => agent("first " + x), (prev, x) => agent("second " + prev + " / " + x));`,
        args: ["a", "b"],
      },
      call,
    );
    expect(r.text).toContain(
      '["done:second done:first a / a","done:second done:first b / b"]',
    );
  });

  test("agent 选项 schema：符合的返回解析后的对象，不符合的是 null；不支持的 schema 整个运行失败", async () => {
    const w = setup();
    const e = await lead(w);
    const schema = `{ type: "object", properties: { n: { type: "number" } }, required: ["n"] }`;
    const r = await w.workflowRt.run(
      e.id,
      {
        script: `const s = ${schema}; return [await agent("count", { schema: s }), await agent("BADJSON", { schema: s })];`,
      },
      call,
    );
    expect(r.text).toContain('[{"n":1},null]');
    const bad = await w.workflowRt.run(
      e.id,
      { script: `return await agent("x", { schema: { type: "bogus" } });` },
      call,
    );
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("a workflow hook was used wrongly");
    expect(bad.text).toContain("unsupported schema");
  });
});

describe("错误纪律与上限", () => {
  test("用错钩子（未知选项、不存在的 Agent）整个运行失败，即使脚本 catch；之后不再启动 agent", async () => {
    const w = setup();
    const e = await lead(w);
    const unknown = await w.workflowRt.run(
      e.id,
      {
        script: `try { await agent("x", { nope: 1 }); } catch {} return await agent("never");`,
      },
      call,
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('unknown option "nope"');
    const missing = await w.workflowRt.run(
      e.id,
      { script: `return await agent("x", { agent: "不存在的 Agent" });` },
      call,
    );
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("a workflow hook was used wrongly");
    expect(w.subagents.children(e.id)).toHaveLength(0);
    expect(runJob(w, e.id)?.state).toBe("failed");
  });

  test("一次运行启动的 agent 总数有上限，超了整个运行失败", async () => {
    const w = setup({ workflowTotalMax: 3 });
    const e = await lead(w);
    const r = await w.workflowRt.run(
      e.id,
      {
        script: `const out = []; for (let i = 0; i < 5; i++) out.push(await agent("n" + i)); return out;`,
      },
      call,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("already started 3 agents");
    expect(w.subagents.children(e.id)).toHaveLength(3);
  });

  test("参数校验：空脚本、过长的脚本、非法并发", async () => {
    const w = setup();
    const e = await lead(w);
    await expect(
      w.workflowRt.run(e.id, { script: "  " }, call),
    ).rejects.toThrow(/cannot be empty/);
    await expect(
      w.workflowRt.run(e.id, { script: "x".repeat(100_001) }, call),
    ).rejects.toThrow(/longer than/);
    await expect(
      w.workflowRt.run(e.id, { script: "return 1", concurrency: 0 }, call),
    ).rejects.toThrow(/positive integer/);
  });

  test("并发数不再受存活上限约束：perCaller 为 1 时并发 3 仍能同时跑 3 个", async () => {
    const w = setup({ limits: { maxDepth: 3, perCaller: 1, perTree: 50 } });
    stub.mode.delayMs = 60;
    const e = await lead(w);
    // 用任务表里在跑的 workflow_agent 数取同时在飞数：它们不计入存活计数
    const inFlight = () =>
      w.jobs
        .list(e.id)
        .filter((j) => j.name === WORKFLOW_AGENT && j.state === "running")
        .length;
    const sample = setInterval(() => {
      peak = Math.max(peak, inFlight());
    }, 5);
    const r = await w.workflowRt.run(
      e.id,
      {
        script: `return (await parallel(args.map((n) => () => agent("w" + n)))).length;`,
        args: [1, 2, 3, 4, 5, 6],
        concurrency: 3,
      },
      call,
    );
    clearInterval(sample);
    expect(r.text).toContain("agents: 6 started, 0 failed");
    expect(peak).toBe(3);
  });

  test("concurrency 超过 50 按 50 取，而不是按请求值", async () => {
    // 总数上限缩到 52：剩下的 2 个要排在后面，上限要是按请求值取就一次性全放进去
    const w = setup({ workflowTotalMax: 52 });
    stub.mode.delayMs = 60;
    const e = await lead(w);
    const inFlight = () =>
      w.jobs
        .list(e.id)
        .filter((j) => j.name === WORKFLOW_AGENT && j.state === "running")
        .length;
    const sample = setInterval(() => {
      peak = Math.max(peak, inFlight());
    }, 5);
    const r = await w.workflowRt.run(
      e.id,
      {
        script: `return (await parallel(args.map((n) => () => agent("w" + n)))).length;`,
        args: Array.from({ length: 52 }, (_, i) => i),
        concurrency: 60,
      },
      call,
    );
    clearInterval(sample);
    expect(r.text).toContain("agents: 52 started, 0 failed");
    expect(peak).toBe(WORKFLOW_LIMITS.concurrencyMax);
  });

  test("工作流运行期间不挤占调用方自己的存活名额", async () => {
    const w = setup({ limits: { maxDepth: 3, perCaller: 2, perTree: 50 } });
    stub.mode.delayMs = 200;
    const e = await lead(w);
    const hog = await spawnChild(w, e.id, { task: "hog" });
    const done = w.workflowRt.run(
      e.id,
      {
        script: `return (await parallel(args.map((n) => () => agent("w" + n)))).filter(Boolean).length;`,
        args: [1, 2, 3],
        concurrency: 3,
      },
      call,
    );
    await waitFor(
      () =>
        w.subagents.children(e.id).filter((c) => c.state === "running")
          .length === 4,
      "三个工作流 agent 与调用方自己的一个子代理同时在跑",
    );
    // 存活计数只认调用方自己那一个，工作流 agent 不算
    expect(w.subagents.runningCount(e.id)).toBe(1);
    expect(w.subagents.aliveInTree(e.id)).toBe(1);
    // 名额还剩一个，调用方自己仍派得出去
    const extra = await spawnChild(w, e.id, { task: "extra" });
    expect(w.subagents.runningCount(e.id)).toBe(2);
    const r = await done;
    expect(r.text).toContain("agents: 3 started, 0 failed");
    expect(r.text).toContain("Result:\n3");
    await Promise.all([hog.done, extra.done]);
  });

  test("深度已满的会话不能跑工作流；提示词超长整个运行失败（英文说明）", async () => {
    const w = setup({ limits: { maxDepth: 1, perCaller: 10, perTree: 50 } });
    const e = await lead(w);
    const child = await spawnChild(w, e.id, { task: "c" });
    await expect(
      w.workflowRt.run(child.childId, { script: "return 1" }, call),
    ).rejects.toThrow(/maximum subagent depth \(1\)/);
    await child.done;
    const long = await w.workflowRt.run(
      e.id,
      { script: `return await agent("x".repeat(20001));` },
      call,
    );
    expect(long.isError).toBe(true);
    expect(long.text).toContain("the limit is 20000");
    expect(long.text).toContain("agents: 0 started");
  });

  test("结果很大：落协作区文件，只回传地址和开头", async () => {
    const w = setup();
    const e = await lead(w);
    const r = await w.workflowRt.run(
      e.id,
      { script: `return "x".repeat(30000);` },
      call,
    );
    const m = /path="([^"]+result\.json)"/.exec(r.text);
    expect(m).not.toBeNull();
    const runId = runJob(w, e.id)?.id as string;
    expect(m?.[1]).toBe(`/${runId}/result.json`);
    const file = path.join(w.collab.ownDir(e.id, runId), "result.json");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").length).toBe(30002);
  });
});

describe("停止与任务", () => {
  test("job_stop 停整次运行：脚本结束，还在跑的子代理一并停；之后不再启动新的", async () => {
    const w = setup();
    stub.mode.delayMs = 400;
    const e = await lead(w);
    const done = w.workflowRt.run(
      e.id,
      {
        script: `return await parallel(args.map((n) => () => agent("slow " + n)));`,
        args: [1, 2, 3],
      },
      call,
    );
    await waitFor(
      () =>
        w.subagents.children(e.id).filter((c) => c.state === "running")
          .length === 3,
      "三个子代理在跑",
    );
    const job = runJob(w, e.id);
    await w.jobs.stop(e.id, job?.id as string, "user");
    const r = await done;
    expect(r.isError).toBe(true);
    expect(r.text).toContain("The workflow was stopped");
    await waitFor(
      () => w.subagents.children(e.id).every((c) => c.state !== "running"),
      "子代理都停了",
    );
    expect(w.jobs.get(job?.id as string)?.state).toBe("stopped");
    expect(w.subagents.children(e.id)).toHaveLength(3);
  });

  test("模型调用 workflow_run：结果回到模型手里；job_list 里没有 agent，对 agent 用 job_stop 被拒", async () => {
    const w = setup();
    // 完全允许档：不加这一步，workflow_run 会等人工批准而卡住
    w.data.defaults.setPermissionTier("full");
    const e = await lead(w);
    let step = 0;
    LEAD.reply = (body) => {
      const t = plain(lastOf(body)?.content);
      if (lastOf(body)?.role !== "tool") {
        step = 0;
        return {
          tool: "workflow_run",
          args: {
            script: `return await parallel(["a","b"].map((p) => () => agent(p)));`,
          },
        };
      }
      step++;
      if (step === 1) return { tool: "job_list", args: {} };
      if (step === 2) {
        const child = w.jobs.list(e.id).find((j) => j.name === WORKFLOW_AGENT);
        return { tool: "job_stop", args: { id: child?.id ?? "x" } };
      }
      return t ? "ack" : "ack";
    };
    e.send("go");
    await waitFor(
      () => stub.requests.filter((r) => !isChild(r.body)).length >= 4,
      "lead 走完四步",
      20_000,
    );
    const results = stub.requests
      .filter((r) => !isChild(r.body))
      .flatMap((r) => (r.body.messages ?? []) as Msg[])
      .filter((m) => m.role === "tool")
      .map((m) => plain(m.content));
    expect(
      results.some((t) =>
        t.includes("Workflow finished (agents: 2 started, 0 failed)"),
      ),
    ).toBe(true);
    // job_list：只有 workflow_run 那一行
    const list = results.find((t) => t.includes("workflow_run |")) ?? "";
    expect(list).toContain("workflow_run");
    expect(list).not.toContain(WORKFLOW_AGENT);
    expect(
      results.some((t) => t.includes("agent started by a workflow run")),
    ).toBe(true);
  });

  test("job_start 包着 workflow_run：立即返回任务 id，完成时回调给调用方", async () => {
    const w = setup();
    // 完全允许档：内层调用同样要过 workflow_run 的审批，否则卡在批准上
    w.data.defaults.setPermissionTier("full");
    stub.mode.delayMs = 500;
    const e = await lead(w);
    LEAD.reply = (body) => {
      const last = lastOf(body);
      const t = plain(last?.content);
      if (t.includes("[Workflow ")) return "got the callback";
      if (last?.role === "tool") return "started";
      return {
        tool: "job_start",
        args: {
          name: "workflow_run",
          arguments: { script: `return await agent("bg");` },
        },
      };
    };
    e.send("go");
    await waitFor(
      () =>
        stub.requests.some((r) =>
          JSON.stringify(r.body).includes("[Workflow "),
        ),
      "回调到达",
      20_000,
    );
    const callback = stub.requests
      .filter((r) => !isChild(r.body))
      .flatMap((r) => (r.body.messages ?? []) as Msg[])
      .map((m) => plain(m.content))
      .find((t) => t.includes("[Workflow "));
    expect(callback).toMatch(/^\[Workflow \w+ finished\]/);
    expect(callback).toContain(
      "Workflow finished (agents: 1 started, 0 failed)",
    );
    expect(callback).toContain("done:bg");
    expect(
      w.jobs.list(e.id).filter((j) => j.name === "workflow_run"),
    ).toHaveLength(1);
  });

  test("job_start 包着 workflow_run：内层调用走同一个人工审批，拒绝后不启动任何 agent", async () => {
    const w = setup();
    const e = await lead(w);
    const c = collector();
    e.subscribe(c);
    LEAD.reply = (body) => {
      if (lastOf(body)?.role === "tool") return "ack";
      return {
        tool: "job_start",
        args: {
          name: "workflow_run",
          arguments: { script: `return await agent("bg");` },
        },
      };
    };
    e.send("go");
    const prompts = () => c.frames.filter((f) => f.type === "prompt.requested");
    await waitFor(() => prompts().length > 0, "内层调用的审批弹窗", 8000);
    expect(prompts()[0]?.data.title).toBe("允许运行工作流？");
    e.answerPrompt(prompts()[0]?.data.promptId, { optionId: "deny" });
    await waitFor(() => c.types().includes("run.ended"), "run.ended", 8000);
    expect(
      w.jobs.list(e.id).filter((j) => j.name === WORKFLOW_AGENT),
    ).toHaveLength(0);
    const results = stub.requests
      .filter((r) => !isChild(r.body))
      .flatMap((r) => (r.body.messages ?? []) as Msg[])
      .filter((m) => m.role === "tool")
      .map((m) => plain(m.content));
    expect(results.some((t) => t.includes("用户拒绝了这次运行"))).toBe(true);
  });
});
