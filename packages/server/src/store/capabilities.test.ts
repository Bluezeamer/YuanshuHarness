import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CapabilityStore } from "./capabilities.js";
import { type Db, openDatabase } from "./db.js";
import { WorkspaceStore } from "./workspaces.js";

let dir: string;
let db: Db;
let store: CapabilityStore;
let workspaces: WorkspaceStore;
let wsId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-caps-"));
  db = openDatabase(dir);
  store = new CapabilityStore(db);
  workspaces = new WorkspaceStore(db);
  wsId = workspaces.create({ name: "w" }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("workspace 级能力分配", () => {
  test("set 整体替换，list 按名字排序", () => {
    store.set(wsId, "skill", ["b", "a"]);
    expect(store.list(wsId, "skill")).toEqual(["a", "b"]);
    store.set(wsId, "skill", ["c"]);
    expect(store.list(wsId, "skill")).toEqual(["c"]);
    // 两类互不影响
    store.set(wsId, "mcp", ["m"]);
    expect(store.list(wsId, "skill")).toEqual(["c"]);
    expect(store.list(wsId, "mcp")).toEqual(["m"]);
    store.set(wsId, "skill", []);
    expect(store.list(wsId, "skill")).toEqual([]);
  });

  test("workspacesWith：哪些工作区勾了它，按 id 排序", () => {
    const other = workspaces.create({ name: "other" }).id;
    store.set(other, "mcp", ["m", "n"]);
    store.set(wsId, "mcp", ["m"]);
    expect(store.workspacesWith("mcp", "m")).toEqual([wsId, other].sort());
    expect(store.workspacesWith("mcp", "n")).toEqual([other]);
    expect(store.workspacesWith("mcp", "gone")).toEqual([]);
    expect(store.workspacesWith("skill", "m")).toEqual([]);
  });

  test("工作区被删后分配随外键级联清掉", () => {
    store.set(wsId, "skill", ["a"]);
    store.set(wsId, "mcp", ["b"]);
    expect(workspaces.remove(wsId)).toBe(true);
    expect(store.list(wsId, "skill")).toEqual([]);
    expect(store.list(wsId, "mcp")).toEqual([]);
    expect(store.workspacesWith("skill", "a")).toEqual([]);
  });
});
