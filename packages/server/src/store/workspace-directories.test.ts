import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import { WorkspaceDirectoryStore } from "./workspace-directories.js";

let dir: string;
let db: Db;
let store: WorkspaceDirectoryStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-wsdir-"));
  db = openDatabase(dir);
  store = new WorkspaceDirectoryStore(db);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("目录清单", () => {
  test("按 position 读回，整份替换", () => {
    store.set("w1", ["d1", "d2", "d3"]);
    expect(store.get("w1")).toEqual(["d1", "d2", "d3"]);
    store.set("w1", ["d3", "d1"]);
    expect(store.get("w1")).toEqual(["d3", "d1"]);
    store.set("w1", []);
    expect(store.get("w1")).toEqual([]);
  });

  test("不同工作区互不影响；remove 只删自己的", () => {
    store.set("w1", ["d1"]);
    store.set("w2", ["d2"]);
    store.remove("w1");
    expect(store.get("w1")).toEqual([]);
    expect(store.get("w2")).toEqual(["d2"]);
  });
});

describe("主目录唯一", () => {
  test("同一目录做两个工作区的主目录：唯一约束错误原样抛出", () => {
    store.set("w1", ["d1", "d2"]);
    expect(() => store.set("w2", ["d1", "d3"])).toThrow(/UNIQUE/);
    expect(store.get("w2")).toEqual([]);
  });

  test("一个工作区拿它当主目录、另一个当附加目录是允许的", () => {
    store.set("w1", ["d1"]);
    store.set("w2", ["d2", "d1"]);
    expect(store.get("w2")).toEqual(["d2", "d1"]);
    expect(store.primaryOwner("d1")).toBe("w1");
  });
});

test("primaryOwner / workspacesOf / referenceCount", () => {
  store.set("w1", ["d1", "d2"]);
  store.set("w2", ["d3", "d2"]);
  expect(store.primaryOwner("d1")).toBe("w1");
  expect(store.primaryOwner("d2")).toBeNull();
  expect(store.primaryOwner("nope")).toBeNull();
  expect(store.workspacesOf("d2")).toEqual(["w1", "w2"]);
  expect(store.workspacesOf("d1")).toEqual(["w1"]);
  expect(store.referenceCount("d2")).toBe(2);
  expect(store.referenceCount("d1")).toBe(1);
  expect(store.referenceCount("nope")).toBe(0);
});
