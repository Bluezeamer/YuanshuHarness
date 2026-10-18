import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { ChatEntry } from "./api";
import type { Tool } from "./conversation";
import type { Conn } from "./useConversation";

function TickBar({
  running,
  seqs,
  gap,
}: {
  running: boolean;
  seqs: number[];
  gap: boolean;
}) {
  const sticks = seqs.map((_, i) => {
    const isLast = i === seqs.length - 1;
    return (
      <i
        // biome-ignore lint/suspicious/noArrayIndexKey: 刻度条按位置绘制，没有稳定 id
        key={i}
        className={`flex-1 transition-all duration-[400ms] ${isLast && gap ? "h-4 bg-[repeating-linear-gradient(135deg,var(--acc)_0_2px,transparent_2px_4px)]" : isLast ? `h-4 ${running ? "dot-run bg-live" : "bg-ink"}` : "h-2 bg-ink/40"}`}
      />
    );
  });
  return (
    <div className="flex items-end gap-0.5 border-b border-line px-7 pb-2.5">
      <div className="flex h-5 flex-1 items-end gap-0.5">{sticks}</div>
      <span className="text-[11.5px] text-mute">SEQ</span>
      <b className="min-w-[32px] text-right text-[11.5px] font-semibold">
        {seqs[seqs.length - 1] ?? 0}
      </b>
    </div>
  );
}

function ToolCard({ t }: { t: Tool }) {
  const cls =
    t.status === "running"
      ? "text-live"
      : t.status === "error"
        ? "text-acc"
        : "text-ok";
  return (
    <div
      className={`relative overflow-hidden border border-line bg-panel ${t.status === "running" ? "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:w-[30%] after:animate-[slide_1.4s_var(--ease)_infinite] after:bg-live" : ""}`}
    >
      <div className="flex items-center justify-between border-b border-line bg-ink/[0.04] px-3 py-1.5 text-xs">
        <code className="font-mono font-semibold">{t.name}</code>
        <span className={`font-semibold ${cls}`}>
          {t.status === "running"
            ? "运行中"
            : t.status === "error"
              ? "失败"
              : "完成"}
        </span>
      </div>
    </div>
  );
}

function Message({
  who,
  text,
  tools,
  partial,
  anchor,
}: {
  anchor?: string;
  who: "user" | "agent" | "queued";
  text?: string;
  tools?: Tool[];
  partial?: boolean;
}) {
  const label = who === "user" ? "用户" : who === "agent" ? "恒侍" : "排队中";
  const labelCls =
    who === "user" ? "text-mute" : who === "agent" ? "text-ink" : "text-live";
  return (
    <div
      data-anchor={anchor}
      className="grid grid-cols-[72px_minmax(0,72ch)] gap-x-3 gap-y-2.5 animate-[in_0.6s_var(--ease)_backwards]"
    >
      <span
        className={`col-start-1 row-start-1 pt-[3px] text-xs font-semibold ${labelCls}`}
      >
        {label}
      </span>
      {text !== undefined && (
        <p
          className={`col-start-2 m-0 whitespace-pre-wrap ${who === "user" ? "text-[16px] font-semibold leading-snug" : who === "queued" ? "text-mute" : ""}`}
        >
          {text}
          {partial && (
            <span
              className="caret inline-block ml-[3px] h-[1.05em] w-[7px] align-text-bottom bg-live animate-[blink_1s_steps(2)_infinite]"
              role="img"
              aria-label="正在输入"
            />
          )}
        </p>
      )}
      {tools && tools.length > 0 && (
        <div className="col-start-2 flex flex-col gap-2">
          {tools.map((t) => (
            <ToolCard key={t.id} t={t} />
          ))}
        </div>
      )}
      {who === "queued" && (
        <small className="col-start-2 text-xs font-semibold text-live animate-[blink_1.4s_steps(2)_infinite]">
          当前步骤结束后送达
        </small>
      )}
    </div>
  );
}

const whoOf = (role: string): "user" | "agent" =>
  role === "user" ? "user" : "agent";

function SyncBar({ closed }: { closed: boolean }) {
  return (
    <div
      role="alert"
      className="animate-[wipe_0.6s_var(--ease)] border-b border-ink bg-panel px-7 py-2 text-sm font-medium text-acc"
    >
      {closed ? "连接已断开，点击「重新连接」后以新快照恢复" : "正在重连…"}
    </div>
  );
}

