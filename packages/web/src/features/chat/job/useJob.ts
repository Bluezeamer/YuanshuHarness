import { useCallback, useEffect, useRef, useState } from "react";
import { getJob, type JobInfo } from "../../../api";
import { loadToken } from "../../../api/http";
import { rememberJob } from "./names";

/** 任务还在跑时多久重取一次状态（用时与结束要及时看到） */
export const JOB_POLL_MS = 2000;

export type JobLookup =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "error"; retry(): void }
  | { phase: "ready"; job: JobInfo; refresh(): void };

type Box =
  | { id: string; phase: "loading" | "missing" | "error" }
  | { id: string; phase: "ready"; job: JobInfo };

/** 取一个后台任务的详情；在跑就每 2 秒重取。换任务时旧结果一律丢弃。 */
export function useJob(jobId: string): JobLookup {
  const [box, setBox] = useState<Box>({ id: jobId, phase: "loading" });
  const gen = useRef(0);

  const load = useCallback(() => {
    const g = ++gen.current;
    void getJob(loadToken(), jobId).then((r) => {
      if (g !== gen.current) return;
      if (r.ok) rememberJob(r.data);
      setBox((b) =>
        r.ok
          ? { id: jobId, phase: "ready", job: r.data }
          : r.kind === "not_found"
            ? { id: jobId, phase: "missing" }
            : // 轮询中偶发的失败不把已有的内容换成错误页
              b.id === jobId && b.phase === "ready"
              ? b
              : { id: jobId, phase: "error" },
      );
    });
  }, [jobId]);

  useEffect(() => {
    setBox({ id: jobId, phase: "loading" });
    load();
    return () => {
      gen.current++;
    };
  }, [jobId, load]);

  const running =
    box.id === jobId && box.phase === "ready" && box.job.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, JOB_POLL_MS);
    return () => clearInterval(t);
  }, [running, load]);

  if (box.id !== jobId || box.phase === "loading") return { phase: "loading" };
  if (box.phase === "ready")
    return { phase: "ready", job: box.job, refresh: load };
  if (box.phase === "missing") return { phase: "missing" };
  return { phase: "error", retry: load };
}
