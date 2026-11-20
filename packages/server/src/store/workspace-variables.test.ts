import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import { WorkspaceVariableStore } from "./workspace-variables.js";

let dir: string;
let db: Db;
let store: WorkspaceVariableStore;

// 启用关系有外键指向 secrets，测试里直接插变量行。
const variable = (id: string) =>
  db
    .prepare(
      "INSERT INTO secrets (id, name, kind, ciphertext, created_at) VALUES (?, ?, 'variable', ?, 'now')",
    )
    .run(id, id, Buffer.from("x"));

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-wsvar-"));
  db = openDatabase(dir);
  store = new WorkspaceVariableStore(db);
  for (const id of ["v1", "v2", "v3"]) variable(id);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("启用关系", () => {
  test("默认全不开；整份替换后按需读回", () => {
    expect(store.enabledIds("w1")).toEqual(new Set());
    store.setForWorkspace("w1", ["v1", "v2"]);
    expect(store.enabledIds("w1")).toEqual(new Set(["v1", "v2"]));
    store.setForWorkspace("w1", ["v3"]);
    expect(store.enabledIds("w1")).toEqual(new Set(["v3"]));
    store.setForWorkspace("w1", []);
    expect(store.enabledIds("w1")).toEqual(new Set());
  });

  test("不同工作区互不影响；重复 id 不会插入两行", () => {
    store.setForWorkspace("w1", ["v1"]);
    store.setForWorkspace("w2", ["v1", "v1", "v2"]);
    expect(store.enabledIds("w2")).toEqual(new Set(["v1", "v2"]));
    expect(store.workspacesOf("v1")).toEqual(["w1", "w2"]);
    store.setForWorkspace("w2", []);
    expect(store.workspacesOf("v1")).toEqual(["w1"]);
  });

  test("setForVariable 整份替换某个变量的工作区清单", () => {
    store.setForWorkspace("w1", ["v1", "v2"]);
    store.setForWorkspace("w2", ["v2"]);
    store.setForVariable("v2", ["w3"]);
    expect(store.enabledIds("w1")).toEqual(new Set(["v1"]));
    expect(store.enabledIds("w2")).toEqual(new Set());
    expect(store.enabledIds("w3")).toEqual(new Set(["v2"]));
    store.setForVariable("v2", []);
    expect(store.workspacesOf("v2")).toEqual([]);
  });

  test("byVariable 一次取全：工作区 id 升序，没有的工作区不出现", () => {
    store.setForWorkspace("w2", ["v1", "v2"]);
    store.setForWorkspace("w1", ["v2"]);
    const all = store.byVariable();
    expect(all.get("v1")).toEqual(["w2"]);
    expect(all.get("v2")).toEqual(["w1", "w2"]);
    expect(all.has("v3")).toBe(false);
  });

  test("变量行被删时关系随之级联删除", () => {
    store.setForWorkspace("w1", ["v1", "v2"]);
    db.prepare("DELETE FROM secrets WHERE id = 'v1'").run();
    expect(store.enabledIds("w1")).toEqual(new Set(["v2"]));
  });
});
