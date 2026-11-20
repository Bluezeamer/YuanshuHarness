// 后台任务（subagent.md §2–§3）：任意一次工具调用都可以在后台跑，完成 / 到提醒时间 / 异常退出时
// 回调给直接调用方。任务都在 Server 进程里跑（命令也是），输出落盘到数据目录，Server 重启即中断。
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { HttpError } from "../lib/http-error.js";
import { JOB_REMIND_MAX_S, JOB_REMIND_MIN_S } from "../store/defaults.js";
import type { JobRow, JobState, JobStore } from "../store/jobs.js";
import {
  finishedText,
  interruptedNotice,
  reminderText,
  WORKFLOW_AGENT,
} from "./messages.js";

export class JobError extends HttpError {
  constructor(message: string) {
    super("job_error", message, 404);
  }
}

export interface JobManagerDeps {
  store: JobStore;
  /** 日志目录（数据目录下） */
  dir: string;
  /** 把一条回调送给会话；会话不在线返回 false，留待它下次发消息时由 notices 补上。
   *  给了 job 表示这是终态回调用给界面卡片用的快照（周期提醒不带）。 */
  notify: (sessionId: string, text: string, job?: JobRow) => boolean;
  /** 任务登记 / 结束 / 重开 / 改提醒时通知 owner 会话（右栏据此刷新）；缺省不做。 */
  changed?: (sessionId: string) => void;
  /** 全局默认提醒间隔（毫秒）；调用时可覆盖，0 = 不提醒 */
  remindMs: () => number;
}

/** 任务自己的结局 */
export interface JobOutcome {
  ok: boolean;
  exitCode?: number | null;
  /** 工具的结果文字；命令的输出已经流式写进日志，不用再给 */
  text?: string;
  /** 原样的工具结果，只用于观察期内结束时直接返回给调用方，不落库 */
  result?: unknown;
  /** 回调给调用方的正文；缺省按任务的通用格式（状态 + 日志末尾）写 */
  callback?: string;
  /** 被外部停止（不是任务自己的失败）：记为 stopped */
  stopped?: boolean;
}

export interface JobHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  write(chunk: Buffer | string): void;
  end(outcome: JobOutcome): void;
  /** 阻塞调用期间 true：结束时直接作为调用的返回，不回调、不提醒；转后台时改回 false */
  inline(on: boolean): void;
}

interface Live {
  owner: string;
  abort: AbortController;
  fd: number;
  startedAt: number;
  lastOutputAt: number;
  timer?: NodeJS.Timeout;
  /** 谁停的：自己停的不回调给自己 */
  stopBy?: "owner" | "user";
  /** 阻塞调用期间 / job_start 的观察期里结束，结果直接作为那次调用的返回，不再回调 */
  inline: boolean;
  callbackText?: string;
  settled: Promise<void>;
  resolve: () => void;
}

/** job_start 启动后等多久看一眼：被拦、参数错、一闪而过的命令当场就有结果 */
const SETTLE_MS = 300;
/** 停止后等任务自己收尾的宽限，到点仍没收尾就按已停止记 */
const STOP_GRACE_MS = 3000;
const TAIL_BYTES = 64 * 1024;
const TAIL_BYTES_MAX = 4 * 1024 * 1024;
/** 界面首次拉日志时给的最后一段；更早的内容由 headCut 标为已省略 */
export const LOG_TAIL_BYTES = 256 * 1024;
/** 一次增量读取的上限；更多的下一次再拿 */
export const LOG_CHUNK_MAX = 1024 * 1024;

/** 日志一段：next 是下一次请求该传的 from */
export interface JobLogChunk {
  text: string;
  from: number;
  next: number;
  /** 前面还有内容被略去（只发生在首次取尾部时） */
  headCut: boolean;
  /** 文件大小：路由据此判断 from 是否越界、任务结束后是否已读到末尾 */
  size: number;
  /** 日志文件还不存在（刚登记没写 / 被清）：按空日志处理，不算 from 越界 */
  missing: boolean;
}

/** 去掉末尾不完整的多字节字符，返回可安全解码的字节数。 */
function completeBytes(buf: Buffer): number {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const b = buf[buf.length - back] as number;
    if ((b & 0xc0) === 0x80) continue; // 续字节：继续往前找首字节
    const need = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
    return need <= back ? buf.length : buf.length - back;
  }
  return buf.length;
}