export function Conversation({
  name,
  draft,
  onDraft,
  messages,
  older,
  hasEarlier,
  loadingEarlier,
  earlierFailed,
  onLoadEarlier,
  historyLoading,
  historyFailed,
  partial,
  tools,
  queue,
  running,
  stopPending,
  conn,
  notice,
  error,
  onSend,
  onStop,
  onReconnect,
}: {
  name: string | null;
  draft: string;
  onDraft(text: string): void;
  messages: { role: string; text: string }[];
  older: ChatEntry[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  earlierFailed: boolean;
  onLoadEarlier(): void;
  historyLoading: boolean;
  historyFailed: boolean;
  partial: string | null;
  tools: Tool[];
  queue: string[];
  running: boolean;
  stopPending: boolean;
  conn: Conn;
  notice: string | null;
  error: string | null;
  onSend(text: string): boolean;
  onStop(): void;
  onReconnect(): void;
}) {
  const toolSig = JSON.stringify(tools.map((t) => [t.id, t.name, t.status]));
  const queueSig = JSON.stringify(queue);
  const feedRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchoring = useRef(false);
  const lastHeight = useRef(0);
  const firstIndex = useRef(Number.POSITIVE_INFINITY);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const check = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
    };
    el.addEventListener("scroll", check);
    check();
    return () => el.removeEventListener("scroll", check);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值只用作"内容变了"的触发信号
  useEffect(() => {
    if (atBottom.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages.length, partial, toolSig, queueSig, error, notice]);

  // 历史块变化：用户主动加载更早时保持视口位置，否则在底部就继续跟随。
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const first = older[0]?.index ?? Number.POSITIVE_INFINITY;
    // 只有历史块真的向前延伸才补偿；并发的尾页同步改了块但没往前延伸时，不消耗锚点。
    if (anchoring.current && first < firstIndex.current) {
      el.scrollTop += el.scrollHeight - lastHeight.current;
      anchoring.current = false;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    firstIndex.current = first;
  }, [older]);

  // 请求期间新消息会撑高容器，所以增量以上一次提交的高度为基准，而不是点击时的高度。
  useLayoutEffect(() => {
    if (feedRef.current) lastHeight.current = feedRef.current.scrollHeight;
  });

  useEffect(() => {
    if (!loadingEarlier) anchoring.current = false;
  }, [loadingEarlier]);

  const loadEarlier = () => {
    anchoring.current = true;
    onLoadEarlier();
  };

  const submit = () => {
    if (!draft.trim()) return;
    if (onSend(draft)) onDraft("");
  };

  const handleSend = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const seqs = older
    .map((m) => m.index)
    .concat(messages.map((_, i) => older.length + i));
  const effective = conn === "open";
  const gap = conn === "closed";
  const empty =
    effective &&
    !historyLoading &&
    !hasEarlier &&
    older.length === 0 &&
    messages.length === 0 &&
    partial === null &&
    tools.length === 0 &&
    queue.length === 0;

  return (
    <div className="grid min-h-0 grid-rows-[auto_auto_auto_1fr_auto]">
      {conn === "reconnecting" || gap ? <SyncBar closed={gap} /> : <div />}
      <div className="flex items-baseline justify-between border-b border-line px-7 pb-3 pt-4">
        <h1 className="text-[22px] font-bold leading-tight tracking-tight">
          {name ?? "未命名会话"}
        </h1>
        {gap && (
          <button
            type="button"
            onClick={onReconnect}
            className="text-xs font-semibold text-live hover:underline"
          >
            重新连接
          </button>
        )}
      </div>
      <TickBar running={running} seqs={seqs.length ? seqs : [0]} gap={gap} />
      <div
        ref={feedRef}
        role="log"
        aria-label="对话记录"
        className="flex min-h-0 flex-col gap-6 overflow-auto px-7 py-6"
        style={{ overflowAnchor: "none" }}
      >
        {historyFailed && (
          <p className="text-sm text-acc">历史加载失败，只显示当前窗口</p>
        )}
        {hasEarlier && (
          <div className="flex items-baseline gap-3">
            <button
              type="button"
              onClick={loadEarlier}
              disabled={loadingEarlier}
              className="border border-ink px-3 py-1 text-xs font-semibold transition-colors hover:bg-ink hover:text-bg disabled:cursor-wait disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-ink"
            >
              {loadingEarlier ? "加载中…" : "加载更早"}
            </button>
            {earlierFailed && (
              <span className="text-xs text-acc">
                更早的消息加载失败，请重试
              </span>
            )}
          </div>
        )}
        {empty && <p className="text-mute">还没有消息</p>}
        {older.map((m) => (
          <Message key={`h-${m.index}`} anchor={`h-${m.index}`} who={whoOf(m.role)} text={m.text} />
        ))}
        {messages.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 窗口消息没有序位，只追加不重排
          <Message key={`w-${i}`} anchor={`w-${i}`} who={whoOf(m.role)} text={m.text} />
        ))}
        {partial !== null && <Message who="agent" text={partial} partial />}
        {tools.length > 0 && <Message who="agent" tools={tools} />}
        {queue.length > 0 && (
          <p className="text-xs font-semibold text-live">排队 {queue.length}</p>
        )}
        {queue.map((q, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 排队文本可重复，没有稳定 id
          <Message key={`q-${i}`} who="queued" text={q} />
        ))}
        {error && <p className="text-sm text-acc">{error}</p>}
        {notice && <p className="text-sm text-acc">{notice}</p>}
      </div>
      <form
        onSubmit={handleSend}
        className="grid grid-cols-[1fr_auto_auto] border-t border-ink bg-panel"
      >
        <textarea
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={handleKey}
          placeholder="输入消息"
          aria-label="输入消息"
          disabled={!effective}
          className="h-[68px] resize-none border-0 bg-transparent px-7 py-3.5 font-[inherit] text-ink placeholder:text-mute disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!effective || !draft.trim()}
          className="flex items-center gap-2 border-l border-line px-7 font-semibold transition-colors hover:bg-ink hover:text-bg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink"
        >
          发送
        </button>
        {running && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopPending || !effective}
            aria-label="停止运行"
            className="flex items-center gap-2 animate-[wipe_0.5s_var(--ease)] border-l border-line bg-acc px-7 font-semibold text-bg transition-colors hover:bg-acc-press disabled:cursor-not-allowed disabled:opacity-70"
          >
            停止
          </button>
        )}
      </form>
    </div>
  );
}
