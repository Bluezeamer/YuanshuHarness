// 对话流里点文件引用（轮末改动卡片、消息里的 file: 链接）时，找到承载该会话对话窗格，
// 以它为参照在同一窗格里开标签/新开窗格。

import { panesOf } from "../../workspace/model/l2";
import type { LayoutStore } from "../../workspace/store/layoutStore";

export interface ChatPaneRef {
  pid: string;
  tabId: string | null;
  host: string | undefined;
}

export function chatPaneOf(
  store: LayoutStore,
  sessionId: string,
): ChatPaneRef | null {
  const st = store.getState().doc.windows;
  const win = st.list[st.active];
  if (!win) return null;
  const from = panesOf(win).find((p) =>
    p.tabs.some((t) => t.type === "chat" && t.sid === sessionId),
  );
  const tab = from?.tabs.find((t) => t.type === "chat" && t.sid === sessionId);
  const pid = from?.pid ?? panesOf(win)[0]?.pid;
  if (!pid) return null;
  return { pid, tabId: tab?.id ?? null, host: tab?.host };
}
