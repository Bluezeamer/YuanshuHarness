import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  appendDanglingToolCall,
  persistSession,
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { findSessionFile } from "../store/sessions.js";
import { PoolError, type SessionFactory, type SessionPool } from "./pool.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  stub.mode.delayMs = 0;
  stub.mode.status = 200;
  stub.requests.length = 0;
});

function start(
  dir?: string,
  factory: SessionFactory = stubSessionFactory(stub),
) {
  const t = testPool(factory, testData(dir));
  cleanups.push(() => t.pool.dispose());
  return t as { pool: SessionPool; data: TestData };
}
// “重启”：关闭池与数据库但保留数据目录，再在同一目录上起一个新的池。
function restart(
  t: { pool: SessionPool; data: TestData },
  factory?: SessionFactory,
) {
  t.pool.dispose();
  t.data.close(false);
  const n = start(t.data.dir, factory);
  cleanups.push(() => n.data.close(true));
  return n;
}
const ended =
  (c: ReturnType<typeof collector>, n = 1) =>
  () =>
    c.types().filter((t) => t === "run.ended").length >= n;

async function converse(pool: SessionPool, prompts: string[]) {
  const id = (await pool.create()).id;
  const e = pool.get(id);
  if (!e) throw new Error();
  const c = collector();
  e.subscribe(c);
  for (const [i, p] of prompts.entries()) {
    e.send(p);
    await waitFor(ended(c, i + 1), "run.ended");
  }
  return { id, entry: e };
}

