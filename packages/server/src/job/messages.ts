// 后台任务给模型看的文字（框架口吻，英文）：回调、提醒、列表。纯函数，便于单测。
import type { JobRow } from "../store/jobs.js";

export const TAIL_LINES = 20;

/** 回调消息的 details：界面卡片用，不含完整命令与输出 */
export interface JobSnapshot {
  id: string;
  kind: JobRow["kind"];
  name: string;
  label: string;
  /** 子代理任务的子会话 id */
  ref: string | null;
  state: JobRow["state"];
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export const snapshotOf = (row: JobRow): JobSnapshot => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  label: row.label,
  ref: row.ref,
  state: row.state,
  exitCode: row.exitCode,
  startedAt: row.startedAt,
  endedAt: row.endedAt,
});

/** 团队成员登记成的任务名：任务工具与提醒文案据此区别于普通子代理（team.md §2） */
export const TEAM_MEMBER = "team_member";
/** 动态工作流里 agent() 派出的子代理登记成的任务名：在任务清单里不列，整次运行只占 workflow_run 那一行 */
export const WORKFLOW_AGENT = "workflow_agent";

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}

const head = (row: JobRow) => `${row.id} "${row.label}" (${row.name})`;

const tailBlock = (tail: string) =>
  tail === "" ? "\n(no output)" : `\nEnd of the output:\n${tail}`;

const OUTCOME: Record<JobRow["state"], (r: JobRow) => string> = {
  running: () => "is still running",
  done: (r) =>
    r.exitCode === null ? "finished" : `finished with exit code ${r.exitCode}`,
  failed: (r) =>
    r.exitCode === null ? "failed" : `failed with exit code ${r.exitCode}`,
  stopped: () => "was stopped",
  interrupted: () => "was interrupted because the server restarted",
};

/** 终态回调：任务结束时送给直接调用方 */
export function finishedText(row: JobRow, tail: string): string {
  const ran = duration(
    (row.endedAt ? Date.parse(row.endedAt) : Date.now()) -
      Date.parse(row.startedAt),
  );
  const note =
    row.state === "interrupted"
      ? "\nIt has no result; decide yourself whether to start it again."
      : "";
  return `[Background job ${head(row)} ${OUTCOME[row.state](row)} after ${ran}]${
    row.state === "interrupted" ? "" : tailBlock(tail)
  }${note}\nRead more of the log with job_list { "id": "${row.id}", "lines": N }.`;
}

/** 周期提醒：只把控制权还给调用方，任务继续跑 */
export function reminderText(
  row: JobRow,
  tail: string,
  ranMs: number,
  quietMs: number,
): string {
  return `[Background job ${head(row)} is still running]
Running for ${duration(ranMs)}; last output ${duration(quietMs)} ago.${tailBlock(tail)}
This is only a reminder: the job keeps running. Keep working or end your turn, and you will be notified when it finishes. Don't poll. Options: ${
    row.name === TEAM_MEMBER
      ? `team_status to check on the team, post { "to": "${row.label}", "text": ... } to tell this member something, team_stop { "member": "${row.label}" } to stop it.`
      : `job_list { "id": "${row.id}" } to read more of the log, job_remind to change the reminder interval, job_stop to stop it.`
  }`;
}

/** 阻塞调用到了提醒时间：这次调用先返回，命令转成后台任务继续跑 */
export function detachedText(row: JobRow, tail: string, ranMs: number): string {
  return `The command is still running after ${duration(ranMs)}. It was NOT stopped: it continues in the background as job ${row.id}.${tailBlock(tail)}
You will be notified when it finishes${row.remindMs > 0 ? ` (and every ${duration(row.remindMs)} while it runs)` : ""}. Don't poll: do other work, or end your turn. Options: job_list { "id": "${row.id}" } to read the log, job_stop to stop it.`;
}

/** 上一个进程里在跑的任务因重启中断，下次发消息前告知 */
export function interruptedNotice(row: JobRow): string {
  return `[System notice] Background job ${head(row)} was interrupted because the server restarted; it has no result. ${
    row.name === TEAM_MEMBER
      ? `It stays on the team roster: post { "to": "${row.label}", "text": ... } wakes it up again.`
      : "Decide yourself whether to start it again."
  }`;
}

const STATE_WORD: Record<JobRow["state"], string> = {
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  interrupted: "interrupted",
};

/** job_list 的一行 */
export function listLine(row: JobRow, now = Date.now()): string {
  const ran = duration(
    (row.endedAt ? Date.parse(row.endedAt) : now) - Date.parse(row.startedAt),
  );
  return [
    row.id,
    `${STATE_WORD[row.state]}${row.exitCode !== null ? ` (exit ${row.exitCode})` : ""} ${ran}`,
    row.name,
    `"${row.label}"`,
    row.state === "running" && row.remindMs > 0
      ? `remind every ${duration(row.remindMs)}`
      : row.state === "running"
        ? "no reminder"
        : null,
  ]
    .filter(Boolean)
    .join(" | ");
}
