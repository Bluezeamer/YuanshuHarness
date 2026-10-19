import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { type Db, MIGRATIONS, openDatabase } from "./db.js";
import { RuleStore } from "./rules.js";
import { WorkspaceStore } from "./workspaces.js";

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-rules-"));
  dirs.push(dir);
  const db = openDatabase(dir);
  dbs.push(db);
  const workspaces = new WorkspaceStore(db);
  const ws = workspaces.ensureDefault(dir);
  if (!ws) throw new Error("no ws");
  return { db, workspaces, rules: new RuleStore(db), ws };
}

test("R1 迁移到 v4+ 并建 permission_rules", () => {
  const { db } = setup();
  expect(MIGRATIONS.length).toBeGreaterThanOrEqual(4);
  expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  expect(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'permission_rules'")
      .all(),
  ).toHaveLength(1);
});

test("R1 重复规则只留一条（含 access 为空的命令规则）", () => {
  const { rules, ws } = setup();
  rules.add(ws.id, { kind: "command", access: null, value: "npm test" });
  rules.add(ws.id, { kind: "command", access: null, value: "npm test" });
  rules.add(ws.id, { kind: "path", access: "read", value: "/a" });
  rules.add(ws.id, { kind: "path", access: "read", value: "/a" });
  rules.add(ws.id, { kind: "path", access: "write", value: "/a" });
  expect(rules.list(ws.id)).toHaveLength(3);
});

test("R1 唯一约束在表层生效", () => {
  const { db, ws } = setup();
  const ins = () =>
    db
      .prepare(
        "INSERT INTO permission_rules (id, workspace_id, kind, access, value, created_at) VALUES (?, ?, 'path', 'read', '/a', 'x')",
      )
      .run(Math.random().toString(), ws.id);
  ins();
  expect(ins).toThrow(/UNIQUE/);
});

test("R1 删除 workspace 级联删除其规则", () => {
  const { db, workspaces, rules, ws } = setup();
  const other = workspaces.create(
    "o",
    mkdtempSync(path.join(tmpdir(), "yuanshu-o-")),
  );
  if (!other) throw new Error("no other");
  rules.add(ws.id, { kind: "path", access: "read", value: "/a" });
  rules.add(other.id, { kind: "path", access: "read", value: "/b" });
  workspaces.remove(ws.id);
  expect(
    db.prepare("SELECT count(*) AS n FROM permission_rules").get(),
  ).toEqual({ n: 1 });
  expect(rules.list(other.id)).toHaveLength(1);
});

test("R11 remove 只删本 workspace 的规则", () => {
  const { rules, ws } = setup();
  rules.add(ws.id, { kind: "path", access: "read", value: "/a" });
  const id = rules.list(ws.id)[0]?.id as string;
  expect(rules.remove("other", id)).toBe(false);
  expect(rules.remove(ws.id, id)).toBe(true);
  expect(rules.remove(ws.id, id)).toBe(false);
});
