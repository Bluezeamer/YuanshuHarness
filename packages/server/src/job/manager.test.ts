import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Db, openDatabase } from "../store/db.js";
import { INPUT_MAX, type JobRow, JobStore } from "../store/jobs.js";
import { clampRemindMs, JobManager } from "./manager.js";

let dir: string;
let db: Db;
let sent: Array<{ to: string; text: string; job?: JobRow }>;
let online: boolean;

const make = (remindMs = 0) =>
  new JobManager({
    store: new JobStore(db),
    dir: path.join(dir, "jobs"),
    notify: (to, text, job) => {
      if (online) sent.push({ to, text, ...(job ? { job } : {}) });
      return online;
    },
    remindMs: () => remindMs,
  });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-jobs-"));
  db = openDatabase(dir);
  sent = [];
  online = true;
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("完成时回调给直接调用方，带日志末尾", () => {
  const jobs = make();
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "build",
  });
  h.write("line1\nline2\n");
  h.end({ ok: true, exitCode: 0 });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("s1");
  expect(sent[0]?.text).toContain("finished with exit code 0");
  expect(sent[0]?.text).toContain("line2");
  expect(jobs.own("s1", h.id).state).toBe("done");
});

test("非零退出记为异常退出", () => {
  const jobs = make();
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "x" });
  h.end({ ok: false, exitCode: 2 });
  expect(sent[0]?.text).toContain("failed with exit code 2");
});

test("自己停的不回调给自己；用户停的要回调", async () => {
  const jobs = make();
  const a = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  a.signal.addEventListener("abort", () => a.end({ ok: false }));
  expect(await jobs.stop("s1", a.id, "owner")).toEqual([a.id]);
  expect(sent).toHaveLength(0);

  const b = jobs.register("s1", { kind: "command", name: "bash", label: "b" });
  b.signal.addEventListener("abort", () => b.end({ ok: false }));
  await jobs.stop("s1", b.id, "user");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toContain("was stopped");
});

test("别人的任务按不存在处理", () => {
  const jobs = make();
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  expect(() => jobs.own("s2", h.id)).toThrow(/no job/);
});

test("停止时任务不收尾，宽限到点后仍记为已停止", async () => {
  vi.useFakeTimers();
  const jobs = make();
  const h = jobs.register("s1", { kind: "tool", name: "x", label: "x" });
  const p = jobs.stop("s1", h.id, "owner");
  await vi.advanceTimersByTimeAsync(3500);
  await p;
  expect(jobs.own("s1", h.id).state).toBe("stopped");
});

test("提醒周期性发送，任务继续跑；改间隔会刷新计时", async () => {
  vi.useFakeTimers();
  const jobs = make(60_000);
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toContain("still running");
  expect(sent[0]?.text).toContain("only a reminder");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toHaveLength(2);
  jobs.setRemind("s1", h.id, 0);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(sent).toHaveLength(2);
  expect(jobs.own("s1", h.id).state).toBe("running");
});

test("调用方不在线：终态留着，下次发消息前补上，只补一次", () => {
  const jobs = make();
  online = false;
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  h.write("out\n");
  h.end({ ok: true, exitCode: 0 });
  expect(sent).toHaveLength(0);
  const first = jobs.notices("s1");
  expect(first).toHaveLength(1);
  expect(first[0]?.text).toContain("finished");
  expect(first[0]?.job.id).toBe(h.id);
  expect(jobs.notices("s1")).toEqual([]);
});

test("Server 重启：运行中的任务一律中断，调用方被告知一次", () => {
  const first = make();
  const h = first.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
  });
  const second = make();
  expect(second.own("s1", h.id).state).toBe("interrupted");
  const n = second.notices("s1");
  expect(n[0]?.text).toContain("interrupted because the server restarted");
  expect(second.notices("s1")).toEqual([]);
});

test("job_start 观察期内就结束的，结果直接返回，不再回调", async () => {
  const jobs = make();
  const r = await jobs.startTool(
    "s1",
    { kind: "command", name: "bash", label: "quick" },
    async () => ({ ok: true, exitCode: 0, text: "hi" }),
  );
  expect(r.settled?.ok).toBe(true);
  expect(sent).toHaveLength(0);
  expect(readFileSync(path.join(dir, "jobs", `${r.id}.log`), "utf8")).toContain(
    "hi",
  );
});

test("删除会话时连名下的任务一起停掉、日志清掉", () => {
  const jobs = make();
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  let aborted = false;
  h.signal.addEventListener("abort", () => {
    aborted = true;
  });
  jobs.removeSession("s1");
  expect(aborted).toBe(true);
  expect(jobs.list("s1")).toEqual([]);
});

test("提醒间隔夹在 10 秒到 24 小时之间，0 保持不提醒", () => {
  expect(clampRemindMs(0)).toBe(0);
  expect(clampRemindMs(500)).toBe(10_000);
  expect(clampRemindMs(3e9)).toBe(86_400_000);
  expect(clampRemindMs(120_000)).toBe(120_000);
});

test("停止名下的任务（子代理被停）按自己停处理，不回调给它自己", async () => {
  const jobs = make();
  const h = jobs.register("sub", { kind: "command", name: "bash", label: "a" });
  h.signal.addEventListener("abort", () => h.end({ ok: false }));
  await jobs.stopOwned("sub", "owner");
  expect(sent).toHaveLength(0);
  expect(jobs.own("sub", h.id).state).toBe("stopped");
  expect(jobs.notices("sub")).toEqual([]);
});

