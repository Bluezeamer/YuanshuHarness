import { createContext, useContext } from "react";

// 对话正文里渲染图片需要会话上下文（相对路径按会话 directory 解析）。
export const SessionIdContext = createContext<string | undefined>(undefined);

export const useSessionId = (): string | undefined =>
  useContext(SessionIdContext);
