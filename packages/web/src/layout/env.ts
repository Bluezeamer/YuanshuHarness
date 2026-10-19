import { createContext } from "react";
import type { SessionInfo } from "../api";
import type { SessionHub } from "../sessions/hub";

export interface WorkbenchEnv {
  hub: SessionHub;
  sessions: SessionInfo[];
  // 打开新建会话面板；创建成功并刷新列表后以新会话 id 回调。
  newSession?: (done: (sessionId: string) => void) => void;
}

export const EnvContext = createContext<WorkbenchEnv | null>(null);
