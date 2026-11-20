import { afterAll, afterEach, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import {
  isChild,
  spawnChild,
  subagentWorld,
  type World,
} from "../../test/support/subagents.js";
import { SessionLibrary } from "./library.js";

type Body = Record<string, unknown>;
const lastRole = (body: Body) =>
  ((body.messages ?? []) as { role: string }[]).at(-1)?.role;

// 子代理：含 STAY 的任务一直说话、不交付，好让它在观察期间保持 running；其余直接交付。
const stub = await startStub((_n, body) => {
  if (!isChild(body)) return "ack";
  if (lastRole(body) === "tool") return "finished";
  const first = (
    (body.messages ?? []) as { role: string; content?: unknown }[]
  ).find((m) => m.role === "user");
  const text =
    typeof first?.content === "string"
      ? first.content
      : JSON.stringify(first?.content ?? "");
  const out: StubReply = text.includes("STAY")
    ? "still working"
    : { tool: "deliver", args: { summary: "done" } };
  return out;
});
afterAll(() => stub.close());

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0).reverse()) await w.close();
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
});

function setup(o: Parameters<typeof subagentWorld>[1] = {}) {
  const w = subagentWorld(stub, o);
  worlds.push(w);
  return { w, library: new SessionLibrary(w.pool) };
}

const call = { toolCallId: "c", signal: undefined, branch: [] };

test("有待答复弹窗时是 blocked", async () => {
  const { w, library } = setup();
  const id = (await w.pool.create()).id;
  const pending = w.pool.get(id)?.ask({
    source: "question",
    input: "text",
    title: "继续吗",
  });
  expect(library.get(id)?.status).toBe("blocked");
  w.pool.dispose();
  await pending;
});

test("名下有在跑的子代理时根会话是 running，子代理结束后回到 idle", async () => {
  const { w, library } = setup();
  const root = (await w.pool.create()).id;
  expect(library.get(root)?.status).toBe("idle");
  const child = await spawnChild(w, root, { task: "STAY" });
  expect(library.get(root)?.status).toBe("running");
  // 用户在子代理标签里点停止：终态落库后根会话不再有在跑的子代理。
  w.pool.get(child.childId)?.stop();
  await waitFor(
    () => library.get(root)?.status === "idle",
    "子代理结束后根会话回到 idle",
  );
});

test("工作流 agent（不计存活名额）在跑时根会话也是 running", async () => {
  const { w, library } = setup({
    limits: { maxDepth: 3, perCaller: 10, perTree: 50 },
  });
  const root = (await w.pool.create()).id;
  stub.mode.delayMs = 300;
  const done = w.workflowRt.run(
    root,
    {
      script: `return (await parallel(args.map((n) => () => agent("w" + n)))).length;`,
      args: [1, 2],
      concurrency: 2,
    },
    call,
  );
  await waitFor(
    () =>
      w.subagents.children(root).filter((c) => c.state === "running").length ===
      2,
    "两个工作流 agent 在跑",
  );
  // 它们不占存活名额，但状态点仍要脉动
  expect(w.subagents.aliveInTree(root)).toBe(0);
  expect(library.get(root)?.status).toBe("running");
  await done;
  await waitFor(() => library.get(root)?.status === "idle", "回到 idle");
});

test("已归档的会话仍是 archived", async () => {
  const { w, library } = setup();
  const id = (await w.pool.create()).id;
  library.archive(id);
  expect(library.get(id)).toMatchObject({
    status: "archived",
    lifecycle: "archived",
  });
});

test("归档时通知 onArchived；运行中的会话归档被拒绝，也不通知", async () => {
  const w = subagentWorld(stub, {});
  worlds.push(w);
  const archived: string[] = [];
  const library = new SessionLibrary(w.pool, {
    onArchived: (id) => archived.push(id),
  });
  const idle = (await w.pool.create()).id;
  library.archive(idle);
  expect(archived).toEqual([idle]);

  const busy = (await w.pool.create()).id;
  const entry = w.pool.get(busy);
  if (entry) Object.defineProperty(entry, "busy", { get: () => true });
  expect(() => library.archive(busy)).toThrow();
  expect(archived).toEqual([idle]);
});
