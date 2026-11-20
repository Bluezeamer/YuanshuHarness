import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testPool,
} from "../../test/support/stub.js";
import { SessionLibrary, sessionTitle } from "./library.js";
import type { SessionEntry, SessionPool } from "./pool.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let pool: SessionPool | undefined;
let data: TestData | undefined;

afterEach(() => {
  pool?.dispose();
  data?.close();
  pool = undefined;
  data = undefined;
  stub.mode.delayMs = 0;
  stub.mode.status = 200;
  stub.requests.length = 0;
});

function setup() {
  const t = testPool(stubSessionFactory(stub));
  pool = t.pool;
  data = t.data;
  return { w: t.pool, data: t.data, lib: new SessionLibrary(t.pool) };
}

// 换一个池读同一个数据目录：模拟重启，标题只能来自索引行。
function restart(d: TestData): SessionLibrary {
  pool?.dispose();
  const next = testPool(stubSessionFactory(stub), d);
  pool = next.pool;
  return new SessionLibrary(next.pool);
}

const entryOf = (w: SessionPool, id: string): SessionEntry => {
  const e = w.get(id);
  if (!e) throw new Error("会话不在池里");
  return e;
};

async function chat(e: SessionEntry, text: string): Promise<void> {
  const c = collector();
  const unsub = e.subscribe(c);
  e.send(text);
  await waitFor(() => c.types().includes("run.ended"), "run.ended");
  unsub();
}

describe("会话显示名", () => {
  test("无名无消息是「新对话」；有手动名时手动名优先", async () => {
    const { w, lib } = setup();
    const id = (await w.create()).id;
    expect(lib.get(id)?.title).toBe("新对话");
    await w.rename(id, "手动名");
    expect(lib.get(id)?.title).toBe("手动名");
  });

  test("常驻会话发完首条消息后取消息前 48 字；重启读索引行仍是它", async () => {
    const { w, data, lib } = setup();
    const id = (await w.create()).id;
    // 空白折成一个空格、按码点截断，长消息的尾巴不进标题。
    await chat(entryOf(w, id), `修一下  登录 ${"啊".repeat(60)}`);
    const title = `修一下 登录 ${"啊".repeat(41)}`;
    expect([...(lib.get(id)?.title ?? "")]).toHaveLength(48);
    expect(lib.get(id)?.title).toBe(title);
    expect(restart(data).get(id)?.title).toBe(title);
  });

  test("索引行先于首条消息建立：跑一轮后行里的 preview 被更新", async () => {
    const { w, data, lib } = setup();
    const id = (await w.create()).id;
    // 先落索引行（此时还没有消息）。
    await lib.archive(id);
    expect(data.store.get(id)?.preview ?? null).toBeNull();
    await lib.unarchive(id);
    await chat(entryOf(w, id), "补建的标题");
    expect(data.store.get(id)?.preview).toBe("补建的标题");
  });
});

describe("reconcile 补建索引行", () => {
  test("只有 JSONL 的会话补建行时带 preview", async () => {
    const { w, data } = setup();
    const id = (await w.create()).id;
    await chat(entryOf(w, id), "文件里的标题");
    // 删掉索引行，模拟只有文件的会话。
    data.store.remove(id);
    expect(data.store.reconcile(data.sessionDir, () => {})).toMatchObject({
      added: 1,
    });
    expect(data.store.get(id)?.preview).toBe("文件里的标题");
    expect(restart(data).get(id)?.title).toBe("文件里的标题");
  });

  test("非常驻、有文件没索引行的会话被改名时补建行，也带 preview", async () => {
    const { w, data } = setup();
    const id = (await w.create()).id;
    await chat(entryOf(w, id), "补建时的标题");
    data.store.remove(id);
    const next = restart(data);
    if (!pool) throw new Error("池不在");
    await pool.rename(id, "补建后的名字");
    expect(data.store.get(id)?.preview).toBe("补建时的标题");
    expect(next.get(id)?.title).toBe("补建后的名字");
  });
});

describe("sessionTitle：显示名的取法只有一处", () => {
  test("手动名优先，其次首条消息的种子，再没有是「新对话」", () => {
    expect(sessionTitle({ name: "我的名字", preview: "首条消息" })).toBe(
      "我的名字",
    );
    expect(sessionTitle({ name: null, preview: "首条消息" })).toBe("首条消息");
    expect(sessionTitle({ name: null, preview: null })).toBe("新对话");
  });
});
