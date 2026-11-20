import { useEffect, useState } from "react";
import { jobLog } from "../../../api";
import { loadToken } from "../../../api/http";
import { appendLog } from "./jobModel";

/** 日志多久续取一次 */
export const LOG_POLL_MS = 1000;

export interface JobLogState {
  /** 原始日志文本（含终端控制序列，显示前要 cleanLog） */
  text: string;
  /** 更早的输出没有显示：服务端只给尾部，或客户端缓冲被截 */
  cut: boolean;
  /** 任务已结束且日志读到了末尾 */
  ended: boolean;
  /** 最近一次请求失败（会自动重试） */
  failed: boolean;
}

const empty: JobLogState = {
  text: "",
  cut: false,
  ended: false,
  failed: false,
};

/**
 * 跟随一个任务的日志：首次取尾部，之后按字节偏移增量续取，直到服务端说读完了。
 * 请求失败时放慢重试；任务记录不存在就当读完了。
 */
export function useJobLog(jobId: string): JobLogState {
  const [log, setLog] = useState<JobLogState>(empty);

  useEffect(() => {
    setLog(empty);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let from: number | undefined;
    let raw = "";
    let cut = false;
    const pull = async () => {
      const r = await jobLog(loadToken(), jobId, from);
      if (!alive) return;
      if (!r.ok) {
        if (r.kind === "not_found") {
          setLog((l) => ({ ...l, ended: true, failed: false }));
          return;
        }
        setLog((l) => ({ ...l, failed: true }));
        timer = setTimeout(() => void pull(), LOG_POLL_MS * 3);
        return;
      }
      const d = r.data;
      const joined = appendLog(raw, d.text);
      raw = joined.text;
      cut = cut || d.headCut || joined.cut;
      from = d.next;
      setLog({ text: raw, cut, ended: d.ended, failed: false });
      if (!d.ended) timer = setTimeout(() => void pull(), LOG_POLL_MS);
    };
    void pull();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [jobId]);

  return log;
}
