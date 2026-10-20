import { useCallback, useState } from "react";
import type { SessionInfo } from "../api";

const KEY = "yuanshu.activeSession";

// 活动会话是这台设备上的界面上下文，不进布局文档；记住上次选的，会话已不存在时当作没选。
export function useActiveSession(sessions: SessionInfo[]) {
  const [id, setId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const select = useCallback((next: string) => {
    setId(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // 存不下就只在本次页面内生效
    }
  }, []);
  const active = id && sessions.some((s) => s.id === id) ? id : null;
  return [active, select] as const;
}