test("指定开始时间的任务（阻塞命令转后台）从最初开始时刻算起", () => {
  const jobs = make();
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "a",
    startedAt: Date.now() - 120_000,
  });
  const row = jobs.own("s1", h.id);
  expect(Date.now() - Date.parse(row.startedAt)).toBeGreaterThanOrEqual(
    120_000,
  );
});

test("终态回调给 notify 带上任务快照；周期提醒不带", async () => {
  vi.useFakeTimers();
  const jobs = make(60_000);
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "dev",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.job).toBeUndefined();
  h.end({ ok: true, exitCode: 0 });
  expect(sent).toHaveLength(2);
  expect(sent[1]?.job).toMatchObject({ id: h.id, state: "done", exitCode: 0 });
});

test("登记、终态、重开、改提醒各通知 owner 一次，别人的任务不通知", async () => {
  const seen: string[] = [];
  const jobs = new JobManager({
    store: new JobStore(db),
    dir: path.join(dir, "jobs"),
    notify: () => true,
    changed: (id) => seen.push(id),
    remindMs: () => 0,
  });
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  expect(seen).toEqual(["s1"]);
  h.end({ ok: true, exitCode: 0 });
  expect(seen).toEqual(["s1", "s1"]);
  jobs.reopen(h.id);
  expect(seen).toEqual(["s1", "s1", "s1"]);
  jobs.setRemind("s1", h.id, 30_000);
  expect(seen).toEqual(["s1", "s1", "s1", "s1"]);
  // 别人的任务按不存在处理：不改提醒、不通知
  expect(() => jobs.setRemind("s2", h.id, 1000)).toThrow(/no job/);
  expect(seen).toHaveLength(4);
  jobs.shutdown();
});

test("register 把完整输入透传给记录", () => {
  const jobs = make();
  const h = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "long",
    input: "for i in 1 2 3; do echo $i; done",
  });
  expect(jobs.get(h.id)?.input).toBe("for i in 1 2 3; do echo $i; done");
  expect(jobs.get(h.id)?.input.length).toBeLessThanOrEqual(INPUT_MAX);
});

const logOf = (id: string) => path.join(dir, "jobs", `${id}.log`);

test("readLog：没有日志文件时给空文本，不当越界", () => {
  const jobs = make();
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  rmSync(logOf(h.id), { force: true });
  expect(jobs.readLog(h.id)).toMatchObject({
    text: "",
    next: 0,
    headCut: false,
    missing: true,
  });
  expect(jobs.readLog(h.id, 100)).toMatchObject({ text: "", missing: true });
});

test("readLog：小文件从头读完，next 指向末尾", () => {
  const jobs = make();
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  h.write("hello\nworld\n");
  const chunk = jobs.readLog(h.id);
  expect(chunk.text).toBe("hello\nworld\n");
  expect(chunk.from).toBe(0);
  expect(chunk.next).toBe(12);
  expect(chunk.headCut).toBe(false);
});

test("readLog：文件比尾部上限大时只取最后 256 KB，起点对齐到换行之后并标 headCut", () => {
  const jobs = make();
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  const line = `${"x".repeat(99)}\n`;
  h.write(line.repeat(4000)); // 400 KB
  const chunk = jobs.readLog(h.id);
  expect(chunk.headCut).toBe(true);
  expect(chunk.from).toBeGreaterThan(0);
  expect(chunk.text.startsWith("x")).toBe(true);
  expect(chunk.text.endsWith("\n")).toBe(true);
  // 起点再对齐到下一个行首，所以略少于 256 KB
  expect(chunk.next - chunk.from).toBeGreaterThan(256 * 1024 - 200);
  expect(chunk.next - chunk.from).toBeLessThanOrEqual(256 * 1024);
});

test("readLog：给了 from 就从那里往后读，一次最多 1 MB", () => {
  const jobs = make();
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  h.write("0123456789");
  const first = jobs.readLog(h.id);
  expect(first.text).toBe("0123456789");
  h.write("abc");
  const more = jobs.readLog(h.id, first.next);
  expect(more).toMatchObject({
    text: "abc",
    from: 10,
    next: 13,
    headCut: false,
  });
  // 一口气写的超过 1 MB：只给 1 MB，剩下的下次再取
  const big = jobs.register("s1", {
    kind: "command",
    name: "bash",
    label: "big",
  });
  big.write("y".repeat(1024 * 1024 + 500));
  const chunk = jobs.readLog(big.id, 0);
  expect(chunk.next).toBe(1024 * 1024);
  expect(chunk.text).toHaveLength(1024 * 1024);
});

test("readLog：不在多字节字符中间截断，next 退到该字符起点", () => {
  const jobs = make();
  const h = jobs.register("s1", { kind: "command", name: "bash", label: "a" });
  // 每个汉字 3 字节：写到 1 MB 边界处正好切在一个汉字中间
  const prefix = "a".repeat(1024 * 1024 - 1);
  h.write(prefix);
  h.write("汉字");
  const chunk = jobs.readLog(h.id, 0);
  expect(chunk.next).toBe(1024 * 1024 - 1);
  expect(chunk.text).toHaveLength(1024 * 1024 - 1);
  const rest = jobs.readLog(h.id, chunk.next);
  expect(rest.text).toBe("汉字");
  expect(rest.next).toBe(Buffer.byteLength(prefix) + 6);
});
