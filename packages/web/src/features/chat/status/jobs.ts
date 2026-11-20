// 右栏「后台任务」块要显示哪些：只有在跑的，一结束就从块里消失（结果在对话流的回调卡里找）。
// 子代理 / 团队成员 / 工作流有各自的块，不在这里重复。

import type { JobInfo } from "../../../api";

export function visibleJobs(all: readonly JobInfo[]): JobInfo[] {
  return all
    .filter(
      (j) =>
        j.state === "running" &&
        j.kind !== "subagent" &&
        j.name !== "workflow_run",
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
