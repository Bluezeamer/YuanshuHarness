import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  persistSession,
  startStub,
  stubSessionFactory,
  type TestData,
  testPool,
} from "../../test/support/stub.js";
import {
  spawnChild,
  subagentWorld,
  type World,
} from "../../test/support/subagents.js";
import { findSessionFile } from "../store/sessions.js";
import type { SessionPool } from "./pool.js";

const stub = await startStub(() => "好的");
afterAll(() => stub.close());

let pool: SessionPool | undefined;
let data: TestData | undefined;
const worlds: World[] = [];

// 若干真实目录，用来当不同工作区的主目录。
function dirs(d: TestData, names = ["alpha", "beta", "gamma"]) {
  return names.map((name) => {
    mkdirSync(join(d.dir, name), { recursive: true });
    const w = d.directories.create(name, join(d.dir, name));
    if (!w) throw new Error("directory 没建成");
    return w;
  });
}

afterEach(async () => {
  pool?.dispose();
  pool = undefined;
  data?.close();
  data = undefined;
  for (const w of worlds.splice(0).reverse()) await w.close();
  stub.requests.length = 0;
});

const ended = (c: ReturnType<typeof collector>) => () =>
  c.types().includes("run.ended");

// 数据根下直接属于某个工作区的子目录们
const subdirs = (d: TestData) =>
  readdirSync(d.sessionDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

// 发一条消息并等这一轮结束。
const run = async (id: string) => {
  const e = pool?.get(id);
  if (!e) throw new Error("会话不在池里");
  const c = collector();
  e.subscribe(c);
  e.send("go");
  await waitFor(ended(c), "run.ended");
  return c;
};

// 最近一轮请求里模型看到的全部消息文本
const seen = () => JSON.stringify(stub.requests.at(-1)?.body.messages ?? []);

describe("创建时绑定工作区", () => {
  test("重启后装载的会话仍属于原来的工作区，目录清单随工作区", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a, b] = dirs(data);
    if (!a || !b) throw new Error("缺 directory");
    const id = (await pool.create({ directoryIds: [a.id, b.id] })).id;
    await run(id);
    const wsId = data.store.get(id)?.workspaceId;
    pool.dispose();
    const t2 = testPool(stubSessionFactory(stub), data);
    pool = t2.pool;
    data = t2.data;
    const resident = await pool.acquire(id);
    expect(resident?.workspaceId).toBe(wsId);
    expect(pool.directoryIdsOf(id)).toEqual([a.id, b.id]);
  });

  test("工厂失败过一次之后，同主目录的下一次创建仍然建出工作区", async () => {
    let fail = true;
    const ok = stubSessionFactory(stub);
    const t = testPool(async (o) => {
      if (fail) throw new Error("模型没配置");
      return ok(o);
    });
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    await expect(pool.create({ directoryIds: [a.id] })).rejects.toThrow();
    fail = false;
    const id = (await pool.create({ directoryIds: [a.id] })).id;
    const wsId = pool.workspaceIdOf(id) ?? "";
    expect(data.workspaces.get(wsId)).toBeDefined();
    expect(data.workspaceDirectories.get(wsId)).toEqual([a.id]);
  });

  test("并发创建里先开始的那个失败：后开始的那个仍然拥有真实存在的工作区", async () => {
    // 两个同主目录的创建共用一个预约 id；第一个在工厂里卡住后失败，第二个先完成并 bind，
    // 工作区必须由第二个建出来，而不是指向一个没人建的 id
    const ok = stubSessionFactory(stub);
    let fail: (e: Error) => void = () => {};
    const gate = new Promise<void>((_, rej) => {
      fail = rej;
    });
    let calls = 0;
    const t = testPool(async (o) => {
      calls++;
      if (calls === 1) await gate;
      return ok(o);
    });
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    const first = pool.create({ directoryIds: [a.id] });
    first.catch(() => {});
    await waitFor(() => calls === 1, "第一个创建进入工厂");
    const second = (await pool.create({ directoryIds: [a.id] })).id;
    fail(new Error("模型没配置"));
    await expect(first).rejects.toThrow();
    const wsId = pool.workspaceIdOf(second) ?? "";
    expect(data.workspaces.get(wsId)).toBeDefined();
    expect(data.workspaceDirectories.get(wsId)).toEqual([a.id]);
  });

  test("工厂失败的创建不留下空工作区", async () => {
    const t = testPool(async () => {
      throw new Error("模型没配置");
    });
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    await expect(pool.create({ directoryIds: [a.id] })).rejects.toThrow();
    expect(data.workspaces.list()).toHaveLength(0);
  });

  test("根会话不给 workspaceId：按主目录自动建工作区，同一主目录的第二个会话加入同一个", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    const first = (await pool.create({ directoryIds: [a.id] })).id;
    // 索引行要等会话有了 JSONL 才写（既有行为），所以先跑一轮
    await run(first);
    const wsId = data.store.get(first)?.workspaceId ?? "";
    expect(wsId).toEqual(expect.any(String));
    expect(data.workspaces.get(wsId)?.name).toBe("alpha");
    expect(data.workspaceDirectories.get(wsId)).toEqual([a.id]);

    const second = (await pool.create({ directoryIds: [a.id] })).id;
    await run(second);
    expect(data.store.get(second)?.workspaceId).toBe(wsId);
    expect(data.workspaces.list()).toHaveLength(1);
  });

  test("同一主目录的第二个会话忽略它请求里的附加目录；不同主目录是不同工作区", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a, b] = dirs(data);
    if (!a || !b) throw new Error("缺 directory");
    const first = (await pool.create({ directoryIds: [a.id, b.id] })).id;
    await run(first);
    const wsId = data.store.get(first)?.workspaceId ?? "";
    expect(data.workspaceDirectories.get(wsId)).toEqual([a.id, b.id]);

    const again = (await pool.create({ directoryIds: [a.id] })).id;
    await run(again);
    expect(data.store.get(again)?.workspaceId).toBe(wsId);
    // 清单归工作区：第二个会话请求里的清单被忽略，读到的是工作区的那份
    expect(pool.directoryIdsOf(again)).toEqual([a.id, b.id]);

    const other = (await pool.create({ directoryIds: [b.id] })).id;
    await run(other);
    expect(data.store.get(other)?.workspaceId).not.toBe(wsId);
  });

  test("给 workspaceId：加入该工作区；不存在、清单为空、主目录不一致都被拒为 bad_request", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a, b] = dirs(data);
    if (!a || !b) throw new Error("缺 directory");
    const ws = data.workspaces.create({ name: "已存在" });
    data.workspaceDirectories.set(ws.id, [a.id, b.id]);

    const joined = (await pool.create({ workspaceId: ws.id })).id;
    await run(joined);
    expect(data.store.get(joined)?.workspaceId).toBe(ws.id);
    expect(pool.directoryIdsOf(joined)).toEqual([a.id, b.id]);
    expect(pool.info(joined)?.directoryId).toBe(a.id);
    expect(data.workspaces.list()).toHaveLength(1);

    const missing = await pool.create({ workspaceId: "nope" }).catch((e) => e);
    expect(missing.code).toBe("bad_request");
    expect(missing.message).toBe("工作区不存在");

    const empty = data.workspaces.create({ name: "空的" });
    const noRoster = await pool
      .create({ workspaceId: empty.id })
      .catch((e) => e);
    expect(noRoster.code).toBe("bad_request");

    const wrongRoster = await pool
      .create({ workspaceId: ws.id, directoryIds: [b.id, a.id] })
      .catch((e) => e);
    expect(wrongRoster.code).toBe("bad_request");
    // directoryId 也要与工作区主目录一致
    const wrongId = await pool
      .create({ workspaceId: ws.id, directoryId: b.id })
      .catch((e) => e);
    expect(wrongId.code).toBe("bad_request");

    // 第 0 个相同就可以
    const same = (await pool.create({ workspaceId: ws.id, directoryId: a.id }))
      .id;
    await run(same);
    expect(data.store.get(same)?.workspaceId).toBe(ws.id);
  });
});

