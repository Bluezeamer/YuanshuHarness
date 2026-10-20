import { useCallback, useEffect, useState } from "react";
import {
  createMcp,
  deleteMcp,
  listMcp,
  listSecrets,
  loadToken,
  type McpConfigInfo,
  type McpServerInfo,
  refreshMcp,
  type SecretInfo,
  updateMcp,
} from "../api";
import { actionBtn, dangerBtn, describe } from "../settings/shared";
import { McpForm } from "./McpForm";
import { WorkspaceAssign } from "./WorkspaceAssign";

type Unauth = () => void;

const summary = (c: McpConfigInfo) =>
  c.transport === "stdio" ? [c.command, ...c.args].join(" ") : c.url;

function Detail({
  server,
  secrets,
  onReload,
  onDeleted,
  onUnauthorized,
}: {
  server: McpServerInfo;
  secrets: SecretInfo[];
  onReload(): Promise<void>;
  onDeleted(name: string): void;
  onUnauthorized: Unauth;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    const r = await refreshMcp(loadToken(), server.name);
    if (!r.ok && r.kind === "unauthorized") onUnauthorized();
    // 连不上时 502：原因记在服务端状态里，重新拉列表即可显示。
    await onReload();
    setBusy(false);
  };
  const remove = async () => {
    const r = await deleteMcp(loadToken(), server.name);
    if (r.ok || r.kind === "not_found") onDeleted(server.name);
    else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(describe(r));
    }
  };
  const save = async (_: string, config: McpConfigInfo) => {
    const r = await updateMcp(loadToken(), server.name, config);
    if (r.ok) {
      await onReload();
      setEditing(false);
      return null;
    }
    if (r.kind === "unauthorized") onUnauthorized();
    return describe(r, { bad_request: "配置不合法，请检查各项" });
  };

  if (editing)
    return (
      <McpForm
        initial={server}
        secrets={secrets}
        onSubmit={save}
        onCancel={() => setEditing(false)}
      />
    );

  const st = server.status;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-base font-bold">{server.name}</h3>
        <code className="break-all font-mono text-xs text-mute">
          {server.config.transport === "stdio" ? "stdio" : "streamable-http"} ·{" "}
          {summary(server.config)}
        </code>
        <p
          className={`m-0 text-xs ${st?.state === "error" ? "font-semibold text-acc" : "text-mute"}`}
        >
          {st === null
            ? "尚未连接"
            : st.state === "ok"
              ? "连接正常"
              : `连接失败：${st.error ?? "未知原因"}`}
        </p>
      </div>

      <section aria-label="工具列表" className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-bold">
          工具{server.tools ? `（${server.tools.length}）` : ""}
        </h3>
        {server.tools === null ? (
          <p className="m-0 text-mute">
            还没有列出过工具，点「刷新工具列表」。
          </p>
        ) : (
          <ul className="m-0 list-none border-t border-ink p-0">
            {server.tools.map((t) => (
              <li key={t.name} className="border-b border-line2 py-2">
                <span className="block font-mono font-semibold">{t.name}</span>
                <span className="block text-xs text-mute">{t.description}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-xs text-mute">工具调用默认需要审批。</p>
      </section>

      <WorkspaceAssign
        kind="mcp"
        name={server.name}
        onUnauthorized={onUnauthorized}
      />

      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className={actionBtn}
        >
          刷新工具列表
        </button>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={actionBtn}
        >
          编辑配置
        </button>
        {confirm ? (
          <>
            <button
              type="button"
              onClick={() => void remove()}
              className={dangerBtn}
            >
              确认删除
            </button>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              className={actionBtn}
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className={dangerBtn}
          >
            删除登记
          </button>
        )}
      </div>
    </div>
  );
}

export function McpPanel({ onUnauthorized }: { onUnauthorized: Unauth }) {
  const [list, setList] = useState<McpServerInfo[] | "loading" | "failed">(
    "loading",
  );
  const [secrets, setSecrets] = useState<SecretInfo[]>([]);
  // "new" 表示右侧显示登记表单。
  const [sel, setSel] = useState<string | "new" | null>(null);

  const load = useCallback(async () => {
    const [r, s] = await Promise.all([
      listMcp(loadToken()),
      listSecrets(loadToken()),
    ]);
    if (!r.ok && r.kind === "unauthorized") onUnauthorized();
    if (s.ok) setSecrets(s.data);
    setList(r.ok ? r.data : "failed");
    if (r.ok) setSel((cur) => cur ?? r.data[0]?.name ?? "new");
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (name: string, config: McpConfigInfo) => {
    const r = await createMcp(loadToken(), { name, config });
    if (r.ok) {
      await load();
      setSel(r.data.name);
      return null;
    }
    if (r.kind === "unauthorized") onUnauthorized();
    return describe(r, {
      bad_request: "名称或配置不合法，请检查各项",
      conflict: "已有同名 MCP",
    });
  };

  if (list === "loading") return <p className="p-6 text-mute">加载中…</p>;
  if (list === "failed")
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p role="alert" className="m-0 font-semibold text-acc">
          MCP 库加载失败
        </p>
        <button type="button" onClick={() => void load()} className={actionBtn}>
          重试
        </button>
      </div>
    );

  const current = list.find((s) => s.name === sel);
  return (
    <div className="grid min-h-0 grid-cols-1 border border-ink min-[900px]:grid-cols-[240px_1fr]">
      <div className="border-b border-ink min-[900px]:border-r min-[900px]:border-b-0">
        <ul className="m-0 list-none p-0">
          {list.map((s) => (
            <li key={s.name}>
              <button
                type="button"
                aria-current={s.name === sel ? "true" : undefined}
                onClick={() => setSel(s.name)}
                className={`grid w-full gap-0.5 border-b border-line2 px-4 py-3 text-left hover:bg-ink/5 ${s.name === sel ? "bg-ink/5 shadow-[inset_3px_0_0_var(--ink)]" : ""}`}
              >
                <span className="truncate font-semibold">{s.name}</span>
                <span
                  className={`truncate text-xs ${s.status?.state === "error" ? "font-semibold text-acc" : "text-mute"}`}
                >
                  {s.status === null
                    ? "尚未连接"
                    : s.status.state === "ok"
                      ? "连接正常"
                      : "连接失败"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-current={sel === "new" ? "true" : undefined}
          onClick={() => setSel("new")}
          className="w-full px-4 py-3 text-left font-semibold hover:bg-ink hover:text-bg"
        >
          登记 MCP
        </button>
      </div>
      <div className="min-w-0 p-5">
        {sel === "new" || !current ? (
          <McpForm secrets={secrets} onSubmit={create} />
        ) : (
          <Detail
            key={current.name}
            server={current}
            secrets={secrets}
            onUnauthorized={onUnauthorized}
            onReload={load}
            onDeleted={(name) => {
              const rest = list.filter((x) => x.name !== name);
              setList(rest);
              setSel(rest[0]?.name ?? "new");
            }}
          />
        )}
      </div>
    </div>
  );
}
