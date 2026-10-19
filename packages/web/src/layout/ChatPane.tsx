import { useCallback, useContext, useState } from "react";
import { type Anchor, ConversationView } from "../ChatView";
import { EnvContext } from "./env";
import { ListIcon, NavIcon } from "./icons";
import type { PaneProps } from "./types";
import { LEFT_MIN_WIDTH, RIGHT_MIN_WIDTH, useSide, useWidth } from "./useSide";

export interface ChatConfig {
  sessionId: string | null;
}

const NAV_MAX = 24;

const btn =
  "border border-line px-2 py-0.5 text-xs font-semibold hover:bg-ink hover:text-bg";
const iconBtn =
  "grid size-6 place-items-center border border-line text-xs hover:bg-ink hover:text-bg";

function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      role="img"
      aria-label={running ? "运行中" : "空闲"}
      className={`size-2 rounded-full ${running ? "dot-run bg-live" : "bg-ok"}`}
    />
  );
}

// R10、R13、R14：会话列表与输入导航属于 chat pane 自己，宽度也按这个 pane 判断。
export function ChatPane({ config, onUpdateConfig }: PaneProps<ChatConfig>) {
  const env = useContext(EnvContext);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const width = useWidth(root);
  const left = useSide("left", LEFT_MIN_WIDTH, width);
  const right = useSide("right", RIGHT_MIN_WIDTH, width);
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

  const session = config.sessionId
    ? env.sessions.find((s) => s.id === config.sessionId)
    : undefined;
  const shownAnchors = session ? anchors : [];

  const choose = (sessionId: string) => {
    left.close();
    onUpdateConfig({ sessionId });
  };
  const jump = (id: string) => {
    const el = [...(root?.querySelectorAll("[data-anchor]") ?? [])].find(
      (n) => n.getAttribute("data-anchor") === id,
    );
    el?.scrollIntoView?.({ block: "start" });
  };

  return (
    <div
      ref={setRoot}
      data-chat-pane
      className="relative flex h-full min-h-0 flex-col"
    >
      {(!left.pinned || !right.pinned) && (
        <div className="flex items-center justify-between border-b border-line2 px-2 py-1">
          {!left.pinned ? (
            <button
              type="button"
              className={iconBtn}
              title={left.open ? "收起会话列表" : "展开会话列表"}
              aria-label={left.open ? "收起会话列表" : "展开会话列表"}
              aria-expanded={left.open}
              onClick={left.toggleOpen}
            >
              <ListIcon />
            </button>
          ) : (
            <span />
          )}
          {!right.pinned && (
            <button
              type="button"
              className={iconBtn}
              title={right.open ? "收起输入导航" : "展开输入导航"}
              aria-label={right.open ? "收起输入导航" : "展开输入导航"}
              aria-expanded={right.open}
              onClick={right.toggleOpen}
            >
              <NavIcon />
            </button>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1" data-chat-body>
        {(left.pinned || left.open) && (
          <aside
            aria-label="会话列表"
            className={`min-h-0 w-[220px] shrink-0 overflow-auto border-r border-line bg-panel ${
              left.open ? "absolute inset-y-0 left-0 z-20" : ""
            }`}
          >
            <div className="flex justify-end border-b border-line2 p-1">
              {left.open ? (
                <button type="button" className={btn} onClick={left.pin}>
                  固定会话列表
                </button>
              ) : (
                <button type="button" className={btn} onClick={left.collapse}>
                  折叠会话列表
                </button>
              )}
            </div>
            {env.sessions.length === 0 ? (
              <p className="p-4 text-mute">还没有会话</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {env.sessions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      aria-current={
                        s.id === config.sessionId ? "true" : undefined
                      }
                      onClick={() => choose(s.id)}
                      className={`grid w-full grid-cols-[8px_1fr] items-center gap-3 border-b border-line2 px-4 py-3 text-left hover:bg-ink/5 ${
                        s.id === config.sessionId
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
        )}
        <div className="min-h-0 min-w-0 flex-1">
          {!config.sessionId ? (
            <div className="flex items-center gap-3 p-7 text-mute">
              选择会话
              {env.newSession && (
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    env.newSession?.((sessionId) =>
                      onUpdateConfig({ sessionId }),
                    )
                  }
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
        {(right.pinned || right.open) && (
          <nav
            aria-label="输入导航"
            className={`min-h-0 w-[200px] shrink-0 overflow-auto border-l border-line bg-panel ${
              right.open ? "absolute inset-y-0 right-0 z-20" : ""
            }`}
          >
            <div className="flex justify-end border-b border-line2 p-1">
              {right.open ? (
                <button type="button" className={btn} onClick={right.pin}>
                  固定输入导航
                </button>
              ) : (
                <button type="button" className={btn} onClick={right.collapse}>
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
