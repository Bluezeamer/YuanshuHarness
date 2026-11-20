import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testPool,
} from "../../test/support/stub.js";
import type { TreeViewNode } from "../store/session-tree.js";
import { SessionLibrary, TITLE_MAX } from "./library.js";
import type { SessionEntry, SessionPool } from "./pool.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let pool: SessionPool;
let data: TestData | undefined;

function newPool(): SessionPool {
  pool?.dispose();
  data?.close();
  const t = testPool(stubSessionFactory(stub));
  pool = t.pool;
  data = t.data;
  return pool;
}

afterEach(() => {
  pool?.dispose();
  data?.close();
  data = undefined;
  stub.mode.delayMs = 0;
  stub.mode.status = 200;
  stub.requests.length = 0;
});

async function createEntry(): Promise<SessionEntry> {
  newPool();
  const info = await pool.create();
  const entry = pool.get(info.id);
  if (!entry) throw new Error("会话不存在");
  return entry;
}

// 发一条消息并等到本轮结束。
async function chat(entry: SessionEntry, text: string): Promise<string[]> {
  const c = collector();
  const unsub = entry.subscribe(c);
  entry.send(text);
  await waitFor(() => c.types().includes("run.ended"), "run.ended");
  unsub();
  return c.types();
}

const messagesOf = (frame: { data: Record<string, unknown> } | undefined) =>
  (frame?.data.messages ?? []) as { role: string; text: string }[];

const flat = (nodes: TreeViewNode[]): TreeViewNode[] =>
  nodes.flatMap((n) => [n, ...flat(n.children)]);

const defined = <T>(value: T | undefined | null, what: string): T => {
  if (value === undefined || value === null) throw new Error(`缺少${what}`);
  return value;
};

describe("B20 历史回退", () => {
  test("回退到用户消息：回填 editor、广播整份快照、分支历史正确", async () => {
    const entry = await createEntry();
    await chat(entry, "第一轮");
    await chat(entry, "第二轮");

    const tree = pool.sessionTree(entry.id);
    const users = flat(tree?.nodes ?? []).filter((n) => n.role === "user");
    expect(users.map((n) => n.preview)).toEqual(["第一轮", "第二轮"]);
    // 目标 user 节点的父节点是第一次应答。
    const secondUser = defined(users[1], "第二条用户消息");
    const firstAssistant = secondUser.parentId;
    expect(firstAssistant).toBeDefined();

    const c = collector();
    const unsub = entry.subscribe(c);
    const result = await pool.navigate(entry.id, secondUser.id);
    unsub();

    // 目标 user 消息的父节点是第一次应答；editor 是这条指令原文。
    expect(result).toEqual({
      editor: { text: "第二轮" },
      leafId: firstAssistant,
    });
    // 回退不产生事件帧，最后收到的是整份快照替换。
    const snap = c.frames.at(-1);
    expect(snap?.type).toBe("snapshot");
    expect(
      messagesOf(snap)
        .map((m) => m.text)
        .slice(0, 1),
    ).toEqual(["第一轮"]);
    expect(messagesOf(snap)[1]?.text).toMatch(/^reply-\d+$/);
    expect(snap?.data).toMatchObject({
      startIndex: 0,
      running: false,
      activeTools: [],
      partial: null,
      queue: [],
    });

    // 回退后的树：leaf 与 activePath 都指向第一次应答。
    const after = pool.sessionTree(entry.id);
    expect(after?.leafId).toBe(firstAssistant);
    // 根是 pi 落盘的 system 消息（系统提示快照），它也是对话节点。
    expect(after?.activePath).toEqual([
      firstAssistant,
      users[0]?.id,
      users[0]?.parentId,
    ]);
    expect(pool.userMessages(entry.id)?.map((m) => m.text)).toEqual(["第一轮"]);

    // 从回退点继续：新分支的历史只含第一轮与重来的内容。
    await chat(entry, "重来");
    const history = pool.history(entry.id) ?? [];
    expect(history.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history[0]?.text).toBe("第一轮");
    expect(history[1]?.text).toMatch(/^reply-\d+$/);
    expect(history[2]?.text).toBe("重来");
    expect(history.map((m) => m.text)).not.toContain("第二轮");
    expect(pool.sessionTree(entry.id)?.nodes.length).toBe(1);
  });

  test("运行中回退被拒绝，节点不存在时报错", async () => {
    const entry = await createEntry();
    await chat(entry, "第一轮");
    const userId = pool.userMessages(entry.id)?.[0]?.entryId;
    expect(userId).toBeDefined();

    stub.mode.delayMs = 200;
    const c = collector();
    const unsub = entry.subscribe(c);
    entry.send("慢请求");
    await waitFor(() => c.types().includes("run.started"), "run.started");
    await expect(entry.navigate(userId as string)).rejects.toMatchObject({
      code: "session_running",
    });
    await waitFor(() => c.types().includes("run.ended"), "run.ended", 10_000);
    unsub();

    await expect(entry.navigate("no-such-entry")).rejects.toMatchObject({
      code: "bad_request",
    });
  });
});

