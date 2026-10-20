import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AuditLog } from "../store/audit.js";
import { type Db, openDatabase } from "../store/db.js";
import { auditApi } from "./audit.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let audit: AuditLog;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-audit-api-"));
  db = openDatabase(dir);
  audit = new AuditLog(db);
  app = Fastify();
  app.register(auditApi, { audit });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (q = "") => app.inject({ method: "GET", url: `/api/v1/audit${q}` });

test("倒序分页并带 nextBefore；过滤参数生效", async () => {
  for (let i = 0; i < 5; i++)
    audit.record({
      actor: "agent",
      kind: i % 2 ? "tool" : "file",
      sessionId: i < 3 ? "a" : "b",
      summary: `e${i}`,
    });
  const p1 = (await get("?limit=2")).json();
  expect(p1.entries.map((e: { summary: string }) => e.summary)).toEqual([
    "e4",
    "e3",
  ]);
  const p2 = (await get(`?limit=2&before=${p1.nextBefore}`)).json();
  expect(p2.entries.map((e: { summary: string }) => e.summary)).toEqual([
    "e2",
    "e1",
  ]);
  const tools = (await get("?kind=tool&session=a")).json();
  expect(tools.entries.map((e: { summary: string }) => e.summary)).toEqual([
    "e1",
  ]);
  expect(tools.nextBefore).toBeNull();
});

test.each([
  ["?limit=0", "invalid_limit"],
  ["?limit=abc", "invalid_limit"],
  ["?limit=501", "invalid_limit"],
  ["?before=-1", "invalid_before"],
  ["?before=x", "invalid_before"],
])("非法参数 %s → 400", async (q, error) => {
  const r = await get(q);
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBe(error);
});
