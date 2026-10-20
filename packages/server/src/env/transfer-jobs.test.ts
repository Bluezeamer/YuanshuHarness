import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { AuditLog } from "../store/audit.js";
import { type Db, openDatabase } from "../store/db.js";
import { LocalEnv } from "./local.js";
import { type TransferProgress, transfer } from "./transfer.js";
import { JOBS_KEEP, TransferJobs } from "./transfer-jobs.js";
import type { ExecEnv } from "./types.js";

let dir: string;
let db: Db;
let audit: AuditLog;
const local = new LocalEnv();

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-tjobs-"));
  db = openDatabase(dir);
  audit = new AuditLog(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// 源端读流：先吐出一块，等 release 再吐第二块，用来在传输中途取进度。
function gatedSource(first: string, second: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => {
    release = ok;
  });
  const env = Object.create(local) as ExecEnv;
  env.readStream = async () =>
    Readable.from(
      (async function* () {
        yield Buffer.from(first);
        await gate;
        yield Buffer.from(second);
      })(),
    );
  return { env, release };
}

describe("传输进度", () => {
  test("onProgress：先报总量，随后字节单调增长，最后文件数等于总数", async () => {
    const src = path.join(dir, "a.txt");
    writeFileSync(src, "x".repeat(70_000));
    const seen: TransferProgress[] = [];
    await transfer(
      { env: local, path: src },
      { env: local, path: path.join(dir, "b.txt") },
      { onProgress: (p) => seen.push({ ...p }) },
    );
    expect(seen[0]).toEqual({
      totalFiles: 1,
      totalBytes: 70_000,
      files: 0,
      bytes: 0,
    });
    const bytes = seen.map((p) => p.bytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
    expect(seen.at(-1)).toMatchObject({ files: 1, bytes: 70_000 });
  });

  test("任务中途可见部分进度，结束后状态与审计耗时就位", async () => {
    const out = path.join(dir, "out.txt");
    writeFileSync(path.join(dir, "ignored.txt"), "hello world");
    const { env, release } = gatedSource("hello ", "world");
    const jobs = new TransferJobs(audit);
    const job = jobs.start(
      { env, path: path.join(dir, "ignored.txt") },
      { env: local, path: out },
      { overwrite: false, sessionId: null },
    );
    await waitFor(() => job.bytes === 6 || job.state !== "running", "首块进度");
    expect(job).toMatchObject({ state: "running", files: 0, bytes: 6 });
    expect(job.totalFiles).toBe(1);
    release();
    await waitFor(() => job.state !== "running", "任务结束");
    expect(job).toMatchObject({ state: "done", files: 1, bytes: 11 });
    expect(readFileSync(out, "utf8")).toBe("hello world");
    const [row] = audit.list({ kind: "transfer" }).entries;
    expect(row?.detail?.durationMs).toBeGreaterThanOrEqual(0);
    expect(row?.sessionId).toBeNull();
  });

  test("只保留最近 JOBS_KEEP 个已结束任务，运行中的不丢", async () => {
    const src = path.join(dir, "s.txt");
    writeFileSync(src, "s");
    const jobs = new TransferJobs();
    const ids: string[] = [];
    for (let i = 0; i < JOBS_KEEP + 5; i++) {
      const j = jobs.start(
        { env: local, path: src },
        { env: local, path: path.join(dir, `d${i}.txt`) },
        { overwrite: false, sessionId: null },
      );
      ids.push(j.id);
      await waitFor(() => j.state !== "running", `任务 ${i}`);
    }
    expect(jobs.get(ids[0] as string)).toBeUndefined();
    expect(jobs.get(ids.at(-1) as string)).toBeDefined();
  });
});
