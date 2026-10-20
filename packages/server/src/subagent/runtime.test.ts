import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  type StubReply,
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { SEED_AGENTS } from "../prompt/seeds.js";
import { AgentStore } from "../store/agents.js";
import { SubagentStore } from "../store/subagents.js";
import { SUBAGENT_LIMITS } from "./limits.js";
import { SubagentRuntime } from "./runtime.js";

const SECRET = "暗号-7f3a";
const BRIEF = "你是父会话派发的子代理";

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : JSON.stringify(c);
type Msg = { role: string; content?: unknown };

// 子会话的第一条用户消息带开场说明；其余请求都来自父。
const isChild = (body: Record<string, unknown>) =>
  ((body.messages ?? []) as Msg[]).some(
    (m) => m.role === "user" && textOf(m.content).includes(BRIEF),
  );

// 父：先 spawn，拿到 childId 后 wait，再复述结果；收到系统通知只回一句话。子：按 CHILD 脚本回复。
const CHILD: { current: (n: number) => StubReply } = { current: () => SECRET };
let childCalls = 0;
const stub = await startStub((_n, body) => {
  if (isChild(body)) return CHILD.current(++childCalls);
  const msgs = (body.messages ?? []) as Msg[];
  const last = msgs[msgs.length - 1];
  const out = textOf(last?.content);
  if (out.includes("[系统通知]")) return "收到通知";
  if (last?.role !== "tool")
    return { tool: "spawn_subagent", args: { task: "读文件并返回暗号" } };
  // 工具结果可能是字符串，也可能是内容块数组（引号被转义），两种都认。
  const m = /childId\\*"\s*:\s*\\*"([0-9a-f-]+)/.exec(out);
  if (m) return { tool: "wait_subagent", args: { ids: [m[1]] } };
  return `got:${out}`;
});
afterAll(() => stub.close());

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
  CHILD.current = () => SECRET;
  childCalls = 0;
});

function setup(builtinTools = false) {
  const data = testData();
  const agents = new AgentStore(data.db);
  agents.seed(SEED_AGENTS);
  const subagents = new SubagentStore(data.db);
  const t = testPool(stubSessionFactory(stub, {}, builtinTools), data, {
    agents,
    subagents,
  });
  const rt = new SubagentRuntime({
    pool: t.pool,
    store: subagents,
    workspaces: data.workspaces,
    agents,
    sessionDir: data.sessionDir,
  });
  t.pool.attachSubagents(rt.hooks());
  cleanups.push(
    () => data.close(true),
    () => t.pool.dispose(),
  );
  return { ...t, data, agents, subagents, rt };
}

const ended =
  (c: ReturnType<typeof collector>, n = 1) =>
  () =>
    c.types().filter((t) => t === "run.ended").length >= n;

describe("spawn / wait", () => {
  test("父派发子，wait 取回子的最终结果", async () => {
    const { pool, subagents } = setup();
    const root = pool.get((await pool.create()).id);
    if (!root) throw new Error("no entry");
    const c = collector();
    root.subscribe(c);
    root.send("去问子代理");
    await waitFor(ended(c), "父运行结束");

    const rows = subagents.list();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.parentId).toBe(root.id);
    expect(row?.depth).toBe(1);
    expect(row?.state).toBe("done");
    expect(row?.result).toBe(SECRET);
    // 结果由 wait 交付，不会再排一条重复通知。
    expect(row?.told).toBe(true);
    const last = stub.requests.at(-1)?.body.messages as Msg[];
    expect(textOf(last.at(-1)?.content)).toContain(SECRET);
    expect(pool.info(row?.childId ?? "")?.running).toBe(false);
  });

  test("没人 wait 时，结果作为一条排队消息唤醒空闲的父", async () => {
    const { pool, rt, subagents } = setup();
    const root = pool.get((await pool.create()).id);
    if (!root) throw new Error("no entry");
    const c = collector();
    root.subscribe(c);
    const r = await rt.spawn(root.id, { task: "读文件并返回暗号" });
    await waitFor(() => subagents.get(r.childId)?.state === "done", "子完成");
    await waitFor(ended(c), "父被唤醒并跑完一轮");
    expect(JSON.stringify(stub.requests.at(-1)?.body)).toContain(SECRET);
    expect(subagents.get(r.childId)?.told).toBe(true);
  });

  test("wait 超时只是停止等待，子继续跑", async () => {
    const { pool, rt, subagents } = setup();
    stub.mode.delayMs = 300;
    const root = pool.get((await pool.create()).id);
    if (!root) throw new Error("no entry");
    const r = await rt.spawn(root.id, { task: "慢任务" });
    const out = await rt.wait(root.id, [r.childId], 20, undefined);
    expect(out).toContain("仍在运行");
    expect(subagents.get(r.childId)?.state).toBe("running");
    await waitFor(() => subagents.get(r.childId)?.state === "done", "子完成");
  });

  test("不能 wait 或中断不是自己派发的会话", async () => {
    const { pool, rt } = setup();
    const a = await pool.create();
    const b = await pool.create();
    const r = await rt.spawn(a.id, { task: "x" });
    await expect(rt.wait(b.id, [r.childId], 10, undefined)).rejects.toThrow(
      "不是你派发的子会话",
    );
    await expect(rt.interrupt(b.id, r.childId)).rejects.toThrow(
      "不是你派发的子会话",
    );
  });
});

