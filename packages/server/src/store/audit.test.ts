import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  AUDIT_DETAIL_MAX,
  AUDIT_SUMMARY_MAX,
  type AuditInput,
  AuditLog,
} from "./audit.js";
import { type Db, openDatabase } from "./db.js";

let dir: string;
let db: Db;
let audit: AuditLog;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-audit-"));
  db = openDatabase(dir);
  audit = new AuditLog(db);
});
afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const rec = (o: Partial<AuditInput> = {}) =>
  audit.record({ actor: "user", kind: "file", summary: "s", ...o });

test("存取：字段原样往返，缺省值为 null，倒序", () => {
  rec({
    sessionId: "s1",
    environmentId: "local",
    summary: "first",
    detail: { a: 1 },
  });
  rec({ actor: "agent", kind: "tool", summary: "second" });
  const { entries, nextBefore } = audit.list();
  expect(nextBefore).toBeNull();
  expect(entries.map((e) => e.summary)).toEqual(["second", "first"]);
  expect(entries[1]).toMatchObject({
    sessionId: "s1",
    actor: "user",
    kind: "file",
    environmentId: "local",
    detail: { a: 1 },
  });
  expect(entries[0]).toMatchObject({
    sessionId: null,
    environmentId: null,
    detail: null,
  });
  expect(new Date(entries[0]?.ts ?? "").toISOString()).toBe(entries[0]?.ts);
});

test("游标分页：不重不漏，最后一页 nextBefore 为 null", () => {
  for (let i = 0; i < 7; i++) rec({ summary: `e${i}` });
  const seen: string[] = [];
  let before: number | undefined;
  for (let n = 0; n < 10; n++) {
    const page = audit.list({ limit: 3, ...(before ? { before } : {}) });
    seen.push(...page.entries.map((e) => e.summary));
    if (page.nextBefore === null) break;
    before = page.nextBefore;
  }
  expect(seen).toEqual(["e6", "e5", "e4", "e3", "e2", "e1", "e0"]);
});

test("按会话、类别、环境过滤，可组合", () => {
  rec({ sessionId: "a", kind: "tool", environmentId: "local", summary: "1" });
  rec({ sessionId: "a", kind: "file", environmentId: "env1", summary: "2" });
  rec({ sessionId: "b", kind: "tool", environmentId: "env1", summary: "3" });
  const names = (q: Parameters<AuditLog["list"]>[0]) =>
    audit.list(q).entries.map((e) => e.summary);
  expect(names({ session: "a" })).toEqual(["2", "1"]);
  expect(names({ kind: "tool" })).toEqual(["3", "1"]);
  expect(names({ environment: "env1" })).toEqual(["3", "2"]);
  expect(names({ session: "a", kind: "tool", environment: "local" })).toEqual([
    "1",
  ]);
});

test("摘要与 detail 有上限：长字符串截短，整体超限只留标记", () => {
  rec({ summary: "x".repeat(AUDIT_SUMMARY_MAX + 50) });
  rec({ detail: { long: "y".repeat(5000) } });
  rec({
    detail: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${i}`, "v".repeat(100)]),
    ),
  });
  const [huge, long, summary] = audit.list().entries;
  expect(summary?.summary.length).toBeLessThanOrEqual(AUDIT_SUMMARY_MAX + 1);
  expect(String(long?.detail?.long).length).toBeLessThan(300);
  expect(huge?.detail).toEqual({ truncated: true });
  expect(JSON.stringify(huge?.detail).length).toBeLessThanOrEqual(
    AUDIT_DETAIL_MAX,
  );
});

test("limit 封顶；数据库已关闭时 record 不抛错", () => {
  for (let i = 0; i < 3; i++) rec();
  expect(audit.list({ limit: 100000 }).entries).toHaveLength(3);
  db.close();
  expect(() => rec()).not.toThrow();
});
