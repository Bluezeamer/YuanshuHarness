import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import { SubagentStore } from "./subagents.js";

let dir: string;
let db: Db;
let store: SubagentStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-subagents-"));
  db = openDatabase(dir);
  store = new SubagentStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const spec = {
  agentPresetId: "p",
  directoryIds: ["d"],
  primaryDirectoryId: "d",
  tierCap: "auto" as const,
};
const add = (
  childId: string,
  parentId: string,
  depth: number,
  counted = true,
) =>
  store.create({
    childId,
    parentId,
    depth,
    task: "t",
    spec,
    ...(counted ? {} : { counted: false }),
  });

test("存活计数不数工作流的 agent，但数它名下的普通子代理", () => {
  add("root-child", "root", 1);
  // 工作流的 agent：不计入，但它自己派出的子代理是普通子代理
  add("flow-1", "root", 1, false);
  add("flow-child", "flow-1", 2);
  expect(store.get("flow-1")?.counted).toBe(false);
  expect(store.get("root-child")?.counted).toBe(true);

  expect(store.runningCount("root")).toBe(1);
  expect(store.runningCount("flow-1")).toBe(1);
  // 整棵树：root-child 与 flow-child 算，flow-1 本身不算
  expect(store.aliveInTree("root")).toBe(2);
  // 从工作流 agent 往下看，它名下的照数
  expect(store.aliveInTree("flow-1")).toBe(1);

  store.finish("flow-child", "done", "ok");
  expect(store.aliveInTree("root")).toBe(1);
});

test("hasRunningInTree 不看 counted：工作流 agent 在跑也算执行中", () => {
  add("flow-1", "root", 1, false);
  add("flow-child", "flow-1", 2);
  expect(store.hasRunningInTree("root")).toBe(true);
  store.finish("flow-child", "done", "ok");
  // 只剩不计入存活名额的工作流 agent
  expect(store.aliveInTree("root")).toBe(0);
  expect(store.hasRunningInTree("root")).toBe(true);
  store.finish("flow-1", "done", "ok");
  expect(store.hasRunningInTree("root")).toBe(false);
});

test("onChange 在增删行与改 state 时回调", () => {
  const seen: string[] = [];
  store.onChange = (id) => seen.push(id);
  add("child", "root", 1);
  store.finish("child", "done", "ok");
  // 已终态的不再变更：finished 的第二次不生效，也不回调
  store.finish("child", "failed", "x");
  store.reopen("child");
  store.removeSession("child");
  expect(seen).toEqual(["child", "child", "child", "child"]);
});
