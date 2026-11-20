import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type TestData, testData } from "../../test/support/stub.js";
import { WORKSPACE_NAME_MAX } from "../store/workspaces.js";
import { WorkspaceBinding } from "./workspace-binding.js";

let data: TestData | undefined;
afterEach(() => data?.close());

// 一个真实的测试库 + 若干真实目录；binding 只认 store 里的 id。
function world(names: string[] = ["alpha", "beta", "gamma"]) {
  const d = testData();
  data = d;
  const dirs = names.map((name) => {
    mkdirSync(join(d.dir, name));
    const w = d.directories.create(name, join(d.dir, name));
    if (!w) throw new Error("directory 没建成");
    return w;
  });
  const binding = new WorkspaceBinding({
    workspaces: d.workspaces,
    mounts: d.workspaceDirectories,
    sessions: d.store,
  });
  return { d, dirs, binding };
}

test("ensureFor：新建工作区，名称取主目录名，清单 = roster", () => {
  const { d, dirs, binding } = world();
  const [a, b, c] = dirs;
  if (!a || !b || !c) throw new Error("缺 directory");
  const id = binding.ensureFor(a, [a.id, b.id, c.id]);
  expect(d.workspaces.get(id)).toMatchObject({
    name: "alpha",
    archived: false,
  });
  expect(binding.directoryIds(id)).toEqual([a.id, b.id, c.id]);
});

test("ensureFor：同一主目录再调一次返回同一个工作区，且不改它的清单", () => {
  const { binding, dirs } = world();
  const [a, b] = dirs;
  if (!a || !b) throw new Error("缺 directory");
  const first = binding.ensureFor(a, [a.id, b.id]);
  const again = binding.ensureFor(a, [a.id]);
  expect(again).toBe(first);
  expect(binding.directoryIds(first)).toEqual([a.id, b.id]);
});

test("ensureFor：超长的目录名建工作区时截断到 WORKSPACE_NAME_MAX", () => {
  const long = "长".repeat(WORKSPACE_NAME_MAX + 20);
  const { d, binding, dirs } = world([long]);
  const [only] = dirs;
  if (!only) throw new Error("缺 directory");
  const id = binding.ensureFor(only, [only.id]);
  expect(d.workspaces.get(id)?.name).toBe(long.slice(0, WORKSPACE_NAME_MAX));
  expect(d.workspaces.get(id)?.name.length).toBe(WORKSPACE_NAME_MAX);
});

test("ensureFor：另一个主目录是新的工作区", () => {
  const { binding, dirs } = world();
  const [a, b] = dirs;
  if (!a || !b) throw new Error("缺 directory");
  expect(binding.ensureFor(a, [a.id])).not.toBe(binding.ensureFor(b, [b.id]));
});

test("workspaceIdOf：读索引行；没有行或没绑定返回 null", () => {
  const { d, binding } = world();
  d.store.upsert({ id: "s1", name: null, createdAt: "1", updatedAt: "1" });
  d.store.upsert({
    id: "s2",
    name: null,
    createdAt: "1",
    updatedAt: "1",
    workspaceId: "w1",
  });
  expect(binding.workspaceIdOf("s1")).toBeNull();
  expect(binding.workspaceIdOf("s2")).toBe("w1");
  // 索引里没有的会话（如刚建好还没落库的）也是 null
  expect(binding.workspaceIdOf("nope")).toBeNull();
});

test("sessionIds：只取该工作区的会话", () => {
  const { d, binding } = world();
  for (const [id, ws] of [
    ["s1", "w1"],
    ["s2", "w1"],
    ["s3", "w2"],
  ] as const)
    d.store.upsert({
      id,
      name: null,
      createdAt: id,
      updatedAt: id,
      workspaceId: ws,
    });
  expect(binding.sessionIds("w1").sort()).toEqual(["s1", "s2"]);
  expect(binding.sessionIds("w2")).toEqual(["s3"]);
  expect(binding.sessionIds("w3")).toEqual([]);
});