describe("上限与约束", () => {
  test("深度上限：达到上限的会话不能再派发", async () => {
    const { pool, rt } = setup();
    stub.mode.delayMs = 200;
    let cur = (await pool.create()).id;
    for (let i = 0; i < SUBAGENT_LIMITS.maxDepth; i++)
      cur = (await rt.spawn(cur, { task: "再往下" })).childId;
    await expect(rt.spawn(cur, { task: "太深" })).rejects.toThrow("深度上限");
  });

  test("单父并发上限；中断一个后可再派发", async () => {
    const { pool, rt } = setup();
    stub.mode.delayMs = 500;
    const root = (await pool.create()).id;
    const ids: string[] = [];
    for (let i = 0; i < SUBAGENT_LIMITS.maxConcurrentPerParent; i++)
      ids.push((await rt.spawn(root, { task: `t${i}` })).childId);
    await expect(rt.spawn(root, { task: "多一个" })).rejects.toThrow("上限");
    await rt.interrupt(root, ids[0] as string);
    await expect(rt.spawn(root, { task: "补一个" })).resolves.toBeDefined();
  });

  test("并行 spawn 不会冲破并发上限", async () => {
    const { pool, rt } = setup();
    stub.mode.delayMs = 500;
    const root = (await pool.create()).id;
    const results = await Promise.allSettled(
      Array.from(
        { length: SUBAGENT_LIMITS.maxConcurrentPerParent + 3 },
        (_, i) => rt.spawn(root, { task: `p${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(
      SUBAGENT_LIMITS.maxConcurrentPerParent,
    );
  });

  test("workspace 必须是父可用的子集", async () => {
    const { pool, rt, data } = setup();
    const root = (await pool.create()).id;
    await expect(
      rt.spawn(root, { task: "x", workspaces: ["不存在"] }),
    ).rejects.toThrow("不在你可用的范围内");
    // 子会话只看得到被派发的那几个：子再派发时不能越过它自己的集合。
    const other = data.workspaces.create("other", data.sessionDir);
    if (!other) throw new Error("workspace 登记失败");
    const child = await rt.spawn(root, { task: "x", workspaces: [] });
    await expect(
      rt.spawn(child.childId, { task: "y", workspaces: [other.id] }),
    ).rejects.toThrow("不在你可用的范围内");
  });

  test("档位上限只收窄：父是 rules，子再要 auto 也还是 rules", async () => {
    const { pool, rt } = setup();
    const root = (await pool.create()).id;
    const a = await rt.spawn(root, { task: "x", tier: "rules" });
    expect(a.tier).toBe("rules");
    const b = await rt.spawn(a.childId, { task: "y", tier: "auto" });
    expect(b.tier).toBe("rules");
  });

  test("plan 模式的父派发出的子也是 plan", async () => {
    const { pool, rt, agents } = setup();
    const plan = agents.create({
      name: "planner",
      description: "",
      promptBlocks: [],
      capabilities: [],
      model: null,
      defaultThinkingLevel: null,
      defaultMode: "plan",
    });
    const root = (await pool.create({ agentId: plan.id })).id;
    const r = await rt.spawn(root, { task: "x", agent: "coder-full" });
    expect(pool.info(r.childId)?.mode).toBe("plan");
  });
});

describe("中断与重启", () => {
  test("interrupt 落 interrupted，且不再通知父", async () => {
    const { pool, rt, subagents } = setup();
    stub.mode.delayMs = 500;
    const root = (await pool.create()).id;
    const r = await rt.spawn(root, { task: "慢" });
    await rt.interrupt(root, r.childId);
    const row = subagents.get(r.childId);
    expect(row?.state).toBe("interrupted");
    expect(row?.told).toBe(true);
    expect(rt.notices(root)).toEqual([]);
  });

  test("父被中断时，运行中的子一并中断，父下次收到提示", async () => {
    const { pool, subagents, rt } = setup();
    stub.mode.delayMs = 500;
    const root = pool.get((await pool.create()).id);
    if (!root) throw new Error("no entry");
    const r = await rt.spawn(root.id, { task: "慢" });
    await root.stop();
    await waitFor(
      () => subagents.get(r.childId)?.state === "interrupted",
      "子被中断",
    );
    const notes = rt.notices(root.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(r.childId);
    expect(rt.notices(root.id)).toEqual([]);
  });

  test("Server 重启：running 的子统一落 interrupted，父收到一次提示", async () => {
    const { data, subagents, agents } = setup();
    subagents.create({
      childId: "c1",
      parentId: "p1",
      depth: 1,
      task: "上个进程里的任务",
      spec: {
        agentId: "a",
        workspaceIds: [],
        tierCap: "auto",
        inheritTools: [],
        modelId: null,
      },
    });
    expect(subagents.get("c1")?.state).toBe("running");
    // 新进程：重新构造运行时。
    const t2 = testPool(stubSessionFactory(stub), data, { agents, subagents });
    cleanups.push(() => t2.pool.dispose());
    const rt2 = new SubagentRuntime({
      pool: t2.pool,
      store: subagents,
      workspaces: data.workspaces,
      agents,
      sessionDir: data.sessionDir,
    });
    expect(subagents.get("c1")?.state).toBe("interrupted");
    expect(rt2.notices("p1")).toHaveLength(1);
    expect(rt2.notices("p1")).toEqual([]);
  });

  test("删除子会话清掉它的父子行，但保留它的子孙行", async () => {
    const { pool, rt, subagents } = setup();
    const root = (await pool.create()).id;
    const a = await rt.spawn(root, { task: "a" });
    await waitFor(() => subagents.get(a.childId)?.state === "done", "a 完成");
    expect(await pool.remove(a.childId)).toBe("ok");
    expect(subagents.get(a.childId)).toBeUndefined();
  });
});

describe("无人值守", () => {
  test("子会话要 root shell：被拒、计入被拒次数与原因，不产生记住规则", async () => {
    const { pool, rt, subagents, data } = setup(true);
    CHILD.current = (n) =>
      n === 1
        ? { tool: "bash", args: { command: "sudo -s" } }
        : "缺少 root 权限";
    const root = (await pool.create()).id;
    const r = await rt.spawn(root, { task: "提权做点事" });
    await waitFor(() => subagents.get(r.childId)?.state === "done", "子完成");
    const row = subagents.get(r.childId);
    expect(row?.denied).toBe(1);
    expect(row?.deniedReasons[0]).toContain("bash");
    expect(row?.result).toBe("缺少 root 权限");
    expect(data.rules.list(root)).toEqual([]);
  });

  test("子会话没有 ask_user", async () => {
    const { pool, rt } = setup();
    const root = (await pool.create()).id;
    await rt.spawn(root, { task: "x" });
    await waitFor(() => stub.requests.some((q) => isChild(q.body)), "子请求");
    const child = stub.requests.find((q) => isChild(q.body));
    const names = (
      (child?.body.tools ?? []) as Array<{
        function: { name: string };
      }>
    ).map((t) => t.function.name);
    expect(names).not.toContain("ask_user");
    expect(names).toContain("spawn_subagent");
  });
});
