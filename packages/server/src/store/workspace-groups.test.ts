import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import { WorkspaceGroupStore } from "./workspace-groups.js";
import { WorkspaceStore } from "./workspaces.js";

let dir: string;
let db: Db;
let groups: WorkspaceGroupStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-wsgrp-"));
  db = openDatabase(dir);
  groups = new WorkspaceGroupStore(db);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("分组", () => {
  test("增删改查：新组排在最后，色号默认循环，字段可改", () => {
    const a = groups.create({ name: "A" });
    const b = groups.create({ name: "B", tone: 5 });
    expect([a.tone, b.tone]).toEqual([0, 5]);
    expect(a.order).toBeLessThan(b.order);
    expect(groups.update(a.id, { name: "A2", collapsed: true })).toMatchObject({
      name: "A2",
      collapsed: true,
      tone: 0,
    });
    expect(groups.list().map((g) => g.name)).toEqual(["A2", "B"]);
    expect(groups.update("nope", { name: "x" })).toBeUndefined();
  });

  test("删除分组只解散：组内工作区保留，group_id 置空", () => {
    const workspaces = new WorkspaceStore(db);
    const a = workspaces.create({ name: "A" });
    const b = workspaces.create({ name: "B" });
    const g = groups.create({ name: "G" });
    workspaces.setGroup(a.id, g.id);
    expect(workspaces.get(a.id)?.groupId).toBe(g.id);
    expect(groups.remove(g.id)).toBe(true);
    expect(workspaces.get(a.id)?.groupId).toBeNull();
    expect(workspaces.get(b.id)).toBeDefined();
    expect(groups.remove(g.id)).toBe(false);
  });
});

test("色号按已有数量循环", () => {
  for (let i = 0; i < 8; i++) groups.create({ name: `G${i}` });
  expect(
    groups
      .list()
      .map((g) => g.tone)
      .at(-1),
  ).toBe(0);
});
