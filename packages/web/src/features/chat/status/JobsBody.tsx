import { type JobInfo, type JobSnapshot, stopJob } from "../../../api";
import { loadToken } from "../../../api/http";
import {
  ConfirmButton,
  fmtDateTime,
  ListRow,
  PeekCard,
  toast,
} from "../../../ui";
import { jobKind, ranText } from "../job/jobModel";
import { StatusMark } from "./SubTree";

/** 后台任务块：一行一个在跑的任务（状态点、简述、已用时），悬停出停止，点开去任务标签 */
export function JobsBody({
  jobs,
  now,
  onOpen,
  onChanged,
}: {
  jobs: readonly JobInfo[];
  now: number;
  onOpen(job: JobSnapshot): void;
  /** 停止之后让清单重取 */
  onChanged(): void;
}) {
  const stop = async (id: string) => {
    const r = await stopJob(loadToken(), id);
    if (!r.ok) toast("停止没有成功，请重试", { tone: "danger" });
    onChanged();
  };
  return (
    <ul className="ch-tree" data-jobs="">
      {jobs.map((j) => {
        const ran = ranText(j, now);
        return (
          <li key={j.id} data-job={j.id} data-state={j.state}>
            <ListRow
              size="compact"
              lead={<StatusMark status="live" />}
              label={j.label}
              trail={<span className="t-mono">{ran}</span>}
              actions={
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  armedLabel="确认停止"
                  onConfirm={() => void stop(j.id)}
                >
                  停止
                </ConfirmButton>
              }
              onClick={() => onOpen(j)}
              peek={
                <PeekCard
                  title={j.label}
                  {...(j.input ? { text: j.input } : {})}
                  facts={[
                    ["种类", jobKind(j)],
                    ["用时", ran],
                    ["开始于", fmtDateTime(j.startedAt)],
                  ]}
                />
              }
            />
          </li>
        );
      })}
    </ul>
  );
}
