// 后台任务标签：一行头（状态、种类、用时、退出码、复制命令、停止）
// + 完整命令（或工具参数）+ 实时输出（贴底跟随；上翻就停，出「回到底部」）。
// 数据：任务详情在跑时每 2 秒重取，日志按字节偏移增量续取（hooks 见 useJob / useJobLog）。

import { useMemo, useState } from "react";
import { type JobInfo, stopJob } from "../../../api";
import { loadToken } from "../../../api/http";
import {
  Button,
  Chip,
  ConfirmButton,
  Dot,
  Empty,
  IconButton,
  InlineNotice,
  Loading,
  toast,
} from "../../../ui";
import { copyText } from "../../../ui/clipboard";
import { CheckIcon, CopyIcon } from "../../../ui/icons";
import { useNow } from "../status/useNow";
import { useStickyScroll } from "../tab/scroll";
import {
  cleanLog,
  exitText,
  inputText,
  jobKind,
  jobState,
  ranText,
} from "./jobModel";
import { useJob } from "./useJob";
import { useJobLog } from "./useJobLog";

export function JobView({ jobId }: { jobId: string }) {
  const found = useJob(jobId);
  if (found.phase === "ready")
    return <JobBody job={found.job} refresh={found.refresh} />;
  return (
    <div className="ch-jv" data-phase={found.phase}>
      {found.phase === "loading" && <Loading>载入任务…</Loading>}
      {found.phase === "missing" && (
        <Empty
          title="这个任务不存在"
          description="它可能已被清理，或所属会话已被删除。"
        />
      )}
      {found.phase === "error" && (
        <Empty
          tone="danger"
          title="无法载入任务"
          description="请求没有成功。"
          action={
            <Button size="sm" onClick={found.retry}>
              重试
            </Button>
          }
        />
      )}
    </div>
  );
}

function JobBody({ job, refresh }: { job: JobInfo; refresh(): void }) {
  const running = job.state === "running";
  const now = useNow(running, 1000);
  const log = useJobLog(job.id);
  const text = useMemo(() => cleanLog(log.text), [log.text]);
  const { ref, onScroll, away, toBottom } = useStickyScroll(text.length);
  const [stopping, setStopping] = useState(false);
  const st = jobState(job);
  const input = inputText(job);
  const exit = exitText(job);
  const ran = ranText(job, now);

  const stop = async () => {
    setStopping(true);
    const r = await stopJob(loadToken(), job.id);
    setStopping(false);
    if (!r.ok) toast("停止没有成功，请重试", { tone: "danger" });
    refresh();
  };
  const copy = async () => {
    if (await copyText(input)) toast("已复制", { tone: "ok" });
    else toast("复制失败", { tone: "danger" });
  };

  return (
    <div
      className="ch-jv"
      data-phase="ready"
      data-job-view={job.id}
      data-job-state={job.state}
    >
      <header className="ch-jv-head">
        {st.tone === "ok" ? (
          <CheckIcon size={12} />
        ) : (
          <Dot
            size="sm"
            tone={
              st.tone === "run"
                ? "live"
                : st.tone === "failed"
                  ? "danger"
                  : "idle"
            }
            {...(st.tone === "run" ? { motion: "pulse" as const } : {})}
          />
        )}
        <span className="t-entry" data-jv="state" data-tone={st.tone}>
          {st.word}
        </span>
        <Chip>{jobKind(job)}</Chip>
        <span className="ch-jv-gap" />
        <span className="ch-jv-meta t-aux" data-jv="meta">
          {[ran, exit].filter(Boolean).join(" · ")}
        </span>
        {input !== "" && (
          <IconButton
            size="sm"
            label={job.kind === "command" ? "复制命令" : "复制参数"}
            icon={<CopyIcon size={14} />}
            onClick={() => void copy()}
          />
        )}
        {running && (
          <ConfirmButton
            size="sm"
            armedLabel="确认停止"
            disabled={stopping}
            onConfirm={() => void stop()}
          >
            停止
          </ConfirmButton>
        )}
      </header>
      {input !== "" && (
        <section className="ch-jv-sec" aria-label="输入">
          <div className="ch-jv-sec-h t-group">
            {job.kind === "command" ? "命令" : "参数"}
          </div>
          <pre className="ch-jv-code t-code" data-jv="input">
            {input}
          </pre>
        </section>
      )}
      <section className="ch-jv-sec ch-jv-out" aria-label="输出">
        <div className="ch-jv-sec-h">
          <span className="t-group">输出</span>
          {log.cut && <span className="t-aux">已省略更早的输出</span>}
          {log.failed && (
            <span className="t-aux" data-jv="retrying">
              读取失败，正在重试…
            </span>
          )}
        </div>
        <div className="ch-jv-log-wrap">
          <div
            ref={ref}
            role="log"
            aria-label="任务输出"
            className="ch-jv-log"
            onScroll={onScroll}
          >
            {text === "" ? (
              <p className="ch-jv-none t-aux" data-jv="empty">
                {log.ended || !running ? "没有输出" : "还没有输出…"}
              </p>
            ) : (
              <pre className="ch-jv-pre t-code" data-jv="log">
                {text}
              </pre>
            )}
          </div>
          {away && (
            <Button size="sm" className="ch-tobottom" onClick={toBottom}>
              回到底部
            </Button>
          )}
        </div>
      </section>
      {job.state === "interrupted" && (
        <InlineNotice tone="warn">
          Server 重启时这个任务被中断，没有结果；上面是中断前已写下的输出。
        </InlineNotice>
      )}
    </div>
  );
}