describe("子代理与 fork 的工作区", () => {
  test("子代理会话与父同一个工作区", async () => {
    const w = subagentWorld(stub);
    worlds.push(w);
    const parentId = (await w.pool.create()).id;
    const parentWs = w.pool.get(parentId)?.workspaceId;
    expect(parentWs).toEqual(expect.any(String));
    // 根会话先跑一轮，它的文件才落盘
    const pe = w.pool.get(parentId);
    const c = collector();
    pe?.subscribe(c);
    pe?.send("go");
    await waitFor(ended(c), "run.ended");
    const { childId, done } = await spawnChild(w, parentId, { task: "看一眼" });
    done.catch(() => {});
    expect(w.pool.get(childId)?.workspaceId).toBe(parentWs);
  });

  test("fork：新会话同工作区，父会话与分叉点落库", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    const id = (await pool.create({ directoryIds: [a.id] })).id;
    await run(id);
    const entry = pool.get(id);
    const reply = entry?.sessionManager
      .getBranch()
      .find((e) => e.type === "message" && e.message.role === "assistant");
    if (!reply) throw new Error("没有助手回复");

    const forked = await pool.fork(id, reply.id, "分支");
    const row = data.store.get(forked.id);
    expect(row?.workspaceId).toBe(data.store.get(id)?.workspaceId);
    expect(row?.parentSessionId).toBe(id);
    expect(row?.forkEntryId).toBe(reply.id);
    expect(pool.directoryIdsOf(forked.id)).toEqual([a.id]);
  });
});

