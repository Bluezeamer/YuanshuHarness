import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import { WorkspaceLayoutStore } from "./workspace-layouts.js";

let dir: string;
let db: Db;
let store: WorkspaceLayoutStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-wslayout-"));
  db = openDatabase(dir);
  store = new WorkspaceLayoutStore(db);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("布局", () => {
  test("没有行时 revision 0、document 为 null；每次写入 revision +1", () => {
    expect(store.get("w1")).toEqual({ revision: 0, document: null });
    expect(store.put("w1", 0, { windows: [{ id: "a" }] })).toEqual({
      ok: true,
      revision: 1,
    });
    expect(store.get("w1")).toEqual({
      revision: 1,
      document: { windows: [{ id: "a" }] },
    });
    expect(store.put("w1", 1, { windows: [] })).toEqual({
      ok: true,
      revision: 2,
    });
    expect(store.get("w1").document).toEqual({ windows: [] });
  });

  test("baseRevision 不匹配时返回当前快照且不写入", () => {
    store.put("w1", 0, { a: 1 });
    expect(store.put("w1", 0, { a: 2 })).toEqual({
      ok: false,
      current: { revision: 1, document: { a: 1 } },
    });
    expect(store.get("w1")).toEqual({ revision: 1, document: { a: 1 } });
  });

  test("不同工作区互不影响", () => {
    store.put("w1", 0, { a: 1 });
    expect(store.put("w2", 0, { b: 2 })).toEqual({ ok: true, revision: 1 });
    expect(store.get("w1")).toEqual({ revision: 1, document: { a: 1 } });
    expect(store.get("w2")).toEqual({ revision: 1, document: { b: 2 } });
  });
});
