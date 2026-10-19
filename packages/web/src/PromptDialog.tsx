import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Prompt } from "./conversation";

const FOCUSABLE = "button:not(:disabled),textarea:not(:disabled)";

function fmt(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// 剩余时间只作展示，落定以服务端 prompt.resolved 为准。
function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = expiresAt - now;
  return (
    <span className="font-mono text-xs text-mute tabular-nums">
      {left > 0 ? `剩余 ${fmt(left)}` : "已超时，等待服务端确认"}
    </span>
  );
}

// 统一弹窗：审批与提问共用。只能明确答复，Esc 与点遮罩都不关闭（ADR-0028）。
// 浮在所属 chat pane 内；pane 外的区域不受影响。背景 inert 由父级负责。
export function PromptDialog({
  prompt,
  more,
  sessionName,
  busy,
  error,
  onAnswer,
}: {
  prompt: Prompt;
  // 排在后面的待处理弹窗数。
  more: number;
  sessionName: string | null;
  busy: boolean;
  error: string | null;
  onAnswer(answer: { optionId: string } | { text: string }): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const isInput = prompt.kind === "input";
  const approval = prompt.source === "approval";

  // 打开时记住原焦点，关闭后还回去；原元素没了就回到 pane 的输入框。
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    const pane = root.current?.closest("[data-chat-pane]");
    return () => {
      if (from?.isConnected) from.focus();
      else pane?.querySelector<HTMLElement>("textarea")?.focus();
    };
  }, []);

  // 审批默认落在拒绝上，其余落在第一个可操作项。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 每个弹窗只定位一次
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const target =
      el.querySelector<HTMLElement>("[data-deny]") ??
      el.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  }, [prompt.promptId]);

  const trap = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      return;
    }
    if (e.key !== "Tab" || !root.current) return;
    const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && !busy) onAnswer({ text });
  };

  const titleId = `prompt-title-${prompt.promptId}`;
  const cell =
    "px-4 py-3 font-semibold transition-colors hover:bg-ink hover:text-bg disabled:cursor-wait disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-ink";

  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-bg/60 p-4 backdrop-blur-[3px]">
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trap}
        className="enter w-[min(460px,92vw)] border border-ink bg-panel"
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-ink px-4 py-2 text-xs">
          <span className="font-semibold text-acc">
            {approval ? "待审批" : "待回答"}
            {more > 0 && `（另有 ${more} 项）`}
          </span>
          <span className="truncate text-mute">
            会话：{sessionName ?? "未命名会话"} · 环境：local
          </span>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <h2 id={titleId} className="m-0 text-base font-bold leading-snug">
            {prompt.title}
          </h2>
          {prompt.detail && (
            <div className="flex flex-col gap-1">
              <code className="font-mono text-xs font-semibold">
                {prompt.detail.tool}
              </code>
              <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all border border-line bg-bg px-3 py-2 font-mono text-xs">
                {prompt.detail.summary}
              </pre>
            </div>
          )}
          {prompt.body && (
            <p className="m-0 whitespace-pre-wrap text-mute">{prompt.body}</p>
          )}
          {prompt.expiresAt !== null && (
            <Countdown expiresAt={prompt.expiresAt} />
          )}
          {error && (
            <p role="alert" className="m-0 text-sm font-semibold text-acc">
              {error}
            </p>
          )}
        </div>
        {isInput ? (
          <form onSubmit={submit} className="border-t border-ink">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                )
                  submit(e);
              }}
              maxLength={8000}
              aria-label="你的回答"
              className="block h-24 w-full resize-none border-0 bg-transparent px-4 py-3 font-[inherit] text-ink"
            />
            <button
              type="submit"
              disabled={busy || !text.trim()}
              className={`${cell} w-full border-t border-line disabled:hover:bg-transparent`}
            >
              提交
            </button>
          </form>
        ) : (
          <div
            className={`grid border-t border-ink ${approval ? "grid-flow-col auto-cols-fr divide-x divide-ink" : "divide-y divide-line"}`}
          >
            {prompt.options.map((o) => (
              <button
                key={o.id}
                type="button"
                disabled={busy}
                data-deny={o.id === "deny" ? "" : undefined}
                onClick={() => onAnswer({ optionId: o.id })}
                className={`${cell} ${o.id === "deny" ? "text-acc" : ""} ${approval ? "" : "text-left"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