describe("按工作区改目录清单", () => {
  test("写进工作区挂载；同一工作区里两个已装载的会话下一轮都收到通知", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a, b] = dirs(data);
    if (!a || !b) throw new Error("缺 directory");
    const one = (await pool.create({ directoryIds: [a.id] })).id;
    const two = (await pool.create({ directoryIds: [a.id] })).id;
    await run(one);
    await run(two);
    const wsId = data.store.get(one)?.workspaceId ?? "";

    await pool.setWorkspaceDirectories(wsId, [a.id, b.id]);
    expect(pool.directoryRows(one)).toEqual([
      expect.objectContaining({ id: a.id, role: "local", current: true }),
      expect.objectContaining({ id: b.id, role: "remote", current: false }),
    ]);
    expect(data.workspaceDirectories.get(wsId)).toEqual([a.id, b.id]);
    expect(pool.directoryIdsOf(two)).toEqual([a.id, b.id]);

    for (const id of [one, two]) {
      await run(id);
      expect(seen()).toContain("The directories of this session have changed");
    }
  });

  test("当前目录被移除的会话被移回主目录：已装载与未装载各一例", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a, b] = dirs(data);
    if (!a || !b) throw new Error("缺 directory");
    const live = (await pool.create({ directoryIds: [a.id, b.id] })).id;
    const idle = (await pool.create({ directoryIds: [a.id, b.id] })).id;
    await run(live);
    await run(idle);
    // 两个都在 beta：一个稍后装载，一个保持未装载
    data.store.updateDirectoryId(live, b.id);
    data.store.updateDirectoryId(idle, b.id);

    // 新池：live 按需装载，idle 留在库里
    pool.dispose();
    const t2 = testPool(stubSessionFactory(stub), data);
    pool = t2.pool;
    data = t2.data;
    const resident = await pool.acquire(live);
    if (!resident) throw new Error("会话没装载");
    resident.directoryId = b.id;

    // 移除 beta：两个都被移回主目录 alpha
    await pool.setWorkspaceDirectories(
      data.store.get(live)?.workspaceId ?? "",
      [a.id],
    );
    expect(resident.directoryId).toBe(a.id);
    expect(data.store.get(live)?.directoryId).toBe(a.id);
    expect(data.store.get(idle)?.directoryId).toBe(a.id);

    await run(live);
    expect(seen()).toContain("The directory you were in has been removed");
  });

  test("删除会话不删工作区", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    const id = (await pool.create({ directoryIds: [a.id] })).id;
    await run(id);
    const wsId = data.store.get(id)?.workspaceId ?? "";
    expect(await pool.remove(id)).toBe("ok");
    expect(data.workspaces.get(wsId)).toBeDefined();
    expect(data.workspaceDirectories.get(wsId)).toEqual([a.id]);
    expect(data.store.listByWorkspace(wsId)).toEqual([]);
  });
});

