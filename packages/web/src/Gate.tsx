import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  clearToken,
  type Failure,
  listSessions,
  loadToken,
  type SessionInfo,
  saveToken,
} from "./api";

type Phase =
  | { name: "checking" }
  | { name: "ready"; sessions: SessionInfo[] }
  | { name: "failed"; failure: Failure; fromInput: boolean };

const message = (f: Failure, fromInput: boolean): string => {
  switch (f.kind) {
    case "unauthorized":
      return fromInput ? "令牌不正确" : "";
    case "forbidden":
      return "当前来源不被允许";
    case "rate_limited":
      return f.retryAfter
        ? `尝试过多，请 ${f.retryAfter} 秒后再试`
        : "尝试过多，请稍后再试";
    case "network":
      return "无法连接 Server";
    case "server":
      return "Server 返回了错误";
  }
};

export function Gate({
  children,
}: {
  children: (sessions: SessionInfo[], onUnauthorized: () => void) => ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  const [input, setInput] = useState("");

  const onUnauthorized = useCallback(() => {
    clearToken();
    setPhase({
      name: "failed",
      failure: { kind: "unauthorized" },
      fromInput: false,
    });
  }, []);

  const probe = useCallback(
    async (token: string | null, fromInput: boolean) => {
      setPhase({ name: "checking" });
      const r = await listSessions(token);
      if (r.ok) {
        if (token) saveToken(token);
        setPhase({ name: "ready", sessions: r.data });
        return;
      }
      if (r.kind === "unauthorized") clearToken();
      setPhase({ name: "failed", failure: r, fromInput });
    },
    [],
  );

  useEffect(() => {
    void probe(loadToken(), false);
  }, [probe]);

  if (phase.name === "ready")
    return <>{children(phase.sessions, onUnauthorized)}</>;
  if (phase.name === "checking")
    return (
      <main className="grid h-full place-items-center text-mute">连接中…</main>
    );

  const { failure, fromInput } = phase;
  const needToken = failure.kind === "unauthorized";
  const text = message(failure, fromInput);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const token = input.trim();
    if (token) void probe(token, true);
  };

  return (
    <main className="enter grid h-full place-items-center">
      <div className="w-[min(420px,92vw)] overflow-hidden rounded-lg border border-line bg-panel shadow-card">
        <div className="flex items-center gap-2.5 border-b border-line2 px-5 py-3 text-[17px] font-bold">
          <i className="size-3 rounded-sm bg-accent-deep" />
          元枢
        </div>
        {needToken ? (
          <form onSubmit={submit} className="flex flex-col gap-3 p-5">
            <label htmlFor="token" className="font-semibold">
              访问令牌
            </label>
            <input
              id="token"
              type="password"
              autoComplete="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="rounded-md border border-line bg-bg px-3 py-2 font-mono"
            />
            {text && (
              <p role="alert" className="font-semibold text-danger">
                {text}
              </p>
            )}
            <button
              type="submit"
              className="rounded-md border border-accent-deep bg-accent-deep px-4 py-2 font-semibold text-panel hover:bg-accent-deep/85"
            >
              进入
            </button>
          </form>
        ) : (
          <div className="flex flex-col gap-3 p-5">
            <p role="alert" className="font-semibold text-danger">
              {text}
            </p>
            {failure.kind === "network" && (
              <button
                type="button"
                onClick={() => void probe(loadToken(), false)}
                className="rounded-md border border-accent-deep bg-accent-deep px-4 py-2 font-semibold text-panel hover:bg-accent-deep/85"
              >
                重试
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
