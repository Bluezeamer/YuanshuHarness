import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Policy, ToolPolicy } from "../permission/tool-matrix.js";
import type { Db } from "./db.js";
import { openDatabase } from "./db.js";
import { ToolRuleStore } from "./tool-rules.js";

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-tool-rules-"));
  dirs.push(dir);
  const db = openDatabase(dir);
  dbs.push(db);
  return { db, rules: new ToolRuleStore(db) };
}

const P = (inside: Policy, outside: Policy): ToolPolicy => ({
  inside,
  outside,
});
const rows = (db: Db) =>
  db
    .prepare("SELECT tool, inside, outside FROM tool_rules ORDER BY tool")
    .all();

test("effective：覆盖 > 出厂；不在矩阵里的工具返回 null", () => {
  const { rules } = setup();
  expect(rules.effective("read")).toEqual(P("allow", "ask"));
  expect(rules.effective("powershell")).toBeNull();
  rules.set("read", P("ask", "allow"));
  expect(rules.effective("read")).toEqual(P("ask", "allow"));
});

test("set：与出厂值相同等于恢复出厂，不留行", () => {
  const { db, rules } = setup();
  rules.set("bash", P("allow", "allow"));
  expect(rows(db)).toEqual([
    { tool: "bash", inside: "allow", outside: "allow" },
  ]);
  rules.set("bash", P("ask", "ask"));
  expect(rows(db)).toEqual([]);
});

test("setMany：与出厂值相同的项被删行、其余写入", () => {
  const { db, rules } = setup();
  rules.set("read", P("ask", "ask"));
  rules.setMany([
    ["read", P("allow", "ask")],
    ["bash", P("allow", "allow")],
    ["list_directories", P("ask", "ask")],
    ["switch_mode", P("ask", "ask")],
  ]);
  expect(rows(db)).toEqual([
    { tool: "bash", inside: "allow", outside: "allow" },
    { tool: "list_directories", inside: "ask", outside: "ask" },
  ]);
  expect(rules.effective("read")).toEqual(P("allow", "ask"));
});

test("setMany 原子：中途写入失败时前面已写的项也回滚", () => {
  const { db, rules } = setup();
  rules.set("bash", P("allow", "allow"));
  // 第二项带非法 policy：set 内部写库时抛约束错误，整批回滚
  const bad = [{ inside: undefined, outside: "ask" }] as unknown as ToolPolicy;
  expect(() =>
    rules.setMany([
      ["read", P("ask", "ask")],
      ["write", bad],
    ]),
  ).toThrow();
  expect(rows(db)).toEqual([
    { tool: "bash", inside: "allow", outside: "allow" },
  ]);
  expect(rules.effective("read")).toEqual(P("allow", "ask"));
});
