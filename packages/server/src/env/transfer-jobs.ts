// 后台传输任务：POST 立即返回，调用方轮询进度。任务只在内存里，Server 重启即丢。
import { uuidv7 } from "../id.js";
import type { AuditLog } from "../store/audit.js";
import { type TransferEnd, TransferError, transfer } from "./transfer.js";

export interface TransferJob {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  from: { env: string; path: string };
  to: { env: string; path: string };
  sessionId: string | null;
  startedAt: string;
  finishedAt?: string;
  /** 扫描阶段为 null，之后是待复制的文件总数。 */
  totalFiles: number | null;
  totalBytes: number | null;
  files: number;
  bytes: number;
  skippedLinks?: number;
  error?: { code: string; message: string };
}

/** 最多保留的任务数；超出时丢弃最早的已结束任务。 */
export const JOBS_KEEP = 100;

interface TransferAudit {
  from: TransferEnd;
  to: TransferEnd;
  sessionId: string | null;
  /** 缺省是用户（界面拖拽）；模型经 transfer_files 触发时为 agent。 */
  actor?: "user" | "agent";
  outcome: string;
  durationMs: number;
  files?: number;
  bytes?: number;
}

// 同步接口与后台任务共用的审计格式：只记端点与统计，不含内容。
export function recordTransfer(audit: AuditLog | undefined, t: TransferAudit) {
  const target = `${t.from.env.id}:${t.from.path} -> ${t.to.env.id}:${t.to.path}`;
  audit?.record({
    sessionId: t.sessionId,
    actor: t.actor ?? "user",
    kind: "transfer",
    environmentId: t.to.env.id,
    summary: `transfer ${t.outcome}: ${target}`,
    detail: {
      op: "transfer",
      target,
      result: t.outcome === "ok" ? "ok" : "error",
      outcome: t.outcome,
      durationMs: t.durationMs,
      ...(t.files === undefined ? {} : { files: t.files, bytes: t.bytes }),
    },
  });
}

const end = (e: TransferEnd) => ({ env: e.env.id, path: e.path });

export class TransferJobs {
  private readonly jobs = new Map<string, TransferJob>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly audit?: AuditLog) {}

  get(id: string): TransferJob | undefined {
    return this.jobs.get(id);
  }

  /** 请求取消：当前文件写到一半的临时文件会被清掉，已完成的文件不回滚。状态在传输真正停下后才变。 */
  cancel(id: string): TransferJob | undefined {
    this.aborts.get(id)?.abort();
    return this.jobs.get(id);
  }

  start(
    from: TransferEnd,
    to: TransferEnd,
    opts: { overwrite: boolean; sessionId: string | null },
  ): TransferJob {
    const job: TransferJob = {
      id: uuidv7(),
      state: "running",
      from: end(from),
      to: end(to),
      sessionId: opts.sessionId,
      startedAt: new Date().toISOString(),
      totalFiles: null,
      totalBytes: null,
      files: 0,
      bytes: 0,
    };
    this.jobs.set(job.id, job);
    this.evict();
    const ctl = new AbortController();
    this.aborts.set(job.id, ctl);
    const t0 = Date.now();
    const base = { from, to, sessionId: opts.sessionId };
    transfer(from, to, {
      overwrite: opts.overwrite,
      signal: ctl.signal,
      onProgress: (p) => Object.assign(job, p),
    }).then(
      (r) => {
        this.aborts.delete(job.id);
        job.state = "done";
        job.skippedLinks = r.skippedLinks;
        job.finishedAt = new Date().toISOString();
        recordTransfer(this.audit, {
          ...base,
          outcome: "ok",
          durationMs: Date.now() - t0,
          files: r.files,
          bytes: r.bytes,
        });
      },
      (err: unknown) => {
        this.aborts.delete(job.id);
        const cancelled = ctl.signal.aborted;
        const code = cancelled
          ? "cancelled"
          : err instanceof TransferError
            ? err.code
            : "copy_failed";
        job.state = cancelled ? "cancelled" : "failed";
        job.error = {
          code,
          message: cancelled
            ? "已取消，已完成的文件未回滚"
            : err instanceof Error
              ? err.message
              : String(err),
        };
        job.finishedAt = new Date().toISOString();
        recordTransfer(this.audit, {
          ...base,
          outcome: code,
          durationMs: Date.now() - t0,
        });
      },
    );
    return job;
  }

  private evict(): void {
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= JOBS_KEEP) return;
      if (j.state !== "running") this.jobs.delete(id);
    }
  }
}
