import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ChatEntry } from "./api";
import type { ConvState } from "./conversation";
import type { SessionHub } from "./sessions/hub";
import {
  type Conn,
  initialSnapshot,
  type SessionStore,
} from "./sessions/store";

export type { Conn };

export interface Conversation {
  state: ConvState;
  conn: Conn;
  older: ChatEntry[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  earlierFailed: boolean;
  historyLoading: boolean;
  historyFailed: boolean;
  notice: string | null;
  stopPending: boolean;
  answering: string | null;
  promptError: { promptId: string; message: string } | null;
  answerPrompt(
    promptId: string,
    answer: { optionId: string } | { text: string },
  ): boolean;
  send(text: string): boolean;
  stop(): void;
  reconnect(): void;
  loadEarlier(): void;
}

const noSub = () => () => {};

// 订阅按会话共享的 store：同一会话的所有 pane 看到同一条连接、同一份状态（R12）。
export function useConversation(
  hub: SessionHub,
  sessionId: string,
): Conversation {
  const [held, setHeld] = useState<SessionStore | null>(null);
  useEffect(() => {
    const s = hub.acquire(sessionId);
    setHeld(s);
    return () => {
      hub.release(sessionId);
      setHeld(null);
    };
  }, [hub, sessionId]);

  const store = held && held.id === sessionId ? held : null;
  const snap = useSyncExternalStore(
    store ? store.subscribe : noSub,
    store ? store.getSnapshot : () => initialSnapshot,
  );

  const send = useCallback((t: string) => store?.send(t) ?? false, [store]);
  const stop = useCallback(() => store?.stop(), [store]);
  const answerPrompt = useCallback(
    (id: string, a: { optionId: string } | { text: string }) =>
      store?.answerPrompt(id, a) ?? false,
    [store],
  );
  const reconnect = useCallback(() => store?.reconnect(), [store]);
  const loadEarlier = useCallback(() => store?.loadEarlier(), [store]);

  return {
    state: snap.state,
    conn: snap.conn,
    older: snap.loaded.older,
    hasEarlier: snap.loaded.nextBefore !== null,
    loadingEarlier: snap.loadingEarlier,
    earlierFailed: snap.earlierFailed,
    historyLoading: snap.historyLoading,
    historyFailed: snap.historyFailed,
    notice: snap.notice,
    stopPending: snap.stopPending,
    answering: snap.answering,
    promptError: snap.promptError,
    answerPrompt,
    send,
    stop,
    reconnect,
    loadEarlier,
  };
}

export function useDraft(hub: SessionHub, sessionId: string): string {
  return useSyncExternalStore(hub.subscribeDrafts, () => hub.draft(sessionId));
}
