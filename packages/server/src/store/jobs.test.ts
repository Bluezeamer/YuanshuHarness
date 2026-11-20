import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { type Db, openDatabase } from "./db.js";
import { INPUT_MAX, JobStore } from "./jobs.js";

let dir: string;
let db: Db;
let store: JobStore;

beforeEach(() => {
  dir = makeTmpDir("yuanshu-jobs-store-");
  db = openDatabase(dir);
  store = new JobStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  id: "j1",
  sessionId: "s1",
  kind: "command" as const,
  name: "bash",
  label: "build",
  remindMs: 0,
};

test("input 存下完整输入；没给就是空串", () => {
  store.create({ ...base, input: "ls -la\npwd" });
  expect(store.get("j1")?.input).toBe("ls -la\npwd");
  store.create({ ...base, id: "j2", input: undefined });
  expect(store.get("j2")?.input).toBe("");
});

test("input 超过上限时截到 INPUT_MAX 字符", () => {
  const long = "x".repeat(INPUT_MAX + 500);
  store.create({ ...base, input: long });
  expect(store.get("j1")?.input).toHaveLength(INPUT_MAX);
  // 恰好等于上限的原样保留
  store.create({ ...base, id: "j2", input: "y".repeat(INPUT_MAX) });
  expect(store.get("j2")?.input).toHaveLength(INPUT_MAX);
});
