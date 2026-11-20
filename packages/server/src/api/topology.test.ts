import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { startStub } from "../../test/support/stub.js";
import { spawnChild, subagentWorld } from "../../test/support/subagents.js";
import { type TopologyNode, topologyApi } from "./topology.js";

// 所有请求（父与子）都回一句话：子没交付，被催几次后按「未显式交付」结束。
const stub = await startStub(() => "ok");
afterAll(() => stub.close());

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  stub.requests.length = 0;
});

async function setup() {
  const w = subagentWorld(stub);
  const app: FastifyInstance = Fastify();
  app.register(topologyApi, { pool: w.pool, subagents: w.subagents });
  await app.ready();
  cleanups.push(
    () => app.close(),
    () => w.close(),
  );
  const topology = async () =>
    (await app.inject({ method: "GET", url: "/api/v1/topology" })).json() as {
      nodes: TopologyNode[];
    };
  return { pool: w.pool, w, rt: w.rt, subagents: w.subagents, topology };
}

// 派发一个子并等到它落终态。
async function spawnAndSettle(ctx: Awaited<ReturnType<typeof setup>>) {
  const { pool } = ctx;
  const root = pool.get((await pool.create()).id);
  if (!root) throw new Error("no entry");
  const r = await spawnChild(ctx.w, root.id, { task: "读文件并返回暗号" });
  await r.done;
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
