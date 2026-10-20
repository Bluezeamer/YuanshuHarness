import { useCallback, useContext, useEffect, useState } from "react";
import { loadToken } from "../api";
import { EnvContext, useBound } from "../layout/env";
import type { PaneProps } from "../layout/types";
import { AUDIT_KINDS, type AuditEntry, type AuditKind, listAudit } from "./api";

export interface AuditConfig {
  kind: AuditKind | null;
}

const KIND_TEXT: Record<AuditKind, string> = {
  tool: "工具",
  permission: "权限",
  terminal: "终端",
  file: "文件",
  transfer: "传输",
  env: "环境",
};

const ACTOR_TEXT = { user: "你", agent: "恒侍", system: "系统" } as const;

const chip =
  "rounded-full border px-2 py-0.5 text-[11px] font-semibold hover:bg-ink hover:text-bg";

const time = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleTimeString("zh-CN", { hour12: false });
};

export function AuditPane({
  config,
  binding,
  onUpdateConfig,
}: PaneProps<AuditConfig>) {
  const env = useContext(EnvContext);
  const { sessionId } = useBound(binding);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const fetchPage = useCallback(
    async (before?: number) => {
      const r = await listAudit(loadToken(), {
        session: sessionId,
        kind: config.kind,
        ...(before === undefined ? {} : { before }),
      });
      if (!r.ok && r.kind === "unauthorized") env?.hub.onUnauthorized();
      return r;
    },
    [sessionId, config.kind, env],
  );

  // tick 只用来手动刷新
  useEffect(() => {
    void tick;
    let alive = true;
    setState("loading");
    void fetchPage().then((r) => {
      if (!alive) return;
      if (r.ok) {
        setEntries(r.data.entries);
        setNext(r.data.nextBefore);
        setState("ready");
      } else setState("error");
    });
    return () => {
      alive = false;
    };
  }, [fetchPage, tick]);

  const more = async () => {
    if (next === null) return;
    const r = await fetchPage(next);
    if (!r.ok) return setState("error");
    setEntries((es) => [...es, ...r.data.entries]);
    setNext(r.data.nextBefore);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-audit-pane>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-line2 px-3 py-2">
        <span className="mr-1 text-[11px] text-mute">
          {sessionId ? "当前会话" : "全部会话"}
        </span>
        {[null, ...AUDIT_KINDS].map((k) => (
          <button
            key={k ?? "all"}
            type="button"
            aria-pressed={config.kind === k}
            onClick={() => onUpdateConfig({ kind: k })}
            className={`${chip} ${
              config.kind === k
                ? "border-accent bg-accent-soft text-accent-deep"
                : "border-line text-ink"
            }`}
          >
            {k === null ? "全部" : KIND_TEXT[k]}
          </button>
        ))}
        <button
          type="button"
          className={`${chip} ml-auto border-line text-ink`}
          onClick={() => setTick((n) => n + 1)}
        >
          刷新
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {state === "error" && (
          <p role="alert" className="p-3 text-xs text-danger">
            审计记录读取失败
          </p>
        )}
        {state === "loading" && entries.length === 0 && (
          <p className="p-3 text-xs text-mute">加载中…</p>
        )}
        {state === "ready" && entries.length === 0 && (
          <p className="p-3 text-xs text-mute">还没有审计记录</p>
        )}
        <ol className="list-none py-1.5">
          {entries.map((e) => (
            <li key={e.id} className="border-b border-line2">
              <button
                type="button"
                aria-expanded={open === e.id}
                onClick={() => setOpen(open === e.id ? null : e.id)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] hover:bg-line2"
              >
                <span className="shrink-0 text-[10.5px] text-mute">
                  {time(e.ts)}
                </span>
                <span className="shrink-0 rounded bg-line2 px-1 text-[10px] text-mute">
                  {KIND_TEXT[e.kind]}
                </span>
                <span className="shrink-0 text-[10.5px] text-mute">
                  {ACTOR_TEXT[e.actor]}
                </span>
                <span className="min-w-0 flex-1 truncate">{e.summary}</span>
              </button>
              {open === e.id && (
                <pre className="m-0 overflow-auto bg-bg px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {JSON.stringify(
                    {
                      session: e.sessionId,
                      environment: e.environmentId,
                      ...(e.detail ?? {}),
                    },
                    null,
                    2,
                  )}
                </pre>
              )}
            </li>
          ))}
        </ol>
        {next !== null && (
          <div className="p-3">
            <button
              type="button"
              className={`${chip} border-line text-ink`}
              onClick={() => void more()}
            >
              加载更早的记录
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
