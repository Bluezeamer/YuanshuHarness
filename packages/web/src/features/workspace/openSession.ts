import { useCallback, useEffect, useState } from "react";
import { useLayoutState, useLayoutStore } from "./layoutContext";
import {
  useCurrentWorkspace,
  useLibraryState,
} from "./library/LibraryProvider";

/**
 * 打开一个会话（单击 = 临时查看，pin = 固定）。会话所在的工作区不是当前的，就先切过去，
 * 等那份布局载入完再打开；刚新建的会话库里还没有它，也等推送把它带来再打开。
 */
export function useOpenSession(): (sid: string, pin?: boolean) => void {
  const layout = useLayoutStore();
  const current = useCurrentWorkspace();
  const sessions = useLibraryState((s) => s.sessions);
  const layoutWorkspace = useLayoutState((s) => s.workspaceId);
  const status = useLayoutState((s) => s.status);
  const [pending, setPending] = useState<{ sid: string; pin: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!pending) return;
    const workspaceId = sessions.find((s) => s.id === pending.sid)?.workspaceId;
    if (!workspaceId) return;
    if (current.id !== workspaceId) {
      current.select(workspaceId);
      return;
    }
    if (layoutWorkspace !== workspaceId || status !== "ready") return;
    if (pending.pin) layout.pinSession(pending.sid);
    else layout.showSession(pending.sid);
    setPending(null);
  }, [pending, sessions, current, layoutWorkspace, status, layout]);

  return useCallback((sid, pin = false) => setPending({ sid, pin }), []);
}
