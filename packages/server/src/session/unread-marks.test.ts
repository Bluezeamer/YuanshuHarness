import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { SubagentStore } from "../store/subagents.js";
import { SessionLibrary } from "./library.js";
import type { SessionPool } from "./pool.js";
import { SessionFeed } from "./session-feed.js";

const stub = await startStub(() => "好的");
afterAll(() => stub.close());

let pool: SessionPool | undefined;
let data: TestData | undefined;

afterEach(() => {
  pool?.dispose();
  pool = undefined;
  data?.close();
  data = undefined;
  stub.mode.status = 200;
  stub.requests.length = 0;
});

// 池 + 会话库 + 列表流：标记只经 feed（watched）参与判断，视图从会话库读。
function setup() {
  const d = testData();
  const subagents = new SubagentStore(d.db);
  const t = testPool(stubSessionFactory(stub), d, { subagents });
  pool = t.pool;
  data = t.data;
  const library = new SessionLibrary(pool);
  const feed = new SessionFeed({
    list: () => library.list(),
    view: (id) => library.get(id),
    topOf: (id) => subagents.rootOf(id),
    isListed: (id) => !pool?.isChild(id),
    clearMarks: (id) => d.store.clearMarks(id),
  });
  pool.attachFeed(feed);
  return { pool, data: t.data, subagents, library, feed };
}

const ended = (c: ReturnType<typeof collector>) => () =>
  c.types().includes("run.ended");

async function run(id: string) {
  const e = pool?.get(id);
  if (!e) throw new Error("会话不在池里");
  const c = collector();
  e.subscribe(c);
  e.send("go");
  await waitFor(ended(c), "run.ended");
  return c;
}

const marks = (library: SessionLibrary, id: string) => {
  const v = library.get(id);
  if (!v) throw new Error("视图不存在");
  return { result: v.unreadResult, error: v.unreadError };
};

describe("未读标记", () => {
  test("一轮正常结束且没人在看：标「新结果」", async () => {
    const { pool, library } = setup();
    const id = (await pool.create()).id;
    expect(marks(library, id)).toEqual({ result: false, error: false });
    await run(id);
    expect(marks(library, id)).toEqual({ result: true, error: false });
  });

  test("有人在看：不标；开始看之后标记被清空", async () => {
    const { pool, library, feed } = setup();
    const id = (await pool.create()).id;
    await run(id);
    expect(marks(library, id).result).toBe(true);
    feed.setViewing("c1", [id]);
    expect(marks(library, id)).toEqual({ result: false, error: false });

    // 看着的时候再跑一轮：不标
    await run(id);
    expect(marks(library, id)).toEqual({ result: false, error: false });
  });

  test("一轮失败结束：标「出错」，与「新结果」叠加", async () => {
    const { pool, library } = setup();
    const id = (await pool.create()).id;
    await run(id);
    stub.mode.status = 500;
    await run(id);
    expect(marks(library, id)).toEqual({ result: true, error: true });
  });

  test("用户主动中止：两个都不标", async () => {
    const { pool, library } = setup();
    const id = (await pool.create()).id;
    const e = pool.get(id);
    if (!e) throw new Error("会话不在池里");
    const c = collector();
    e.subscribe(c);
    stub.mode.delayMs = 500;
    e.send("slow");
    await waitFor(() => c.types().includes("message.started"), "生成中");
    const stopped = e.stop();
    await waitFor(ended(c), "run.ended");
    await stopped;
    expect(marks(library, id)).toEqual({ result: false, error: false });
    stub.mode.delayMs = 0;
  });

  test("子代理会话结束不给它自己标", async () => {
    const { pool, subagents, library } = setup();
    const root = (await pool.create()).id;
    const child = (await pool.create()).id;
    // 把它登记成子代理会话：归父会话管，不进列表、也不配标记。
    subagents.create({
      childId: child,
      parentId: root,
      depth: 1,
      task: "t",
      spec: {
        agentPresetId: "p",
        directoryIds: [],
        primaryDirectoryId: "",
        tierCap: "auto",
      },
    });
    await run(child);
    expect(marks(library, child)).toEqual({ result: false, error: false });
    // 根会话自己没跑过，不应因子的结束而带上标记。
    expect(marks(library, root)).toEqual({ result: false, error: false });
  });
});

// 推送通知的旁路回调：不看有没有人在看，只排除子代理与用户中止。
describe("attachTurnEnded", () => {
  test("正常结束与出错结束各调一次，带 error 标志", async () => {
    const { pool } = setup();
    const seen: { id: string; error: boolean }[] = [];
    pool.attachTurnEnded((id, error) => seen.push({ id, error }));
    const id = (await pool.create()).id;

    await run(id);
    stub.mode.status = 500;
    await run(id);
    expect(seen).toEqual([
      { id, error: false },
      { id, error: true },
    ]);
  });

  test("用户在看着也照样回调，但原有标记行为不变（不标）", async () => {
    const { pool, library, feed } = setup();
    const seen: boolean[] = [];
    pool.attachTurnEnded((_id, error) => seen.push(error));
    const id = (await pool.create()).id;
    feed.setViewing("c1", [id]);

    await run(id);
    expect(seen).toEqual([false]);
    expect(marks(library, id)).toEqual({ result: false, error: false });
  });

  test("用户主动中止与子代理会话不回调", async () => {
    const { pool, subagents } = setup();
    const seen: string[] = [];
    pool.attachTurnEnded((id) => seen.push(id));
    const root = (await pool.create()).id;
    const child = (await pool.create()).id;
    subagents.create({
      childId: child,
      parentId: root,
      depth: 1,
      task: "t",
      spec: {
        agentPresetId: "p",
        directoryIds: [],
        primaryDirectoryId: "",
        tierCap: "auto",
      },
    });
    await run(child);
    expect(seen).toEqual([]);

    const e = pool.get(root);
    if (!e) throw new Error("会话不在池里");
    const c = collector();
    e.subscribe(c);
    stub.mode.delayMs = 500;
    e.send("slow");
    await waitFor(() => c.types().includes("message.started"), "生成中");
    const stopped = e.stop();
    await waitFor(ended(c), "run.ended");
    await stopped;
    stub.mode.delayMs = 0;
    expect(seen).toEqual([]);
  });
});
