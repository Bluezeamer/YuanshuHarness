import { useEffect, useState } from "react";
import {
  type AgentDetail,
  type AuditEntry,
  getAgent,
  listAudit,
  loadToken,
  type SessionInfo,
} from "../api";
import { ConversationView } from "../ChatView";
import type { SessionHub } from "../sessions/hub";

const POLL_MS = 3000;
const AUDIT_LIMIT = 100;

const KIND_LABEL: Record<AuditEntry["kind"], string> = {
  tool: "工具",
  permission: "权限",
  terminal: "终端",
  file: "文件",
  transfer: "传输",
  env: "环境",
};

const clock = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toTimeString().slice(0, 8);
};

const COLUMN = "min-h-0 overflow-auto bg-panel";
const HEAD =
  "m-0 border-b border-line px-4 py-2.5 text-xs font-semibold text-mute";

// 左栏：本会话的执行审计，新的在上；运行中轮询刷新。
function AuditTimeline({ sessionId }: { sessionId: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      const r = await listAudit(loadToken(), {
        session: sessionId,
        limit: AUDIT_LIMIT,
      });
      if (!live) return;
      setFailed(!r.ok);
      if (r.ok) setEntries(r.data.entries);
    };
    setEntries(null);
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  return (
    <section aria-label="执行审计" className={COLUMN}>
      <h2 className={HEAD}>执行审计</h2>
      {failed && (
        <p role="status" className="m-0 px-4 py-2 text-xs text-danger">
          审计加载失败{entries ? "，显示的是上一次的结果" : ""}
        </p>
      )}
      {entries?.length === 0 && (
        <p className="m-0 px-4 py-3 text-xs text-mute">还没有记录</p>
      )}
      <ol className="m-0 list-none p-0">
        {entries?.map((e) => (
          <li
            key={e.id}
            className="grid grid-cols-[auto_1fr] gap-x-3 border-b border-line2 px-4 py-2 text-xs"
          >
            <time
              dateTime={e.ts}
              className="font-mono text-mute [font-variant-numeric:tabular-nums]"
            >
              {clock(e.ts)}
            </time>
            <div className="min-w-0">
              <span
                className={`font-semibold ${e.kind === "permission" ? "text-warn-ink" : "text-ink"}`}
              >
                {KIND_LABEL[e.kind] ?? e.kind}
              </span>
              <p className="m-0 break-words text-ink">{e.summary}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// 右栏：会话所用 agent 的能力集。这是 agent 定义的当前值，不是创建时的快照（会话表里没有存快照）。
function CapabilityColumn({ session }: { session: SessionInfo }) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const agentId = session.agentId ?? null;

  useEffect(() => {
    setAgent(null);
    if (!agentId) return;
    let live = true;
    void getAgent(loadToken(), agentId).then((r) => {
      if (live && r.ok) setAgent(r.data);
    });
    return () => {
      live = false;
    };
  }, [agentId]);

  const groups = (["tool", "skill", "mcp"] as const).map((kind) => ({
    kind,
    label: { tool: "内置工具", skill: "Skill", mcp: "MCP" }[kind],
    names: (agent?.capabilities ?? [])
      .filter((c) => c.kind === kind)
      .map((c) => c.name),
  }));

  return (
    <section aria-label="能力集" className={COLUMN}>
      <h2 className={HEAD}>能力集</h2>
      <dl className="m-0 space-y-1 border-b border-line2 px-4 py-3 text-xs">
        <Row k="agent" v={agent?.name ?? (agentId ? "加载中…" : "未指定")} />
        <Row k="模式" v={session.mode ?? "build"} />
        <Row k="模型" v={agent?.model ?? "默认"} />
        <Row k="审核策略" v={session.reviewPolicy ?? "默认"} />
      </dl>
      {groups.map((g) => (
        <div key={g.kind} className="border-b border-line2 px-4 py-3 text-xs">
          <h3 className="m-0 mb-1 font-semibold text-mute">{g.label}</h3>
          {g.names.length === 0 ? (
            <p className="m-0 text-mute">无</p>
          ) : (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {g.names.map((n) => (
                <li
                  key={n}
                  className="rounded-full border border-line px-2 py-0.5 font-mono"
                >
                  {n}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-mute">{k}</dt>
      <dd className="m-0 break-all text-right font-mono text-ink">{v}</dd>
    </div>
  );
}

export function SessionDetail({
  hub,
  session,
}: {
  hub: SessionHub;
  session: SessionInfo;
}) {
  return (
    <div className="grid h-[calc(100vh-190px)] min-h-[420px] grid-cols-1 gap-px overflow-hidden rounded-[var(--radius)] border border-line bg-line lg:grid-cols-[280px_minmax(0,1fr)_260px]">
      <AuditTimeline sessionId={session.id} />
      <section aria-label="对话" className="min-h-0 overflow-auto bg-bg">
        <ConversationView hub={hub} session={session} />
      </section>
      <CapabilityColumn session={session} />
    </div>
  );
}
