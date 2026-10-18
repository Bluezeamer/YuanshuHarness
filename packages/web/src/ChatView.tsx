import { useEffect } from "react";
import type { SessionInfo } from "./api";
import { Conversation } from "./Conversation";
import type { SessionHub } from "./sessions/hub";
import { useConversation, useDraft } from "./useConversation";

export interface Anchor {
  id: string;
  text: string;
}

export function ConversationView({
  hub,
  session,
  onAnchors,
}: {
  hub: SessionHub;
  session: SessionInfo;
  // R13：把用户消息作为导航锚点报告给上层。
  onAnchors?: (anchors: Anchor[]) => void;
}) {
  const c = useConversation(hub, session.id);
  const draft = useDraft(hub, session.id);
  useEffect(() => {
    if (!onAnchors) return;
    const user = (role: string) => role === "user";
    onAnchors([
      ...c.older
        .filter((m) => user(m.role))
        .map((m) => ({ id: `h-${m.index}`, text: m.text })),
      ...c.state.messages
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => user(m.role))
        .map(({ m, i }) => ({ id: `w-${i}`, text: m.text })),
    ]);
  }, [c.older, c.state.messages, onAnchors]);
  const onDraft = (text: string) => hub.setDraft(session.id, text);
  return (
    <Conversation
      name={session.name}
      draft={draft}
      onDraft={onDraft}
      messages={c.state.messages}
      older={c.older}
      hasEarlier={c.hasEarlier}
      loadingEarlier={c.loadingEarlier}
      earlierFailed={c.earlierFailed}
      onLoadEarlier={c.loadEarlier}
      historyLoading={c.historyLoading}
      historyFailed={c.historyFailed}
      partial={c.state.partial}
      tools={c.state.tools}
      queue={c.state.queue}
      running={c.state.running}
      stopPending={c.stopPending}
      conn={c.conn}
      notice={c.notice}
      error={c.state.error}
      onSend={c.send}
      onStop={c.stop}
      onReconnect={c.reconnect}
    />
  );
}
