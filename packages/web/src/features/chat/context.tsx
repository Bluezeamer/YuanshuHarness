// 对话数据层的 Provider：持有令牌与 401 回调，向下提供按会话共享的 hub。无样式。

import {
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react";
import { ChatHub } from "./store/hub";

export const ChatContext = createContext<ChatHub | null>(null);

/** 没有 Provider 时返回 null：文件标签/预览等在独立渲染（测试、单标签预览）里也能工作。 */
export const useChatHubOptional = (): ChatHub | null => useContext(ChatContext);

export interface ChatProviderProps {
  /** 访问令牌；连接与每次重连都取当前值 */
  token: string | null;
  /** 令牌失效（重连探测返回 401）时通知外壳 */
  onUnauthorized: () => void;
  children?: ReactNode;
}

export function ChatProvider({
  token,
  onUnauthorized,
  children,
}: ChatProviderProps) {
  // 令牌与回调随时可能换新，hub 只读最新值，不因此重建。
  const latest = useRef({ token, onUnauthorized });
  latest.current = { token, onUnauthorized };
  const [hub] = useState(
    () =>
      new ChatHub({
        token: () => latest.current.token,
        onUnauthorized: () => latest.current.onUnauthorized(),
      }),
  );
  return <ChatContext.Provider value={hub}>{children}</ChatContext.Provider>;
}
