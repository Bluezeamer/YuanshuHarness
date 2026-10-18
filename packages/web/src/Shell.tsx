import { useState } from "react";
import type { SessionInfo } from "./api";
import { Conversation } from "./Conversation";
import { useConversation } from "./useConversation";

function ConversationView({
  session,
  draft,
  onDraft,
  onRestore,
  onUnauthorized,
}: {
  session: SessionInfo;
  draft: string;
  onDraft: (text: string) => void;
  onRestore: (text: string) => void;
  onUnauthorized: () => void;
}) {
  const c = useConversation(session.id, onRestore, onUnauthorized);
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

function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      role="img"
      aria-label={running ? "运行中" : "空闲"}
      className={`size-2 rounded-full ${running ? "dot-run bg-live" : "bg-ok"}`}
    />
  );
}

export function Shell({
  sessions,
  onUnauthorized,
}: {
  sessions: SessionInfo[];
  onUnauthorized: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  // restored：草稿是放回的未确认发送，用户还没动过，可以继续往后拼。
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; restored: boolean }>
  >({});
  const current = sessions.find((s) => s.id === selected);

  const setDraft = (id: string, text: string) =>
    setDrafts((d) => ({ ...d, [id]: { text, restored: false } }));
  // 草稿为空，或仍是上次放回的原样时才写入；用户动过的草稿不覆盖。
  const restoreDraft = (id: string, text: string) =>
    setDrafts((d) => {
      const cur = d[id];
      if (!cur || cur.text === "")
        return { ...d, [id]: { text, restored: true } };
      if (cur.restored)
        return { ...d, [id]: { text: `${cur.text}\n${text}`, restored: true } };
      return d;
    });

  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <header className="flex items-stretch gap-8 border-b border-ink bg-panel px-6">
        <div className="flex items-center gap-2.5 text-[17px] font-bold tracking-wider">
          <i className="size-3 bg-acc" />
          元枢
        </div>
        <nav className="flex" aria-label="主导航">
          <button
            type="button"
            aria-current="page"
            className="border-b-[3px] border-ink px-3.5 py-3.5 font-semibold"
          >
            对话
          </button>
        </nav>
        <div className="ml-auto flex items-center gap-2 font-medium">
          <i className="size-2 rounded-full bg-ok" />
          Server 在线
        </div>
      </header>
      <div className="enter grid min-h-0 grid-cols-[268px_1fr]">
        <aside className="min-h-0 overflow-auto border-r border-line bg-panel">
          {sessions.length === 0 ? (
            <p className="p-5 text-mute">还没有会话</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={s.id === selected ? "true" : undefined}
                    onClick={() => setSelected(s.id)}
                    className={`grid w-full grid-cols-[8px_1fr] items-center gap-3 border-b border-line2 px-5 py-3 text-left hover:bg-ink/5 ${
                      s.id === selected
                        ? "bg-ink/5 shadow-[inset_3px_0_0_var(--ink)]"
                        : ""
                    }`}
                  >
                    <StatusDot running={s.running} />
                    <span className="truncate font-semibold">
                      {s.name ?? "未命名会话"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <main className="flex min-h-0 flex-col">
          {current ? (
            <ConversationView
              key={current.id}
              session={current}
              draft={drafts[current.id]?.text ?? ""}
              onDraft={(text) => setDraft(current.id, text)}
              onRestore={(text) => restoreDraft(current.id, text)}
              onUnauthorized={onUnauthorized}
            />
          ) : (
            <p className="p-7 text-mute">选择会话</p>
          )}
        </main>
      </div>
    </div>
  );
}
