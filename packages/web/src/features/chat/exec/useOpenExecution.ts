import { useCallback } from "react";
import { useLayoutStore } from "../../workspace/layoutContext";
import { panesOf } from "../../workspace/model/l2";

/**
 * 点执行体行的处理：当前窗口里已有这个执行体的标签就激活它，没有才在 pid 窗格新开一个 sub 标签。
 * 给 ContextRail 的 onOpenExecution 用；pid 是对话标签所在的窗格（TabRenderProps.pane.pid）。
 */
export function useOpenExecution(
  sessionId: string,
  pid: string,
): (execId: string) => void {
  const store = useLayoutStore();
  return useCallback(
    (execId) => {
      const st = store.getState().doc.windows;
      const win = st.list[st.active];
      for (const p of win ? panesOf(win) : []) {
        const hit = p.tabs.find((t) => t.type === "sub" && t.sub === execId);
        if (hit) {
          store.activateTab(p.pid, hit.id);
          return;
        }
      }
      store.openTab(pid, "sub", { sid: sessionId, sub: execId });
    },
    [store, sessionId, pid],
  );
}