/** 提醒间隔夹在 [下限, 上限]：太小会刷屏，太大会让 setTimeout 溢出后立即触发 */
export const clampRemindMs = (ms: number): number =>
  ms <= 0
    ? 0
    : Math.min(Math.max(ms, JOB_REMIND_MIN_S * 1000), JOB_REMIND_MAX_S * 1000);

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export class JobManager {
  private readonly live = new Map<string, Live>();
  private readonly als = new AsyncLocalStorage<JobHandle>();

  constructor(private readonly deps: JobManagerDeps) {
    deps.store.interruptRunning();
  }

  private logPath(id: string): string {
    return path.join(this.deps.dir, `${id}.log`);
  }

  defaultRemindMs(): number {
    return this.deps.remindMs();
  }

  /** 登记一个已经（或马上）在跑的任务；调用方负责在结束时 end()。 */
  register(
    owner: string,
    spec: {
      kind: JobRow["kind"];
      name: string;
      label: string;
      /** 完整命令 / 工具参数（界面详情用）；子代理这类有自己的视图，不传 */
      input?: string;
      /** 子代理任务：子会话 id */
      ref?: string;
      remindMs?: number;
      /** 任务实际开始的时间（毫秒时间戳）；阻塞命令转后台时是它最初开始的时刻 */
      startedAt?: number;
    },
    abort = new AbortController(),
  ): JobHandle {
    let id = randomBytes(4).toString("hex");
    while (this.deps.store.get(id)) id = randomBytes(4).toString("hex");
    const remindMs = clampRemindMs(spec.remindMs ?? this.deps.remindMs());
    const startedAt = spec.startedAt ?? Date.now();
    this.deps.store.create({
      id,
      sessionId: owner,
      kind: spec.kind,
      name: spec.name,
      label: spec.label,
      input: spec.input ?? "",
      ref: spec.ref ?? null,
      remindMs,
      startedAt: new Date(startedAt).toISOString(),
    });
    this.deps.changed?.(owner);
    return this.open(id, owner, startedAt, abort);
  }

  /** 给已登记的任务（新建或重新打开的）接上日志、计时与中止信号，返回句柄。 */
  private open(
    id: string,
    owner: string,
    startedAt: number,
    abort: AbortController,
  ): JobHandle {
    mkdirSync(this.deps.dir, { recursive: true });
    let resolve = () => {};
    const settled = new Promise<void>((ok) => {
      resolve = ok;
    });
    const live: Live = {
      owner,
      abort,
      fd: openSync(this.logPath(id), "a"),
      startedAt,
      lastOutputAt: Date.now(),
      inline: false,
      settled,
      resolve,
    };
    this.live.set(id, live);
    this.arm(id);
    return {
      id,
      signal: abort.signal,
      write: (chunk) => {
        if (this.live.get(id) !== live) return;
        writeSync(
          live.fd,
          typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        );
        live.lastOutputAt = Date.now();
      },
      inline: (on) => {
        live.inline = on;
      },
      end: (o) => {
        if (this.live.get(id) !== live) return;
        if (o.text) writeSync(live.fd, `${o.text}\n`);
        if (o.callback !== undefined) live.callbackText = o.callback;
        const state: Exclude<JobState, "running"> =
          live.stopBy || o.stopped ? "stopped" : o.ok ? "done" : "failed";
        this.settle(id, state, o.exitCode ?? null);
      },
    };
  }

  /** 让 fn 里发起的 bash 把输出写进这个任务的日志（job_start 内层调用用） */
  within<T>(h: JobHandle, fn: () => T): T {
    return this.als.run(h, fn);
  }

  current(): JobHandle | undefined {
    return this.als.getStore();
  }

  /** 在任务的上下文之外运行 fn：子会话的整个运行不该看到派发它的那个任务（bash 输出、spawn 的归属）。 */
  detached<T>(fn: () => T): T {
    return this.als.exit(fn);
  }

  /**
   * job_start：后台运行一次工具调用，立即返回任务 id。
   * 观察期内就结束的，结果随返回给出（settled），不再回调。
   */
  async startTool(
    owner: string,
    spec: Parameters<JobManager["register"]>[1],
    run: (h: JobHandle) => Promise<JobOutcome>,
  ): Promise<{ id: string; settled?: JobOutcome }> {
    const h = this.register(owner, spec);
    const live = this.live.get(h.id) as Live;
    live.inline = true;
    let outcome: JobOutcome | undefined;
    const done = this.within(h, () => run(h)).then(
      (o) => {
        outcome = o;
        h.end(o);
      },
      (e: unknown) => {
        outcome = {
          ok: false,
          text: e instanceof Error ? e.message : String(e),
        };
        h.end(outcome);
      },
    );
    await Promise.race([done, sleep(SETTLE_MS)]);
    if (outcome) {
      this.deps.store.markTold(h.id);
      return { id: h.id, settled: outcome };
    }
    live.inline = false;
    return { id: h.id };
  }

  private settle(
    id: string,
    state: Exclude<JobState, "running">,
    exitCode: number | null,
  ): void {
    const live = this.live.get(id);
    if (!live || !this.deps.store.finish(id, state, exitCode)) return;
    this.deps.changed?.(live.owner);
    this.live.delete(id);
    clearTimeout(live.timer);
    try {
      closeSync(live.fd);
    } catch {
      // 已关闭
    }
    live.resolve();
    if (live.inline) {
      this.deps.store.markTold(id);
      return;
    }
    if (live.stopBy === "owner") this.deps.store.markTold(id);
    else this.callback(id, live.callbackText);
  }

  private callback(id: string, text?: string): void {
    const row = this.deps.store.get(id);
    if (!row) return;
    if (
      this.deps.notify(
        row.sessionId,
        text ?? finishedText(row, this.tail(id, 20)),
        row,
      )
    )
      this.deps.store.markTold(id);
  }

  /** 把已登记的任务标成子代理（job_start 包着 spawn_subagent 时，事后才知道）。 */
  link(id: string, ref: string): void {
    this.deps.store.link(id, ref);
  }

  byRef(ref: string): JobRow | undefined {
    return this.deps.store.byRef(ref);
  }

  /** 已结束的任务（子代理被 message_subagent 唤醒）开新一轮。 */
  reopen(id: string, abort = new AbortController()): JobHandle | null {
    const row = this.deps.store.get(id);
    if (!row || this.live.has(id) || !this.deps.store.reopen(id)) return null;
    this.deps.changed?.(row.sessionId);
    return this.open(id, row.sessionId, Date.now(), abort);
  }

  private arm(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    clearTimeout(live.timer);
    const ms = this.deps.store.get(id)?.remindMs ?? 0;
    if (ms <= 0) return;
    live.timer = setTimeout(() => {
      const row = this.deps.store.get(id);
      if (row?.state === "running" && !live.inline)
        this.deps.notify(
          row.sessionId,
          reminderText(
            row,
            this.tail(id, 20),
            Date.now() - live.startedAt,
            Date.now() - live.lastOutputAt,
          ),
        );
      this.arm(id);
    }, ms);
    live.timer.unref();
  }

  get(id: string): JobRow | undefined {
    return this.deps.store.get(id);
  }

  /** 只能动自己名下的任务；别人的按不存在处理 */
  own(owner: string, id: string): JobRow {
    const row = this.deps.store.get(id);
    if (!row || row.sessionId !== owner)
      throw new JobError(`There is no job ${id} in your list.`);
    return row;
  }

  list(owner: string): JobRow[] {
    return this.deps.store.list(owner);
  }

  /** 日志末尾的 n 行；日志不存在就是空 */
  tail(id: string, lines: number): string {
    let fd: number;
    try {
      fd = openSync(this.logPath(id), "r");
    } catch {
      return "";
    }
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(
        size,
        Math.min(Math.max(TAIL_BYTES, lines * 512), TAIL_BYTES_MAX),
      );
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const all = buf.toString("utf8").replace(/\r\n/g, "\n").trimEnd();
      return all.split("\n").slice(-lines).join("\n");
    } finally {
      closeSync(fd);
    }
  }

  /**
   * 增量跟随日志：不给 from 时取最后 LOG_TAIL_BYTES 字节（起点推到下一个换行之后），
   * 给了 from 就从那里读到末尾（一次最多 LOG_CHUNK_MAX）。末尾不完整的多字节字符不算在内，
   * 下次从它的起点接着读。日志不存在时给空文本。
   */
  readLog(id: string, from?: number): JobLogChunk {
    let fd: number;
    try {
      fd = openSync(this.logPath(id), "r");
    } catch {
      return {
        text: "",
        from: 0,
        next: 0,
        headCut: false,
        size: 0,
        missing: true,
      };
    }
    try {
      const size = fstatSync(fd).size;
      let start = from ?? 0;
      let headCut = false;
      if (from === undefined) {
        start = Math.max(0, size - LOG_TAIL_BYTES);
        if (start > 0) {
          // 从下一个换行之后开始，别把半行当成开头（尾部区间本身就有限，整段找一次）
          const probe = Buffer.alloc(size - start);
          readSync(fd, probe, 0, probe.length, start);
          const nl = probe.indexOf(0x0a);
          start = nl < 0 ? size : start + nl + 1;
          headCut = true;
        }
      }
      const len = Math.min(size - start, LOG_CHUNK_MAX);
      const buf = Buffer.alloc(Math.max(0, len));
      if (len > 0) readSync(fd, buf, 0, len, start);
      const usable = completeBytes(buf);
      return {
        text: buf.subarray(0, usable).toString("utf8"),
        from: start,
        next: start + usable,
        headCut,
        size,
        missing: false,
      };
    } finally {
      closeSync(fd);
    }
  }

  setRemind(owner: string, id: string, remindMs: number): JobRow {
    this.own(owner, id);
    this.deps.store.setRemind(id, clampRemindMs(remindMs));
    this.arm(id);
    this.deps.changed?.(owner);
    return this.own(owner, id);
  }

  /** 一个任务名下仍在运行的一切：子代理的话是它自己的后台任务与子代理，一层层往下。 */
  private underneath(row: JobRow): string[] {
    if (row.ref === null) return [];
    return this.deps.store
      .list(row.ref)
      .filter((r) => r.state === "running")
      .flatMap((r) => [r.id, ...this.underneath(r)]);
  }

  /** 停止并返回一并停掉的任务 id（含它名下的一切）。 */
  async stop(
    owner: string,
    id: string,
    by: "owner" | "user",
  ): Promise<string[]> {
    const row = this.own(owner, id);
    if (row.state !== "running") return [];
    const all = [id, ...this.underneath(row)];
    await this.stopLive(id, by);
    return all;
  }

  /** 该会话名下全部运行中的任务一并停止（会话被删除、子代理被停止时） */
  async stopOwned(owner: string, by: "owner" | "user"): Promise<string[]> {
    const ids = this.deps.store
      .list(owner)
      .filter((r) => r.state === "running")
      .map((r) => r.id);
    await Promise.all(ids.map((id) => this.stopLive(id, by)));
    return ids;
  }

  private async stopLive(id: string, by: "owner" | "user"): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    live.stopBy ??= by;
    live.abort.abort();
    await Promise.race([live.settled, sleep(STOP_GRACE_MS)]);
    this.settle(id, "stopped", null);
  }

  /** 重启后第一次发消息前：还没告知调用方的终态任务（当时不在线，或重启中断） */
  notices(owner: string): { text: string; job: JobRow }[] {
    const rows = this.deps.store.untold(owner);
    for (const r of rows) this.deps.store.markTold(r.id);
    // 工作流里的 agent 由整次运行那一行代为说明，不各发一条
    return rows
      .filter((r) => r.name !== WORKFLOW_AGENT)
      .map((r) => ({
        text:
          r.state === "interrupted"
            ? interruptedNotice(r)
            : finishedText(r, this.tail(r.id, 20)),
        job: r,
      }));
  }

  removeSession(owner: string): void {
    for (const r of this.deps.store.list(owner)) {
      const live = this.live.get(r.id);
      if (live) {
        live.abort.abort();
        clearTimeout(live.timer);
        closeSync(live.fd);
        this.live.delete(r.id);
        live.resolve();
      }
      rmSync(this.logPath(r.id), { force: true });
    }
    this.deps.store.removeSession(owner);
  }

  /** Server 关闭：全部中止并记为中断，下次启动时调用方会被告知 */
  shutdown(): void {
    for (const [id, live] of this.live) {
      clearTimeout(live.timer);
      live.abort.abort();
      this.deps.store.finish(id, "interrupted", null);
      closeSync(live.fd);
      live.resolve();
    }
    this.live.clear();
  }
}
