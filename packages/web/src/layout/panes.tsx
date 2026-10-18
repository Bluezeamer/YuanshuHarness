import { createContext, useContext } from "react";
import type { SessionInfo } from "../api";
import { type Anchor, ConversationView } from "../ChatView";
import type { SessionHub } from "../sessions/hub";
import { Registry } from "./registry";
import type { PaneProps } from "./types";

export interface WorkbenchEnv {
  hub: SessionHub;
  sessions: SessionInfo[];
  reportAnchors?: (paneId: string, anchors: Anchor[]) => void;
}

export const EnvContext = createContext<WorkbenchEnv | null>(null);

export interface ChatConfig {
  sessionId: string | null;
}

function ChatPane({ paneId, config }: PaneProps<ChatConfig>) {
  const env = useContext(EnvContext);
  if (!env || !config.sessionId)
    return <p className="p-7 text-mute">选择会话</p>;
  const session = env.sessions.find((s) => s.id === config.sessionId);
  if (!session) return <p className="p-7 text-mute">会话不存在</p>;
  const report = env.reportAnchors;
  return (
    <ConversationView
      hub={env.hub}
      session={session}
      onAnchors={report ? (a) => report(paneId, a) : undefined}
    />
  );
}

const placeholder = (id: string, displayName: string) => ({
  id,
  displayName,
  configVersion: 1,
  defaultConfig: () => ({}),
  component: () => <p className="p-7 text-mute">尚未可用</p>,
});

export function defaultRegistry(): Registry {
  return new Registry()
    .register<ChatConfig>({
      id: "chat",
      displayName: "对话",
      configVersion: 1,
      defaultConfig: () => ({ sessionId: null }),
      component: ChatPane,
    })
    .register(placeholder("filediscovery", "文件发现"))
    .register(placeholder("terminal", "终端"))
    .register(placeholder("file_preview", "文件预览"))
    .register(placeholder("web_preview", "网页预览"));
}