describe("R6/R8/R15 索引与列表", () => {
  test("空会话：列表可见、无文件、无索引行；对话后出现索引且 updatedAt 更新", async () => {
    const t = start();
    cleanups.push(() => t.data.close(true));
    const id = (await t.pool.create()).id;
    const [row] = t.pool.list();
    expect(row).toMatchObject({ id, name: null, running: false });
    expect(t.data.store.get(id)).toBeUndefined();
    expect(readdirSync(t.data.sessionDir)).toEqual([]);
    const e = t.pool.get(id);
    const c = collector();
    e?.subscribe(c);
    e?.send("hello");
    await waitFor(ended(c), "run.ended");
    const idx = t.data.store.get(id);
    expect(idx).toMatchObject({ id, name: null });
    expect((idx?.updatedAt ?? "") >= (idx?.createdAt ?? "z")).toBe(true);
    expect(findSessionFile(t.data.sessionDir, id)).not.toBeNull();
  });

  test("列表按 updatedAt 倒序，包含未持久化会话；条目字段齐全", async () => {
    const t = start();
    cleanups.push(() => t.data.close(true));
    const a = await converse(t.pool, ["a"]);
    await new Promise((r) => setTimeout(r, 5));
    const b = await converse(t.pool, ["b"]);
    const empty = (await t.pool.create()).id;
    const ids = t.pool.list().map((x) => x.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(ids).toContain(empty);
    for (const x of t.pool.list())
      expect(Object.keys(x).sort()).toEqual([
        "createdAt",
        "id",
        "name",
        "running",
        "updatedAt",
      ]);
  });

  test("R8 重启后空会话消失，已持久化的还在", async () => {
    const t = start();
    const kept = await converse(t.pool, ["x"]);
    const empty = (await t.pool.create()).id;
    const n = restart(t);
    n.data.store.reconcile(n.data.sessionDir, () => {});
    const ids = n.pool.list().map((x) => x.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(empty);
  });
});

describe("R9/R10/R11 按需加载与恢复", () => {
  test("重启后列表在、未访问不进池；访问后快照含最近消息，继续对话时历史随请求发出", async () => {
    let calls = 0;
    const counting: SessionFactory = (o) => {
      calls++;
      return stubSessionFactory(stub)(o);
    };
    const t = start(undefined, counting);
    const { id } = await converse(t.pool, ["MARK-first", "second"]);
    const callsBefore = calls;
    const n = restart(t, counting);
    expect(n.pool.list().map((x) => x.id)).toContain(id);
    expect(n.pool.get(id)).toBeUndefined();
    expect(calls).toBe(callsBefore);
    const e = await n.pool.acquire(id);
    expect(e).not.toBeNull();
    expect(calls).toBe(callsBefore + 1);
    const c = collector();
    e?.subscribe(c);
    const snap = c.frames[0];
    expect(snap?.type).toBe("snapshot");
    expect(snap?.seq).toBe(0);
    expect(snap?.data.running).toBe(false);
    expect(
      snap?.data.messages.map((m: { role: string; text: string }) => [
        m.role,
        m.text,
      ]),
    ).toEqual([
      ["user", "MARK-first"],
      ["assistant", "reply-1"],
      ["user", "second"],
      ["assistant", "reply-2"],
    ]);
    stub.requests.length = 0;
    e?.send("third");
    await waitFor(ended(c), "run.ended");
    expect(JSON.stringify(stub.requests[0]?.body)).toContain("MARK-first");
    expect(c.frames[1]?.seq).toBe(1);
    n.data.close(true);
  });

  test("窗口只取最近 50 条", async () => {
    const t = start();
    const dir = t.data.sessionDir;
    const id = "01a14000-0000-7000-8000-0000000000f1";
    await persistSession(
      stub,
      dir,
      id,
      Array.from({ length: 30 }, (_, i) => `q${i}`),
    );
    t.data.store.reconcile(dir, () => {});
    const e = await t.pool.acquire(id);
    const c = collector();
    e?.subscribe(c);
    expect(c.frames[0]?.data.messages).toHaveLength(50);
    expect(c.frames[0]?.data.messages.at(-1).text).toBe("reply-30");
    t.data.close(true);
  });

  test("R11 并发 20 次首次访问同一会话：工厂只调用一次，得到同一个会话", async () => {
    let calls = 0;
    const counting: SessionFactory = (o) => {
      calls++;
      return stubSessionFactory(stub)(o);
    };
    const t = start(undefined, counting);
    const { id } = await converse(t.pool, ["x"]);
    const n = restart(t, counting);
    calls = 0;
    const got = await Promise.all(
      Array.from({ length: 20 }, () => n.pool.acquire(id)),
    );
    expect(calls).toBe(1);
    expect(new Set(got).size).toBe(1);
    n.data.close(true);
  });

  test("R11 文件损坏：load_failed，不进池，不影响其他会话", async () => {
    const t = start();
    const good = await converse(t.pool, ["ok"]);
    const bad = "01a14000-0000-7000-8000-0000000000bb";
    writeFileSync(
      path.join(t.data.sessionDir, `2026-01-01T00-00-00-000Z_${bad}.jsonl`),
      "",
    );
    const n = restart(t);
    await expect(n.pool.acquire(bad)).rejects.toMatchObject({
      code: "load_failed",
    });
    expect(n.pool.get(bad)).toBeUndefined();
    expect(
      readFileSync(
        path.join(n.data.sessionDir, `2026-01-01T00-00-00-000Z_${bad}.jsonl`),
        "utf8",
      ),
    ).toBe("");
    expect(await n.pool.acquire(good.id)).not.toBeNull();
    expect(await n.pool.acquire("../etc/passwd")).toBeNull();
    expect(
      await n.pool.acquire("01a14000-0000-7000-8000-0000000000cc"),
    ).toBeNull();
    n.data.close(true);
  });
});

describe("R12 中断通知", () => {
  test("悬挂的工具调用：下一次请求带通知，且只带一次；无悬挂则没有", async () => {
    const t = start();
    const id = "01a14000-0000-7000-8000-0000000000d1";
    const file = await persistSession(stub, t.data.sessionDir, id, ["q"]);
    appendDanglingToolCall(file);
    const clean = "01a14000-0000-7000-8000-0000000000d2";
    await persistSession(stub, t.data.sessionDir, clean, ["q"]);
    t.data.store.reconcile(t.data.sessionDir, () => {});
    const NOTICE = "上一次运行被中断";

    const e = await t.pool.acquire(id);
    const c = collector();
    e?.subscribe(c);
    stub.requests.length = 0;
    e?.send("go on");
    await waitFor(ended(c), "run.ended");
    const count = (i: number) =>
      JSON.stringify(stub.requests[i]?.body).split(NOTICE).length - 1;
    expect(count(0)).toBe(1);
    e?.send("again");
    await waitFor(ended(c, 2), "第二次结束");
    expect(count(1)).toBe(1); // 历史里仍是同一条，没有新增

    const e2 = await t.pool.acquire(clean);
    const c2 = collector();
    e2?.subscribe(c2);
    stub.requests.length = 0;
    e2?.send("hi");
    await waitFor(ended(c2), "run.ended");
    expect(count(0)).toBe(0);
    t.data.close(true);
  });
});

describe("R13 改名", () => {
  test("已加载与未加载的会话都能改名，重启后仍在；空白与过长被拒", async () => {
    const t = start();
    const { id } = await converse(t.pool, ["x"]);
    expect(await t.pool.rename(id, "  已加载  ")).toMatchObject({
      name: "已加载",
    });
    const n = restart(t);
    expect(n.pool.get(id)).toBeUndefined();
    expect(await n.pool.rename(id, "未加载")).toMatchObject({ name: "未加载" });
    expect(n.pool.get(id)).toBeUndefined(); // 未进池
    const m = restart(n);
    expect(m.pool.list().find((x) => x.id === id)?.name).toBe("未加载");
    expect((await m.pool.acquire(id))?.name).toBe("未加载");
    await expect(m.pool.rename(id, "   ")).rejects.toBeInstanceOf(PoolError);
    await expect(m.pool.rename(id, "n".repeat(201))).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(await m.pool.rename(id, "n".repeat(200))).not.toBeNull();
    expect(
      await m.pool.rename("01a14000-0000-7000-8000-0000000000ee", "x"),
    ).toBeNull();
    m.data.close(true);
  });

  test("改名不改变 updatedAt；对账从 JSONL 恢复名称（以 JSONL 为准）", async () => {
    const t = start();
    const { id } = await converse(t.pool, ["x"]);
    const before = t.pool.info(id)?.updatedAt;
    const indexBefore = t.data.store.get(id)?.updatedAt;
    await t.pool.rename(id, "renamed");
    expect(t.pool.info(id)?.updatedAt).toBe(before);
    expect(t.data.store.get(id)?.updatedAt).toBe(indexBefore);
    t.data.store.remove(id);
    t.data.store.reconcile(t.data.sessionDir, () => {});
    expect(t.data.store.get(id)?.name).toBe("renamed");
    t.data.close(true);
  });
});

describe("R14 删除", () => {
  test("运行中拒绝：文件与索引都在", async () => {
    const t = start();
    const { id, entry } = await converse(t.pool, ["x"]);
    stub.mode.delayMs = 1500;
    entry.send("long");
    await waitFor(() => entry.running, "运行中");
    expect(await t.pool.remove(id)).toBe("running");
    expect(findSessionFile(t.data.sessionDir, id)).not.toBeNull();
    expect(t.data.store.get(id)).toBeDefined();
    await entry.stop();
    await waitFor(() => !entry.running, "停止");
    t.data.close(true);
  });

  test("空闲删除：文件、索引、池内会话都消失，订阅被关闭；之后再访问为 not_found", async () => {
    const t = start();
    const { id, entry } = await converse(t.pool, ["x"]);
    let closed = 0;
    entry.subscribe({ send() {}, close: () => closed++ });
    expect(await t.pool.remove(id)).toBe("ok");
    expect(closed).toBe(1);
    expect(findSessionFile(t.data.sessionDir, id)).toBeNull();
    expect(t.data.store.get(id)).toBeUndefined();
    expect(t.pool.get(id)).toBeUndefined();
    expect(await t.pool.acquire(id)).toBeNull();
    expect(await t.pool.remove(id)).toBe("not_found");
    t.data.close(true);
  });

  test("加载进行中收到删除：等加载完成再判断，不会留下已删文件的会话", async () => {
    const t = start();
    const { id } = await converse(t.pool, ["x"]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = stubSessionFactory(stub);
    const n = restart(t, async (o) => {
      await gate;
      return inner(o);
    });
    const loading = n.pool.acquire(id);
    const removing = n.pool.remove(id);
    release();
    await loading;
    expect(await removing).toBe("ok");
    expect(n.pool.get(id)).toBeUndefined();
    expect(n.pool.list().map((x) => x.id)).not.toContain(id);
    expect(findSessionFile(n.data.sessionDir, id)).toBeNull();
    n.data.close(true);
  });

  test("send 已接受但 agent_start 未到：删除按运行中拒绝", async () => {
    const t = start();
    const { id, entry } = await converse(t.pool, ["x"]);
    stub.mode.delayMs = 1000;
    entry.send("again");
    expect(entry.running).toBe(false);
    expect(await t.pool.remove(id)).toBe("running");
    await entry.stop();
    await waitFor(() => !entry.busy, "停止");
    t.data.close(true);
  });

  test("未加载的会话也能删；重启对账不会把它补回来", async () => {
    const t = start();
    const { id } = await converse(t.pool, ["x"]);
    const n = restart(t);
    expect(await n.pool.remove(id)).toBe("ok");
    const m = restart(n);
    m.data.store.reconcile(m.data.sessionDir, () => {});
    expect(m.pool.list().map((x) => x.id)).not.toContain(id);
    m.data.close(true);
  });

  test("文件删不掉：delete_failed，索引与池内会话保留，不会出现回弹", async () => {
    const t = start();
    const id = "01a14000-0000-7000-8000-0000000000ab";
    // 用目录冒充会话文件：unlink 目录必然失败，且不依赖运行用户的权限。
    mkdirSync(
      path.join(t.data.sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
    );
    t.data.store.upsert({ id, name: null, createdAt: "a", updatedAt: "a" });
    await expect(t.pool.remove(id)).rejects.toMatchObject({
      code: "delete_failed",
    });
    expect(t.data.store.get(id)).toBeDefined();
    expect(
      existsSync(
        path.join(t.data.sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
      ),
    ).toBe(true);
    t.data.close(true);
  });

  test("加载失败时删除：不被失败的加载拦住，损坏的会话也能删掉", async () => {
    const t = start();
    const { id } = await converse(t.pool, ["x"]);
    writeFileSync(findSessionFile(t.data.sessionDir, id) ?? "", "坏的\n");
    const n = restart(t);
    const loading = n.pool.acquire(id);
    const removing = n.pool.remove(id);
    await expect(loading).rejects.toThrow("会话文件头无效");
    expect(await removing).toBe("ok");
    expect(findSessionFile(n.data.sessionDir, id)).toBeNull();
    n.data.close(true);
  });
});
