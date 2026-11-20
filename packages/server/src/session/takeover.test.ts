import { afterAll, afterEach, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testPool,
} from "../../test/support/stub.js";
import { HEAD_TYPE, REBUILD_TYPE, readHead } from "./frozen.js";
import type { SessionPool } from "./pool.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let pool: SessionPool;
let data: TestData;
afterEach(() => {
  pool?.dispose();
  data?.close();
  stub.requests.length = 0;
});

type Tool = { function: { name: string; description: string } };
const toolDesc = (name: string): string | undefined =>
  (stub.requests.at(-1)?.body as { tools?: Tool[] } | undefined)?.tools?.find(
    (t) => t.function.name === name,
  )?.function.description;

test("冻结物：首个请求冻结并落盘，改描述覆盖不动前缀，重建标记后才换新", async () => {
  const overrides: Record<string, string> = { todo_write: "V1" };
  const t = testPool(stubSessionFactory(stub), undefined, {
    toolDescriptions: {
      recordOriginals: () => {},
      all: () =>
        Object.entries(overrides).map(([name, description]) => ({
          name,
          description,
        })),
    } as never,
  });
  pool = t.pool;
  data = t.data;
  const id = (await pool.create()).id;
  const entry = pool.get(id);
  if (!entry) throw new Error("会话不存在");
  const run = async (text: string) => {
    const c = collector();
    entry.subscribe(c);
    entry.send(text);
    await waitFor(() => c.types().includes("run.ended"), "run.ended");
  };
  const branch = () => entry.sessionManager.getBranch();

  await run("a");
  expect(toolDesc("todo_write")).toBe("V1");
  expect(branch().filter((e) => e.type === "custom")).toHaveLength(1);
  expect(readHead(branch()).stale).toBe(false);

  // 覆盖改了，前缀不动，也不再追加冻结物
  overrides.todo_write = "V2";
  await run("b");
  expect(toolDesc("todo_write")).toBe("V1");
  expect(branch().filter((e) => e.type === "custom")).toHaveLength(1);

  // 重建标记：下一次请求重新冻结
  entry.sessionManager.appendCustomEntry(REBUILD_TYPE, {});
  expect(readHead(branch()).stale).toBe(true);
  await run("c");
  expect(toolDesc("todo_write")).toBe("V2");
  expect(
    branch().filter((e) => e.type === "custom" && e.customType === HEAD_TYPE),
  ).toHaveLength(2);
});

test("重启后从会话文件读回冻结物，前缀不变", async () => {
  const overrides: Record<string, string> = { todo_write: "V1" };
  const extra = {
    toolDescriptions: {
      recordOriginals: () => {},
      all: () =>
        Object.entries(overrides).map(([name, description]) => ({
          name,
          description,
        })),
    } as never,
  };
  const t = testPool(stubSessionFactory(stub), undefined, extra);
  pool = t.pool;
  data = t.data;
  const id = (await pool.create()).id;
  const first = pool.get(id);
  if (!first) throw new Error("会话不存在");
  const c = collector();
  first.subscribe(c);
  first.send("a");
  await waitFor(() => c.types().includes("run.ended"), "run.ended");
  expect(toolDesc("todo_write")).toBe("V1");

  // 换一个新池（模拟服务重启）：覆盖已变，但冻结物在会话文件里
  pool.dispose();
  overrides.todo_write = "V2";
  pool = testPool(stubSessionFactory(stub), data, extra).pool;
  const again = await pool.acquire(id);
  if (!again) throw new Error("会话没有读回");
  const c2 = collector();
  again.subscribe(c2);
  again.send("b");
  await waitFor(() => c2.types().includes("run.ended"), "run.ended");
  expect(toolDesc("todo_write")).toBe("V1");
});

test("fork 沿用分叉点处的冻结物：父会话之后改了描述覆盖，分叉出的会话前缀不变", async () => {
  const overrides: Record<string, string> = { todo_write: "V1" };
  const t = testPool(stubSessionFactory(stub), undefined, {
    toolDescriptions: {
      recordOriginals: () => {},
      all: () =>
        Object.entries(overrides).map(([name, description]) => ({
          name,
          description,
        })),
    } as never,
  });
  pool = t.pool;
  data = t.data;
  const id = (await pool.create()).id;
  const parent = pool.get(id);
  if (!parent) throw new Error("会话不存在");
  const c = collector();
  parent.subscribe(c);
  parent.send("a");
  await waitFor(() => c.types().includes("run.ended"), "run.ended");
  const reply = parent.sessionManager
    .getBranch()
    .find((e) => e.type === "message" && e.message.role === "assistant");
  if (!reply) throw new Error("没有助手回复");

  // 覆盖之后才分叉；分叉点之前的冻结物仍是 V1
  overrides.todo_write = "V2";
  const forked = await pool.fork(id, reply.id, "分支");
  const child = await pool.acquire(forked.id);
  if (!child) throw new Error("分叉会话没有读回");
  const c2 = collector();
  child.subscribe(c2);
  child.send("b");
  await waitFor(() => c2.types().includes("run.ended"), "run.ended");
  expect(toolDesc("todo_write")).toBe("V1");
});
