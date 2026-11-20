import { useCallback } from "react";
import type { JobSnapshot } from "../../../api";
import { useLayoutStore } from "../../workspace/layoutContext";
import { panesOf } from "../../workspace/model/l2";
import { useOpenExecution } from "../exec/useOpenExecution";
import { execOf } from "./jobModel";
import { rememberJob } from "./names";

/**
 * 点后台任务（回调卡、右栏）的处理：子代理 / 团队成员去它们的执行体标签，
 * 其余在 pid 窗格开一个任务标签；当前窗口里已有这个任务的标签就激活它。
 * sessionId 是任务所属会话（对话标签自己、或执行体标签里那个子会话）。
 */
export function useOpenJob(
  sessionId: string,
  pid: string,
): (job: JobSnapshot) => void {
  const store = useLayoutStore();
  const openExec = useOpenExecution(sessionId, pid);
  return useCallback(
    (job) => {
      const exec = execOf(job);
      if (exec) {
        openExec(exec);
        return;
      }
      const st = store.getState().doc.windows;
      const win = st.list[st.active];
      for (const p of win ? panesOf(win) : []) {
        const hit = p.tabs.find((t) => t.type === "job" && t.job === job.id);
        if (hit) {
          store.activateTab(p.pid, hit.id);
          return;
        }
      }
      rememberJob(job);
      store.openTab(pid, "job", { sid: sessionId, job: job.id });
    },
    [store, openExec, sessionId, pid],
  );
}
