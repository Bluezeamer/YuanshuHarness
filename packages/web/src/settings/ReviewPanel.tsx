import { useEffect, useState } from "react";
import {
  listSessions,
  loadToken,
  patchSession,
  type SessionInfo,
} from "../api";
import { actionBtn, describe, field } from "./shared";

const MAX = 4000;

function Editor({
  session,
  onSaved,
  onUnauthorized,
}: {
  session: SessionInfo;
  onSaved(policy: string | null): void;
  onUnauthorized(): void;
}) {
  const [text, setText] = useState(session.reviewPolicy ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const trimmed = text.trim();

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    setDone(false);
    const r = await patchSession(loadToken(), session.id, {
      reviewPolicy: value,
    });
    setBusy(false);
    if (r.ok) {
      setDone(true);
      setText(value);
      onSaved(value || null);
    } else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(describe(r, { bad_request: `策略须在 ${MAX} 字以内` }));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="review-policy" className="text-xs font-semibold">
        审核策略
      </label>
      <textarea
        id="review-policy"
        value={text}
        maxLength={MAX}
        onChange={(e) => setText(e.target.value)}
        className={`${field} h-40 resize-y`}
      />
      <p className="m-0 text-xs text-mute">
        仅在工作区为「自动模式」时生效：审核模型按此策略判断是否放行。留空使用内置策略。
        拿不准时会交给你决定。 {text.length}/{MAX}
      </p>
      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      {done && <p className="m-0 text-ok">已保存</p>}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy || trimmed === (session.reviewPolicy ?? "")}
          onClick={() => void save(trimmed)}
          className={actionBtn}
        >
          保存
        </button>
        <button
          type="button"
          disabled={busy || !session.reviewPolicy}
          onClick={() => void save("")}
          className={actionBtn}
        >
          清除策略
        </button>
      </div>
    </div>
  );
}

// 会话列表以打开时重新拉取的为准，避免读到 Gate 启动时的旧策略。
export function ReviewPanel({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [sessions, setSessions] = useState<
    SessionInfo[] | "loading" | "failed"
  >("loading");
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listSessions(loadToken()).then((r) => {
      if (!live) return;
      if (!r.ok && r.kind === "unauthorized") onUnauthorized();
      setSessions(r.ok ? r.data : "failed");
      if (r.ok) setSel(r.data[0]?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [onUnauthorized]);

  if (sessions === "loading") return <p className="p-6 text-mute">加载中…</p>;
  if (sessions === "failed")
    return (
      <p role="alert" className="p-6 font-semibold text-acc">
        会话加载失败
      </p>
    );
  if (sessions.length === 0) return <p className="p-6 text-mute">还没有会话</p>;

  const current = sessions.find((s) => s.id === sel) ?? sessions[0];
  return (
    <div className="flex max-w-[640px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="review-session" className="text-xs font-semibold">
          会话
        </label>
        <select
          id="review-session"
          value={current?.id}
          onChange={(e) => setSel(e.target.value)}
          className={field}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name ?? "未命名会话"}
            </option>
          ))}
        </select>
      </div>
      {current && (
        <Editor
          key={current.id}
          session={current}
          onUnauthorized={onUnauthorized}
          onSaved={(p) =>
            setSessions((cur) =>
              Array.isArray(cur)
                ? cur.map((s) =>
                    s.id === current.id ? { ...s, reviewPolicy: p } : s,
                  )
                : cur,
            )
          }
        />
      )}
    </div>
  );
}
