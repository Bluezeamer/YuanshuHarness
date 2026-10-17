import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import { findSessionFile, readHeader, SessionStore } from "./sessions.js";

const A = "01a14000-0000-7000-8000-00000000000a";
const B = "01a14000-0000-7000-8000-00000000000b";
const C = "01a14000-0000-7000-8000-00000000000c";

let dir: string;
let sdir: string;
let db: Db;
let store: SessionStore;
let warnings: string[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-idx-"));
  sdir = path.join(dir, "sessions");
  mkdirSync(sdir);
  db = openDatabase(dir);
  store = new SessionStore(db);
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
