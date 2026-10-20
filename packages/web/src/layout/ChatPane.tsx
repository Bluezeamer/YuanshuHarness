import { useCallback, useContext, useState } from "react";
import { type Anchor, ConversationView } from "../ChatView";
import { EnvContext, useBound } from "./env";
import { NavIcon } from "./icons";
import type { PaneProps } from "./types";
import { NAV_MIN_WIDTH, useSide, useWidth } from "./useSide";

export interface ChatConfig {
  sessionId: string | null;
}

const NAV_MAX = 24;

const btn =
  "border border-line px-2 py-0.5 text-xs font-semibold hover:bg-ink hover:text-bg";
const iconBtn =
  "grid size-6 place-items-center border border-line text-xs hover:bg-ink hover:text-bg";

// 会话列表在 rail，pane 内只有输入导航（四态：固定 / 悬浮 × 开 / 关），宽度按这个 pane 判断。
export function ChatPane({
  config,
  binding,
  onUpdateConfig,
}: PaneProps<ChatConfig>) {
  const env = useContext(EnvContext);
  // follow 时是活动会话，fixed 时是钉住的会话；都没有时退回旧文档里记的 sessionId。
  const sessionId = useBound(binding).sessionId ?? config.sessionId;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const width = useWidth(root);
  const nav = useSide("nav", NAV_MIN_WIDTH, width);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const onAnchors = useCallback((a: Anchor[]) => {
    setAnchors((prev) =>
      prev.length === a.length &&
      prev.every((x, i) => x.id === a[i]?.id && x.text === a[i]?.text)
        ? prev
        : a,
    );
  }, []);
  if (!env) return null;

  const session = sessionId
    ? env.sessions.find((s) => s.id === sessionId)
    : undefined;
  const shownAnchors = session ? anchors : [];

  // 在 pane 里自己选会话，等于把这个 pane 钉在该会话上。
  const choose = (id: string) => {
    onUpdateConfig({ sessionId: id }, undefined, {
      mode: "fixed",
      sessionId: id,
      host: null,
    });
  };
  const jump = (id: string) => {
    const el = [...(root?.querySelectorAll("[data-anchor]") ?? [])].find(
      (n) => n.getAttribute("data-anchor") === id,
    );
    el?.scrollIntoView?.({ block: "start" });
    nav.close();
  };

  return (
    <div
      ref={setRoot}
      data-chat-pane
      className="relative flex h-full min-h-0 flex-col"
    >
      {!nav.pinned && (
        <div className="flex items-center justify-end border-b border-line2 px-2 py-1">
          <button
            type="button"
            className={iconBtn}
            title={nav.open ? "收起输入导航" : "展开输入导航"}
            aria-label={nav.open ? "收起输入导航" : "展开输入导航"}
            aria-expanded={nav.open}
            onClick={nav.toggleOpen}
          >
            <NavIcon />
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1" data-chat-body>
        <div className="min-h-0 min-w-0 flex-1">
          {!sessionId ? (
            <div className="flex items-center gap-3 p-7 text-mute">
              选择会话
              {env.newSession && (
                <button
                  type="button"
                  className={btn}
                  onClick={() => env.newSession?.((id) => choose(id))}
                >
                  在此新建会话
                </button>
              )}
            </div>
          ) : !session ? (
            <p className="p-7 text-mute">会话不存在</p>
          ) : (
            <ConversationView
              hub={env.hub}
              session={session}
              onAnchors={onAnchors}
            />
          )}
        </div>
        {(nav.pinned || nav.open) && (
          <nav
            aria-label="输入导航"
            className={`min-h-0 w-[200px] shrink-0 overflow-auto border-l border-line bg-panel ${
              nav.open ? "absolute inset-y-0 right-0 z-20" : ""
            }`}
          >
            <div className="flex justify-end border-b border-line2 p-1">
              {nav.open ? (
                <button type="button" className={btn} onClick={nav.pin}>
                  固定输入导航
                </button>
              ) : (
                <button type="button" className={btn} onClick={nav.collapse}>
                  折叠输入导航
                </button>
              )}
            </div>
            {shownAnchors.length === 0 ? (
              <p className="p-4 text-sm text-mute">没有可跳转的消息</p>
            ) : (
              <ol className="m-0 list-none p-0">
                {shownAnchors.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      aria-label={a.text}
                      data-text={
                        a.text.length > NAV_MAX
                          ? `${a.text.slice(0, NAV_MAX)}…`
                          : a.text
                      }
                      onClick={() => jump(a.id)}
                      className="w-full truncate border-b border-line2 px-4 py-2 text-left text-sm before:content-[attr(data-text)] hover:bg-ink/5"
                    />
                  </li>
                ))}
              </ol>
            )}
          </nav>
        )}
      </div>
    </div>
  );
}
