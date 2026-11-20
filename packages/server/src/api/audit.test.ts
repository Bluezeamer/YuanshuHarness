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

const post = async (payload: unknown) =>
  app.inject({
    method: "POST",
    url: "/api/v1/audit/events",
    payload: payload as Record<string, unknown>,
  });

test("POST /audit/events 只收 ui 类，actor 固定为 user", async () => {
  const ok = await post({
    kind: "ui",
    sessionId: "s1",
    environmentId: "e1",
    summary: "quote e1:/a.ts:L1-2",
    detail: { op: "quote", chars: 12 },
  });
  expect(ok.statusCode).toBe(204);
  const [e] = (await get("?kind=ui")).json().entries;
  expect(e).toMatchObject({
    actor: "user",
    kind: "ui",
    sessionId: "s1",
    environmentId: "e1",
    detail: { op: "quote", chars: 12 },
  });
});

test.each([
  [{ kind: "tool", summary: "x" }],
  [{ kind: "permission", summary: "x" }],
  [{ kind: "ui" }],
  [{ kind: "ui", summary: "" }],
  [{ kind: "ui", summary: "x".repeat(301) }],
  [null],
])("POST /audit/events 非法载荷 %j → 400 且不写入", async (payload) => {
  const r = await post(payload);
  expect(r.statusCode).toBe(400);
  expect((await get()).json().entries).toHaveLength(0);
});
