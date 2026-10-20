import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { SEED_AGENTS } from "../prompt/seeds.js";
import { AgentStore } from "../store/agents.js";
import { SubagentStore } from "../store/subagents.js";
import { SubagentRuntime } from "../subagent/runtime.js";
import { type TopologyNode, topologyApi } from "./topology.js";

// 所有请求（父与子）都回一句话：子很快完成，父被结果唤醒后也很快跑完。
const stub = await startStub(() => "ok");
afterAll(() => stub.close());

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  stub.requests.length = 0;
});

async function setup() {
  const data = testData();
  const agents = new AgentStore(data.db);
  agents.seed(SEED_AGENTS);
  const subagents = new SubagentStore(data.db);
  const t = testPool(stubSessionFactory(stub, {}, false), data, {
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
  const app: FastifyInstance = Fastify();
  app.register(topologyApi, { pool: t.pool, subagents });
  await app.ready();
  cleanups.push(
    () => app.close(),
    () => t.pool.dispose(),
    () => data.close(true),
  );
  const topology = async () =>
    (await app.inject({ method: "GET", url: "/api/v1/topology" })).json() as {
      nodes: TopologyNode[];
    };
  return { pool: t.pool, rt, subagents, topology };
}

// 派发一个子并等到子落终态、父被唤醒的那一轮跑完。
async function spawnAndSettle(ctx: Awaited<ReturnType<typeof setup>>) {
  const { pool, rt, subagents } = ctx;
  const root = pool.get((await pool.create()).id);
  if (!root) throw new Error("no entry");
  const c = collector();
  root.subscribe(c);
  const r = await rt.spawn(root.id, { task: "读文件并返回暗号" });
  await waitFor(() => subagents.get(r.childId)?.state === "done", "子完成");
  await waitFor(() => c.types().includes("run.ended"), "父被唤醒并跑完");
  return { root, childId: r.childId };
}

describe("GET /api/v1/topology", () => {
  test("没有父子关系的普通会话不进图", async () => {
    const ctx = await setup();
    await ctx.pool.create();
    await ctx.pool.create();
    expect((await ctx.topology()).nodes).toEqual([]);
  });

  test("父与子都成为节点，边由 parentId 表达", async () => {
    const ctx = await setup();
    const { root, childId } = await spawnAndSettle(ctx);
    const { nodes } = await ctx.topology();
    expect(nodes).toHaveLength(2);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(root.id)).toMatchObject({
      parentId: null,
      depth: 0,
      state: "idle",
      task: null,
      denied: 0,
    });
    expect(byId.get(childId)).toMatchObject({
      parentId: root.id,
      depth: 1,
      state: "done",
      task: "读文件并返回暗号",
      denied: 0,
    });
  });

  test("子会话被拒的次数与原因随节点返回", async () => {
    const ctx = await setup();
    const { childId } = await spawnAndSettle(ctx);
    ctx.subagents.addDenial(childId, "sudo -s 需要人工批准", 3);
    ctx.subagents.addDenial(childId, "写 /etc/hosts 不在规则内", 3);
    const node = (await ctx.topology()).nodes.find((n) => n.id === childId);
    expect(node?.denied).toBe(2);
    expect(node?.deniedReasons).toEqual([
      "sudo -s 需要人工批准",
      "写 /etc/hosts 不在规则内",
    ]);
  });

  test("父会话被删除后，子按根处理且孤儿父不出现", async () => {
    const ctx = await setup();
    const { root, childId } = await spawnAndSettle(ctx);
    expect(await ctx.pool.remove(root.id)).toBe("ok");
    const { nodes } = await ctx.topology();
    expect(nodes.map((n) => n.id)).toEqual([childId]);
    expect(nodes[0]?.parentId).toBeNull();
  });
});
