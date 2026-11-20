import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import { FILES_MAX, type FileRow, SessionFileStore } from "./session-files.js";
import { SessionStore } from "./sessions.js";

let dir: string;
let db: Db;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-files-"));
  db = openDatabase(dir);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const row = (
  p: string,
  lastAt: string,
  over: Partial<FileRow> = {},
): FileRow => ({
  path: p,
  hostId: "local",
  tokens: 10,
  reads: 1,
  modified: false,
  truncated: false,
  lastAt,
  ...over,
});

test("同 (会话, 主机, 路径) 合并为一行；不同主机或会话互不影响；按 lastAt 倒序", () => {
  const store = new SessionFileStore(db);
  store.put("s", row("/a", "2026-01-01T00:00:01Z"));
  store.put("s", row("/b", "2026-01-01T00:00:02Z"));
  store.put(
    "s",
    row("/a", "2026-01-01T00:00:03Z", { reads: 2, modified: true }),
  );
  store.put("s", row("/a", "2026-01-01T00:00:04Z", { hostId: "h1" }));
  store.put("other", row("/a", "2026-01-01T00:00:05Z"));

  const { files, truncated } = store.list("s");
  expect(truncated).toBe(false);
  expect(files.map((f) => `${f.hostId}:${f.path}`)).toEqual([
    "h1:/a",
    "local:/a",
    "local:/b",
  ]);
  expect(store.get("s", "local", "/a")).toMatchObject({
    reads: 2,
    modified: true,
  });
  expect(store.count("s")).toBe(3);
  expect(store.list("none")).toEqual({ files: [], truncated: false });
});

test("超过上限丢最旧并带 truncated，之后继续写入仍保持", () => {
  const store = new SessionFileStore(db);
  const at = (i: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  for (let i = 0; i < FILES_MAX; i++) store.put("s", row(`/f${i}`, at(i)));
  expect(store.list("s")).toMatchObject({ truncated: false });
  expect(store.list("s").files).toHaveLength(FILES_MAX);

  store.put("s", row("/new1", at(FILES_MAX)));
  // 恰好多一条：视图只给 500 条，最旧的那条不在其中
  let r = store.list("s");
  expect(r.truncated).toBe(true);
  expect(r.files).toHaveLength(FILES_MAX);
  expect(r.files.some((f) => f.path === "/f0")).toBe(false);

  store.put("s", row("/new2", at(FILES_MAX + 1)));
  store.put("s", row("/new3", at(FILES_MAX + 2)));
  r = store.list("s");
  expect(r.truncated).toBe(true);
  expect(r.files).toHaveLength(FILES_MAX);
  expect(r.files[0]?.path).toBe("/new3");
  expect(r.files.at(-1)?.path).toBe("/f3");
  expect(store.count("s")).toBe(FILES_MAX);
  // 其他会话不受影响
  store.put("t", row("/x", at(0)));
  expect(store.list("t").files).toHaveLength(1);
});

test("remove 只删该会话；启动对账清掉没有索引行的孤儿，保留有会话文件的", () => {
  const KEPT = "01a14000-0000-7000-8000-00000000000a";
  const sdir = path.join(dir, "sessions");
  mkdirSync(sdir);
  writeFileSync(
    path.join(sdir, `2026-01-02T03-04-05-000Z_${KEPT}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: KEPT, timestamp: "2026-01-02T03:04:05.000Z", cwd: "/w" })}\n`,
  );
  const store = new SessionFileStore(db);
  store.put(KEPT, row("/a", "t"));
  store.put("orphan", row("/a", "t"));
  store.put("gone", row("/a", "t"));
  store.remove("gone");
  expect(store.list("gone").files).toEqual([]);

  new SessionStore(db).reconcile(sdir, () => {});
  const ids = db.prepare("SELECT DISTINCT session_id FROM session_files").all();
  expect(ids).toEqual([{ session_id: KEPT }]);
});
