import { createContext, useContext } from "react";
import type { SessionInfo } from "../api";
import type { SessionHub } from "../sessions/hub";
import type { OpenRequest } from "./doc";
import type { PaneBinding } from "./types";

export interface WorkbenchEnv {
  hub: SessionHub;
  sessions: SessionInfo[];
  // rail 上选中的活动会话：follow 的 pane 跟着它走，fixed 的 pane 不动。
  activeSessionId: string | null;
  // 打开新建会话面板；创建成功并刷新列表后以新会话 id 回调。
  newSession?: (done: (sessionId: string) => void) => void;
  // 经打开路由开内容面板（文件管理器点文件开预览等）：已开则切换，否则加入同类 tab 组或分屏。
  openContent?: (req: OpenRequest) => void;
}

export const EnvContext = createContext<WorkbenchEnv | null>(null);

// pane 实际绑定的会话与主机。host 目前只来自钉住时记下的值：
// 会话列表还不带环境信息，follow 面板的主机待服务端补上后在这里统一解析。
export function resolveBound(
  binding: PaneBinding,
  activeSessionId: string | null,
): { sessionId: string | null; host: string | null } {
  return binding.mode === "fixed"
    ? { sessionId: binding.sessionId, host: binding.host }
    : { sessionId: activeSessionId, host: null };
}

// 面板组件取自己所绑定的会话 / 主机的唯一入口。
export function useBound(binding: PaneBinding) {
  return resolveBound(binding, useContext(EnvContext)?.activeSessionId ?? null);
}
