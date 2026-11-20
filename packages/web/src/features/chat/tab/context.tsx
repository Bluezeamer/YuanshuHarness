// 对话标签需要、但 TabRenderProps 里没有的会话元信息，由壳提供。
// 缺省（没有 Provider 或查不到该会话）时界面用 sessionId 兜底，并按「运行中」处理。

import { createContext, useContext } from "react";
import type { SessionStatus } from "../../../api/sessionLibrary";

/** agent 现在工作的目录：在哪台主机、哪个路径（页脚用） */
export interface WorkingPlace {
  /** 布局里的主机 id（Server 本机是 "server"） */
  host: string;
  hostName: string;
  path: string;
}

export interface SessionMeta {
  title: string;
  agentName: string;
  status: SessionStatus;
  place?: WorkingPlace;
}

export interface ChatTabEnv {
  /** 取会话元信息；壳在会话列表变化时换新这个函数，对话标签随之重渲染 */
  meta(sessionId: string): SessionMeta | undefined;
  /** 对话标签里改了会话状态（恢复会话）后通知壳刷新会话列表 */
  changed?(sessionId: string): void;
  /** 输入框里 Enter 是发送（默认）；手机上没有 Shift，回车是换行，发送靠按钮 */
  enterSends?: boolean;
}

export const ChatTabContext = createContext<ChatTabEnv | null>(null);

export function useSessionMeta(sessionId: string): SessionMeta | undefined {
  return useContext(ChatTabContext)?.meta(sessionId);
}

export function useSessionChanged(): ((sessionId: string) => void) | undefined {
  return useContext(ChatTabContext)?.changed;
}

export function useEnterSends(): boolean {
  return useContext(ChatTabContext)?.enterSends ?? true;
}
