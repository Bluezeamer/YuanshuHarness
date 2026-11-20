import { call, enc } from "./http";

// 后台任务（subagent.md §2–§3）
export type JobState =
  | "running"
  | "done"
  | "failed"
  | "stopped"
  | "interrupted";

export type JobKind = "command" | "tool" | "subagent";

/** 回调卡片与右栏用的任务快照：不含完整命令与输出 */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  /** 被后台运行的工具名；工作流 / 团队成员另有固定的名字 */
  name: string;
  label: string;
  /** 子代理任务：子会话 id */
  ref: string | null;
  state: JobState;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface JobInfo extends JobSnapshot {
  sessionId: string;
  /** 提醒间隔（毫秒），0 = 不提醒 */
  remindMs: number;
  /** 完整命令（bash）或参数 JSON（其他工具）；子代理 / 工作流为空 */
  input: string;
}

export const listJobs = (token: string | null, session: string) =>
  call(
    "GET",
    `/api/v1/sessions/${enc(session)}/jobs`,
    token,
    undefined,
    (b: { jobs: JobInfo[] }) => {
      if (!Array.isArray(b.jobs)) throw new Error("shape");
      return b.jobs;
    },
  );

export const getJob = (token: string | null, id: string) =>
  call(
    "GET",
    `/api/v1/jobs/${enc(id)}`,
    token,
    undefined,
    (b: { job: JobInfo }) => {
      if (typeof b.job?.id !== "string") throw new Error("shape");
      return b.job;
    },
  );

/** 日志的一段：from 是请求的起点（没给 from 时是服务端选的尾部起点），next 是下一次该传的 from */
export interface JobLogChunk {
  text: string;
  from: number;
  next: number;
  /** 起点之前还有内容被略去（只出现在没给 from 的首次请求） */
  headCut: boolean;
  /** 任务已结束且这次已读到末尾，不必再取 */
  ended: boolean;
}

export const jobLog = (token: string | null, id: string, from?: number) =>
  call(
    "GET",
    `/api/v1/jobs/${enc(id)}/log${from === undefined ? "" : `?from=${from}`}`,
    token,
    undefined,
    (b: JobLogChunk) => {
      if (typeof b.text !== "string" || typeof b.next !== "number")
        throw new Error("shape");
      return b;
    },
  );

export const stopJob = (token: string | null, id: string) =>
  call(
    "POST",
    `/api/v1/jobs/${enc(id)}/stop`,
    token,
    undefined,
    (b: { job: JobInfo | null }) => b.job,
  );
