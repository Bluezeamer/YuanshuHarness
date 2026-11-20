import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { JobManager, LOG_CHUNK_MAX } from "../job/manager.js";
import { AuditLog } from "../store/audit.js";
import { type Db, openDatabase } from "../store/db.js";
import { JobStore } from "../store/jobs.js";
import { jobsApi } from "./jobs.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let jobs: JobManager;

beforeEach(async () => {
  dir = makeTmpDir("yuanshu-api-jobs-");
  db = openDatabase(dir);
  jobs = new JobManager({
    store: new JobStore(db),
    dir: `${dir}/jobs`,
    notify: () => true,
    remindMs: () => 0,
  });
  app = Fastify();
  // 列表路由只需要判断会话在不在；这里给个最小替身。
  const pool = { info: (id: string) => (id === "s1" ? { id } : null) };
  await app.register(jobsApi, {
    jobs,
    pool: pool as never,
    audit: new AuditLog(db),
  });
  await app.ready();
});
afterEach(async () => {
  jobs.shutdown();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: "GET", url });
const logOf = async (id: string, from?: number) =>
  (
    await get(
      `/api/v1/jobs/${id}/log${from === undefined ? "" : `?from=${from}`}`,
    )
  ).json() as {
    text: string;
    from: number;
    next: number;
    headCut: boolean;
    ended: boolean;
  };

test("任务详情：含完整输入；不存在 404", async () => {
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
    input: "npm run dev",
  });
  const res = await get(`/api/v1/jobs/${h.id}`);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    job: { id: h.id, label: "dev", input: "npm run dev", state: "running" },
  });
  expect((await get("/api/v1/jobs/nope")).statusCode).toBe(404);
});

test("日志：首次给尾部，增量从 next 接上；结束时 ended", async () => {
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
  });
  h.write("line1\n");
  const first = await logOf(h.id);
  expect(first).toMatchObject({
    text: "line1\n",
    from: 0,
    next: 6,
    headCut: false,
    ended: false,
  });
  h.write("line2\n");
  const more = await logOf(h.id, first.next);
  expect(more).toMatchObject({
    text: "line2\n",
    from: 6,
    next: 12,
    headCut: false,
    ended: false,
  });
  h.end({ ok: true, exitCode: 0 });
  const end = await logOf(h.id, more.next);
  expect(end).toMatchObject({ text: "", next: 12, ended: true });
});

test("日志：文件不存在时给空文本，给了 from 也按空日志处理", async () => {
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
  });
  rmSync(`${dir}/jobs/${h.id}.log`, { force: true });
  expect(await logOf(h.id)).toMatchObject({
    text: "",
    from: 0,
    next: 0,
    headCut: false,
    ended: false,
  });
  expect(await logOf(h.id, 5)).toMatchObject({ text: "", from: 0, next: 0 });
});

test("日志：from 非法或越过文件末尾 400", async () => {
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
  });
  h.write("abc");
  for (const bad of ["-1", "1.5", "abc", ""]) {
    const res = await get(`/api/v1/jobs/${h.id}/log?from=${bad}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "bad_request" });
  }
  const far = await get(`/api/v1/jobs/${h.id}/log?from=99`);
  expect(far.statusCode).toBe(400);
  expect(far.json()).toMatchObject({ error: "bad_request" });
  expect((await get("/api/v1/jobs/nope/log")).statusCode).toBe(404);
});

test("日志：超过尾部上限时标 headCut，起点对齐到行首", async () => {
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
  });
  // 每行 101 字节、以 row- 开头：切在行中间的起点读出来不会以 row- 开头
  const LINE = 101;
  h.write(
    Array.from(
      { length: 4000 },
      (_, i) => `row-${String(i).padStart(5, "0")} ${"x".repeat(90)}\n`,
    ).join(""),
  );
  const chunk = await logOf(h.id);
  expect(chunk.headCut).toBe(true);
  expect(chunk.from).toBeGreaterThan(0);
  expect(chunk.from % LINE).toBe(0);
  expect(chunk.text.startsWith("row-")).toBe(true);
  expect(chunk.next).toBe(4000 * LINE);
});

test("日志：任务已结束但这次没读到末尾（超过单次上限）时 ended 仍是 false", async () => {
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
  });
  h.write("a".repeat(LOG_CHUNK_MAX + 10));
  h.end({ ok: true, exitCode: 0 });
  const part = await logOf(h.id, 0);
  expect(part).toMatchObject({ next: LOG_CHUNK_MAX, ended: false });
  expect(part.text).toHaveLength(LOG_CHUNK_MAX);
  expect(await logOf(h.id, part.next)).toMatchObject({
    text: "a".repeat(10),
    ended: true,
  });
});

test("会话任务列表不变", async () => {
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
  });
  const ok = await get("/api/v1/sessions/s1/jobs");
  expect(ok.statusCode).toBe(200);
  expect((ok.json() as { jobs: { id: string }[] }).jobs[0]?.id).toBe(h.id);
  expect((await get("/api/v1/sessions/s2/jobs")).statusCode).toBe(404);
});
