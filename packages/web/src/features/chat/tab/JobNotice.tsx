// 对话流里的后台任务回调卡：一行，说清「哪个任务、什么结果、用了多久」，也就是模型因此被唤醒的那件事。
// 点开去任务标签（完整命令与输出）；子代理 / 团队成员去它们自己的执行体标签。

import type { JobSnapshot } from "../../../api";
import { Button, Dot } from "../../../ui";
import { CheckIcon, ChevronRightIcon } from "../../../ui/icons";
import {
  exitText,
  type JobTone,
  jobKind,
  jobState,
  ranText,
} from "../job/jobModel";

const Mark = ({ tone }: { tone: JobTone }) =>
  tone === "ok" ? (
    <CheckIcon size={12} />
  ) : (
    <Dot size="sm" tone={tone === "failed" ? "danger" : "idle"} />
  );

export function JobNoticeCard({
  job,
  onOpen,
}: {
  job: JobSnapshot;
  /** 不给就是只读的一行（比如在没有标签可开的地方） */
  onOpen?: (job: JobSnapshot) => void;
}) {
  const { tone, word } = jobState(job);
  const tail = [word, ranText(job, 0), exitText(job)].filter(Boolean);
  const body = (
    <>
      <Mark tone={tone} />
      <span className="ch-job-kind t-aux">{jobKind(job)}</span>
      <span className="ch-job-label t-entry">{job.label}</span>
      <span className="ch-job-state t-aux" data-tone={tone}>
        {tail.join(" · ")}
      </span>
      {onOpen && <ChevronRightIcon className="ch-job-x" size={12} />}
    </>
  );
  return (
    <div className="ch-job" data-job-notice={job.id} data-state={job.state}>
      {onOpen ? (
        <Button
          variant="ghost"
          size="sm"
          className="ch-job-h"
          onClick={() => onOpen(job)}
        >
          {body}
        </Button>
      ) : (
        <div className="ch-job-h">{body}</div>
      )}
    </div>
  );
}
