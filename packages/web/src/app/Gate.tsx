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
  setUnauthorizedHandler,
} from "../api";
import { openSession } from "../api/auth";
import { Button, Field, InlineNotice, Input } from "../ui";

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
  alt,
  children,
}: {
  /** 令牌界面底部的另一个入口（桌面放「手机版」） */
  alt?: { label: string; href: string };
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
        if (token) {
          saveToken(token);
          // 顺手把令牌落到 HttpOnly Cookie：HTML 预览的 iframe 子请求只能靠它带凭据。
          void openSession(token);
        }
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

  useEffect(() => {
    setUnauthorizedHandler(onUnauthorized);
    return () => setUnauthorizedHandler(null);
  }, [onUnauthorized]);

  if (phase.name === "ready")
    return <>{children(phase.sessions, onUnauthorized)}</>;
  if (phase.name === "checking")
    return (
      <main className="sh-gate" aria-busy="true">
        <p className="sh-gate-wait t-aux">连接中…</p>
      </main>
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
    <main className="sh-gate">
      <div className="sh-gate-card">
        <div className="sh-gate-brand t-block">
          <img src="/mark.svg" width={28} height={28} alt="" />
          元枢
        </div>
        {needToken ? (
          <form onSubmit={submit} className="sh-gate-body">
            <Field label="访问令牌" error={text}>
              {(control) => (
                <Input
                  {...control}
                  mono
                  type="password"
                  autoComplete="off"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" variant="primary">
              进入
            </Button>
            {alt && (
              <a className="sh-gate-alt t-aux" href={alt.href}>
                {alt.label}
              </a>
            )}
          </form>
        ) : (
          <div className="sh-gate-body">
            <InlineNotice tone="danger">{text}</InlineNotice>
            {failure.kind === "network" && (
              <Button
                variant="primary"
                onClick={() => void probe(loadToken(), false)}
              >
                重试
              </Button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
