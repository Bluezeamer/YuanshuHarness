import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import {
  findSessionFile,
  readHeader,
  SessionStore,
  sessionDirFor,
} from "./sessions.js";
import { WorkspaceStore } from "./workspaces.js";

const A = "01a14000-0000-7000-8000-00000000000a";
const B = "01a14000-0000-7000-8000-00000000000b";
const C = "01a14000-0000-7000-8000-00000000000c";

let dir: string;
let sdir: string;
let db: Db;
let store: SessionStore;
let workspaces: WorkspaceStore;
let warnings: string[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-idx-"));
  sdir = path.join(dir, "sessions");
  mkdirSync(sdir);
  db = openDatabase(dir);
  store = new SessionStore(db);
  workspaces = new WorkspaceStore(db);
  warnings = [];
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const header = (id: string, ts = "2026-01-02T03:04:05.000Z") =>
  `${JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: "/w" })}\n`;
const info = (name: string) =>
  `${JSON.stringify({ type: "session_info", id: "e", parentId: null, timestamp: "t", name })}\n`;
const put = (id: string, body: string, prefix = "2026-01-02T03-04-05-000Z") => {
  const f = path.join(sdir, `${prefix}_${id}.jsonl`);
  writeFileSync(f, body);
  return f;
};
const snapshot = () =>
  Object.fromEntries(
    readdirSync(sdir).map((n) => [n, readFileSync(path.join(sdir, n), "utf8")]),
  );
const warn = (m: string) => warnings.push(m);
const newWorkspace = () => workspaces.create({ name: "ws" }).id;
// 把会话文件放进 <sdir>/<工作区 id>/ 里。
const putIn = (
  ws: string,
  id: string,
  body: string,
  prefix = "2026-01-02T03-04-05-000Z",
) => {
  const d = sessionDirFor(sdir, ws);
  mkdirSync(d, { recursive: true });
  const f = path.join(d, `${prefix}_${id}.jsonl`);
  writeFileSync(f, body);
  return f;
};

describe("R5 定位与校验", () => {
  test("按文件名后缀精确匹配；非 UUID 的 id 一律找不到，不碰文件系统", () => {
    const f = put(A, header(A));
    expect(findSessionFile(sdir, A)).toBe(f);
    expect(findSessionFile(sdir, B)).toBeNull();
    for (const evil of [
      "../x",
      "..%2f",
      "a/../b",
      "",
      `${A}/..`,
      `${A}\0`,
      "x".repeat(5000),
      A.toUpperCase(),
    ])
      expect(findSessionFile(sdir, evil)).toBeNull();
    put(B, header(B), "2026-01-01T00-00-00-000Z-different-prefix");
    expect(findSessionFile(sdir, B)).not.toBeNull();
  });

  test("按工作区分目录：子目录里找得到，顶层平铺的也找得到，更深的找不到", () => {
    const ws = newWorkspace();
    expect(sessionDirFor(sdir, ws)).toBe(path.join(sdir, ws));
    // 非 UUID 的工作区 id 不拼进路径
    expect(() => sessionDirFor(sdir, "../x")).toThrow();
    expect(() => sessionDirFor(sdir, A.toUpperCase())).toThrow();

    const sub = path.join(sdir, ws);
    mkdirSync(sub);
    const inSub = path.join(sub, `2026-01-02T03-04-05-000Z_${A}.jsonl`);
    writeFileSync(inSub, header(A));
    expect(findSessionFile(sdir, A)).toBe(inSub);

    const flat = put(B, header(B));
    expect(findSessionFile(sdir, B)).toBe(flat);

    // 同一 id 两处都有：取排序第一个（顶层优先）
    writeFileSync(path.join(sub, `2026-01-01T00-00-00-000Z_${B}.jsonl`), "x");
    expect(findSessionFile(sdir, B)).toBe(flat);

    // 子目录再深一层不找
    const deep = path.join(sub, "nested");
    mkdirSync(deep);
    writeFileSync(path.join(deep, `2026-01-02T03-04-05-000Z_${C}.jsonl`), "x");
    expect(findSessionFile(sdir, C)).toBeNull();
  });

  test("文件头校验：空文件、乱码、id 不符、无时间戳均无效", () => {
    expect(readHeader(put(A, header(A)), A)?.createdAt).toBe(
      "2026-01-02T03:04:05.000Z",
    );
    expect(readHeader(put(B, ""), B)).toBeNull();
    expect(readHeader(put(B, "garbage\n"), B)).toBeNull();
    expect(readHeader(put(B, header(C)), B)).toBeNull();
    expect(
      readHeader(put(B, `${JSON.stringify({ type: "session", id: B })}\n`), B),
    ).toBeNull();
  });
});

describe("编号", () => {
  const row = (id: string) => ({
    id,
    name: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  test("单调递增且不复用：删除最后一个后新会话拿到新号", () => {
    store.upsert(row(A));
    store.upsert(row(B));
    expect([store.get(A)?.seqNo, store.get(B)?.seqNo]).toEqual([1, 2]);
    store.remove(B);
    store.upsert(row(C));
    expect(store.get(C)?.seqNo).toBe(3);
  });

  test("已有行的再次 upsert 不改编号；建会话时预分配的编号随首次落库带入", () => {
    const pre = store.allocSeq();
    store.upsert({ ...row(A), seqNo: pre });
    store.upsert({ ...row(A), name: "x", seqNo: 99 });
    expect(store.get(A)).toMatchObject({ seqNo: pre, name: "x" });
  });
});

describe("R6/R7 对账", () => {
  test("缺索引补建（名称取最后一条、时间取头与 mtime）；缺文件删行并警告；有的保持", () => {
    put(A, header(A) + info("first") + info("last"));
    put(B, header(B));
    store.upsert({ id: B, name: "cached", createdAt: "x", updatedAt: "y" });
    store.upsert({ id: C, name: null, createdAt: "c", updatedAt: "c" });
    const r = store.reconcile(sdir, warn);
    expect(r).toEqual({ added: 1, removed: 1, skipped: 0 });
    expect(store.get(A)).toMatchObject({
      name: "last",
      createdAt: "2026-01-02T03:04:05.000Z",
    });
    expect(store.get(B)?.name).toBe("cached");
    expect(store.get(C)).toBeUndefined();
    expect(warnings.join("\n")).toContain(C);
  });

  test("坏文件跳过并警告，不删除、不使对账失败；对账前后所有 JSONL 字节不变", () => {
    put(A, header(A));
    put(B, ""); // 空文件：SDK 的 open 会重写它，所以绝不能交给 SDK
    put(C, "garbage\n");
    writeFileSync(path.join(sdir, "random.jsonl"), "x");
    writeFileSync(path.join(sdir, "notes.txt"), "x");
    const before = snapshot();
    const r = store.reconcile(sdir, warn);
    expect(r).toMatchObject({ added: 1, skipped: 3 });
    expect(warnings).toHaveLength(3);
    expect(snapshot()).toEqual(before);
    expect(store.list().map((x) => x.id)).toEqual([A]);
  });

  test("会话目录不存在：索引行被清掉，不抛错", () => {
    store.upsert({ id: A, name: null, createdAt: "a", updatedAt: "a" });
    expect(store.reconcile(path.join(dir, "nope"), warn)).toMatchObject({
      removed: 1,
    });
  });

  test("同一 id 有多个文件：取字典序第一个，其余跳过并警告", () => {
    put(A, header(A), "2026-01-01T00-00-00-000Z");
    put(A, header(A), "2026-02-01T00-00-00-000Z");
    expect(store.reconcile(sdir, warn)).toMatchObject({ added: 1, skipped: 1 });
  });

  test("对账出子目录里的文件：补建行带 workspaceId（工作区存在时）；平铺与无主目录的不带", () => {
    const ws = newWorkspace();
    putIn(ws, A, header(A));
    put(B, header(B));
    // 目录名是合法 UUID 但没有这个工作区
    putIn(C, C, header(C));
    expect(store.reconcile(sdir, warn)).toMatchObject({ added: 3 });
    expect(store.get(A)?.workspaceId).toBe(ws);
    expect(store.get(B)?.workspaceId).toBeNull();
    expect(store.get(C)?.workspaceId).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("索引行指向子目录里的文件：重启对账不会当成丢失而删除", () => {
    const ws = newWorkspace();
    const file = putIn(ws, A, header(A));
    store.upsert({
      id: A,
      name: null,
      createdAt: "a",
      updatedAt: "a",
      workspaceId: ws,
    });
    expect(store.reconcile(sdir, warn)).toMatchObject({
      added: 0,
      removed: 0,
    });
    expect(store.get(A)?.workspaceId).toBe(ws);
    expect(warnings).toEqual([]);

    // 文件真的没了才删行
    rmSync(file);
    expect(store.reconcile(sdir, warn)).toMatchObject({ removed: 1 });
  });

  test("子目录里的坏文件、无名文件、重复文件照旧警告并跳过", () => {
    const ws = newWorkspace();
    putIn(ws, A, "");
    putIn(ws, B, "x");
    putIn(ws, C, header(C), "2026-01-01T00-00-00-000Z");
    putIn(ws, C, header(C), "2026-02-01T00-00-00-000Z");
    // 空文件、乱码、重复：各自警告并跳过；有效的那份照常补建（带工作区）
    const r = store.reconcile(sdir, warn);
    expect(r).toMatchObject({ added: 1, skipped: 3 });
    expect(warnings).toHaveLength(3);
    expect(store.get(C)?.workspaceId).toBe(ws);
  });

  test("列表按 updated_at 倒序；touch 与 rename 生效", () => {
    store.upsert({ id: A, name: null, createdAt: "1", updatedAt: "1" });
    store.upsert({ id: B, name: null, createdAt: "2", updatedAt: "2" });
    expect(store.list().map((r) => r.id)).toEqual([B, A]);
    store.touch(A, "3");
    store.rename(B, "nb");
    expect(store.list().map((r) => [r.id, r.name])).toEqual([
      [A, null],
      [B, "nb"],
    ]);
  });
});

describe("工作区与派生关系", () => {
  test("新列随新行写入、可读回；已有行的再次 upsert 不动它们", () => {
    store.upsert({
      id: A,
      name: null,
      createdAt: "1",
      updatedAt: "1",
      workspaceId: "w1",
      parentSessionId: B,
      forkEntryId: "e1",
    });
    expect(store.get(A)).toMatchObject({
      workspaceId: "w1",
      parentSessionId: B,
      forkEntryId: "e1",
      unreadResult: false,
      unreadError: false,
    });
    store.upsert({
      id: A,
      name: "x",
      createdAt: "1",
      updatedAt: "2",
      workspaceId: "w2",
      parentSessionId: null,
      forkEntryId: null,
    });
    expect(store.get(A)).toMatchObject({
      name: "x",
      workspaceId: "w1",
      parentSessionId: B,
      forkEntryId: "e1",
    });
  });

  test("setWorkspace 与 setParent", () => {
    store.upsert({ id: A, name: null, createdAt: "1", updatedAt: "1" });
    store.setWorkspace(A, "w1");
    expect(store.get(A)?.workspaceId).toBe("w1");
    store.setWorkspace(A, null);
    expect(store.get(A)?.workspaceId).toBeNull();
    store.setParent(A, B, "e1");
    expect(store.get(A)).toMatchObject({
      parentSessionId: B,
      forkEntryId: "e1",
    });
    store.setParent(A, null, null);
    expect(store.get(A)).toMatchObject({
      parentSessionId: null,
      forkEntryId: null,
    });
  });

  test("markUnread 只置对应列，clearMarks 两列清零", () => {
    store.upsert({ id: A, name: null, createdAt: "1", updatedAt: "1" });
    store.markUnread(A, "result");
    expect(store.get(A)).toMatchObject({
      unreadResult: true,
      unreadError: false,
    });
    store.markUnread(A, "error");
    expect(store.get(A)).toMatchObject({
      unreadResult: true,
      unreadError: true,
    });
    store.clearMarks(A);
    expect(store.get(A)).toMatchObject({
      unreadResult: false,
      unreadError: false,
    });
  });

  test("listByWorkspace 只取该工作区、顺序同 list()", () => {
    store.upsert({
      id: A,
      name: null,
      createdAt: "1",
      updatedAt: "1",
      workspaceId: "w1",
    });
    store.upsert({
      id: B,
      name: null,
      createdAt: "2",
      updatedAt: "2",
      workspaceId: "w1",
    });
    store.upsert({
      id: C,
      name: null,
      createdAt: "3",
      updatedAt: "3",
      workspaceId: "w2",
    });
    expect(store.listByWorkspace("w1").map((r) => r.id)).toEqual([B, A]);
    expect(store.listByWorkspace("w2").map((r) => r.id)).toEqual([C]);
    expect(store.listByWorkspace("nope")).toEqual([]);
  });

  test("forkCount 数派生的会话；删父会话后子会话仍保留 parentSessionId", () => {
    store.upsert({ id: A, name: null, createdAt: "1", updatedAt: "1" });
    store.upsert({ id: B, name: null, createdAt: "2", updatedAt: "2" });
    store.upsert({ id: C, name: null, createdAt: "3", updatedAt: "3" });
    store.setParent(B, A, "e1");
    store.setParent(C, A, "e2");
    expect(store.forkCount(A)).toBe(2);
    expect(store.forkCount(B)).toBe(0);
    store.remove(A);
    expect(store.get(B)?.parentSessionId).toBe(A);
    expect(store.forkCount(A)).toBe(2);
  });
});