describe("会话文件按工作区分目录", () => {
  test("会话文件在 sessions/<工作区 id>/ 下；同一主目录的第二个会话落在同一个子目录", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    const first = (await pool.create({ directoryIds: [a.id] })).id;
    await run(first);
    const wsId = data.store.get(first)?.workspaceId ?? "";
    expect(subdirs(data)).toEqual([wsId]);
    const file = findSessionFile(data.sessionDir, first);
    expect(file).not.toBeNull();
    expect(dirname(file as string)).toBe(join(data.sessionDir, wsId));

    const second = (await pool.create({ directoryIds: [a.id] })).id;
    await run(second);
    expect(dirname(findSessionFile(data.sessionDir, second) as string)).toBe(
      join(data.sessionDir, wsId),
    );
    expect(subdirs(data)).toEqual([wsId]);
  });

  test("同一主目录并发创建：先定下同一个工作区 id，只建一个工作区、一个子目录", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    const [one, two] = await Promise.all([
      pool.create({ directoryIds: [a.id] }),
      pool.create({ directoryIds: [a.id] }),
    ]);
    await run(one.id);
    await run(two.id);
    expect(data.workspaces.list()).toHaveLength(1);
    expect(pool.get(one.id)?.workspaceId).toBe(pool.get(two.id)?.workspaceId);
    expect(subdirs(data)).toEqual([data.workspaces.list()[0]?.id]);
  });

  test("重启（新池 + 对账）后索引行还在、能装载、历史读得出来", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    const id = (await pool.create({ directoryIds: [a.id] })).id;
    await run(id);
    const wsId = data.store.get(id)?.workspaceId ?? "";
    pool.dispose();
    const t2 = testPool(stubSessionFactory(stub), data);
    pool = t2.pool;
    data = t2.data;
    expect(data.store.reconcile(data.sessionDir, () => {})).toMatchObject({
      added: 0,
      removed: 0,
    });
    expect(data.store.get(id)?.workspaceId).toBe(wsId);
    const resident = await pool.acquire(id);
    expect(resident).not.toBeNull();
    expect(resident?.workspaceId).toBe(wsId);
    expect(pool.history(id)?.map((m) => m.text)).toEqual(["go", "好的"]);
  });

  test("用户 fork：新文件与源文件在同一个工作区子目录", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    const [a] = dirs(data);
    if (!a) throw new Error("缺 directory");
    const id = (await pool.create({ directoryIds: [a.id] })).id;
    await run(id);
    const reply = pool
      .get(id)
      ?.sessionManager.getBranch()
      .find((e) => e.type === "message" && e.message.role === "assistant");
    if (!reply) throw new Error("没有助手回复");
    const forked = await pool.fork(id, reply.id, "分支");
    const src = findSessionFile(data.sessionDir, id) as string;
    const out = findSessionFile(data.sessionDir, forked.id) as string;
    expect(dirname(out)).toBe(dirname(src));
    expect(dirname(out)).toBe(
      join(data.sessionDir, data.store.get(id)?.workspaceId ?? ""),
    );
  });

  test("子代理会话的文件与根会话在同一个工作区子目录", async () => {
    const w = subagentWorld(stub);
    worlds.push(w);
    const parentId = (await w.pool.create()).id;
    const parentWs = w.pool.get(parentId)?.workspaceId;
    expect(parentWs).toEqual(expect.any(String));
    // 根会话先跑一轮，它的文件才落盘
    const pe = w.pool.get(parentId);
    const c = collector();
    pe?.subscribe(c);
    pe?.send("go");
    await waitFor(ended(c), "run.ended");
    const { childId, done } = await spawnChild(w, parentId, { task: "看一眼" });
    done.catch(() => {});
    const parentFile = findSessionFile(w.data.sessionDir, parentId) as string;
    const childFile = findSessionFile(w.data.sessionDir, childId) as string;
    expect(dirname(parentFile)).toBe(join(w.data.sessionDir, parentWs ?? ""));
    expect(dirname(childFile)).toBe(dirname(parentFile));
  });

  test("平铺的旧文件仍能被对账与装载", async () => {
    const t = testPool(stubSessionFactory(stub));
    pool = t.pool;
    data = t.data;
    // 旧版本：文件直接放在数据根下，索引行没有工作区
    const id = "01a14000-0000-7000-8000-0000000000c1";
    const flat = await persistSession(stub, data.sessionDir, id, ["旧消息"]);
    expect(dirname(flat)).toBe(data.sessionDir);
    expect(t.data.store.reconcile(t.data.sessionDir, () => {})).toMatchObject({
      added: 1,
    });
    expect(t.data.store.get(id)?.workspaceId).toBeNull();
    const resident = await pool.acquire(id);
    expect(resident).not.toBeNull();
    expect(pool.history(id)).toHaveLength(2);
    // 装载后不改文件位置：仍在顶层
    expect(dirname(findSessionFile(t.data.sessionDir, id) as string)).toBe(
      t.data.sessionDir,
    );
  });
});