describe("P09 复制会话分叉", () => {
  test("历史截止、parentSession、标题递增、可打开继续", async () => {
    const entry = await createEntry();
    await pool.rename(entry.id, "母会话");
    await chat(entry, "第一问");
    await chat(entry, "第二问");

    const nodes = flat(pool.sessionTree(entry.id)?.nodes ?? []);
    const assistants = nodes.filter((n) => n.role === "assistant");
    expect(assistants).toHaveLength(2);
    const firstForkPoint = defined(assistants[0], "第一次应答");
    const secondForkPoint = defined(assistants[1], "第二次应答");

    const origin = pool.sessionFile(entry.id);
    expect(origin).not.toBeNull();
    const lib = new SessionLibrary(pool);

    const fork1 = await lib.fork(entry.id, firstForkPoint.id);
    expect(fork1.title).toBe("母会话 · 分支1");
    // 落 sessions 表，会话库能列出、能查询。
    const info = pool.info(fork1.id);
    expect(info).not.toBeNull();
    expect(info).toMatchObject({
      name: "母会话 · 分支1",
      directoryId: pool.info(entry.id)?.directoryId,
      activeModeId: pool.info(entry.id)?.activeModeId,
    });
    expect(lib.list().map((v) => v.id)).toContain(fork1.id);

    // 新文件独立 id，parentSession 指向原会话文件。
    const forkFile = pool.sessionFile(fork1.id);
    expect(forkFile).not.toBeNull();
    expect(forkFile?.file).not.toBe(origin?.file);
    const header = JSON.parse(
      readFileSync(defined(forkFile, "分叉会话文件").file, "utf8").split(
        "\n",
      )[0] as string,
    ) as { id: string; parentSession?: string };
    expect(header.id).toBe(fork1.id);
    expect(header.parentSession).toBe(origin?.file);

    // 分叉历史截止到分叉点：只有第一问这一轮。
    const history = pool.history(fork1.id) ?? [];
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[0]?.text).toBe("第一问");

    // N 由该父会话已有的派生数算；分叉再分叉是自己的派生计数，标题在父名后再接一层。
    const fork2 = await lib.fork(entry.id, secondForkPoint.id);
    expect(fork2.title).toBe("母会话 · 分支2");
    const forkOfFork = flat(pool.sessionTree(fork1.id)?.nodes ?? []).find(
      (n) => n.role === "assistant",
    );
    const fork3 = await lib.fork(
      fork1.id,
      defined(forkOfFork, "分叉会话里的应答节点").id,
    );
    expect(fork3.title).toBe("母会话 · 分支1 · 分支1");

    // 分叉会话能像普通会话一样打开并继续对话。
    const loaded = await pool.acquire(fork1.id);
    expect(loaded).not.toBeNull();
    await chat(defined(loaded, "分叉会话"), "继续");
    const continued = pool.history(fork1.id) ?? [];
    expect(continued.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(continued[2]?.text).toBe("继续");
  });

  test("父名很长时截父名、保留后缀，整体不超过 TITLE_MAX", async () => {
    const entry = await createEntry();
    await pool.rename(entry.id, "长".repeat(TITLE_MAX));
    await chat(entry, "第一问");
    const nodes = flat(pool.sessionTree(entry.id)?.nodes ?? []);
    const point = defined(
      nodes.find((n) => n.role === "assistant"),
      "应答节点",
    );
    const lib = new SessionLibrary(pool);
    const fork = await lib.fork(entry.id, point.id);
    expect(fork.title.length).toBe(TITLE_MAX);
    expect(fork.title.endsWith(" · 分支1")).toBe(true);
  });

  test("不存在的会话/节点、没有历史的新会话都拒绝分叉", async () => {
    const entry = await createEntry();
    const lib = new SessionLibrary(pool);
    // 尚未产生任何消息：没有 JSONL 可截取。
    await expect(lib.fork(entry.id, "e1")).rejects.toMatchObject({
      code: "bad_request",
    });
    await chat(entry, "第一轮");
    await expect(lib.fork(entry.id, "no-such-entry")).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      lib.fork("019a0000-0000-7000-8000-000000000001", "e1"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
