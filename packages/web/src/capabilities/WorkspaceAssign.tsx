import { type ReactNode, useEffect, useState } from "react";
import {
  getWorkspaceNames,
  listWorkspaces,
  loadToken,
  setWorkspaceNames,
  type WorkspaceInfo,
} from "../api";
import { describe } from "../settings/shared";

// 把某个 skill / MCP 分配给 workspace：每个工作区一行复选框，整体替换式保存。
export function WorkspaceAssign({
  kind,
  name,
  onUnauthorized,
  extra,
}: {
  kind: "skills" | "mcp";
  name: string;
  onUnauthorized(): void;
  extra?(ws: WorkspaceInfo): ReactNode;
}) {
  const [rows, setRows] = useState<
    { ws: WorkspaceInfo; names: string[] }[] | "loading" | "failed"
  >("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows("loading");
    void (async () => {
      const list = await listWorkspaces(loadToken());
      if (!list.ok) {
        if (list.kind === "unauthorized") onUnauthorized();
        if (live) setRows("failed");
        return;
      }
      const got = await Promise.all(
        list.data.map((ws) => getWorkspaceNames(loadToken(), ws.id, kind)),
      );
      if (!live) return;
      if (got.some((g) => !g.ok)) return setRows("failed");
      setRows(
        list.data.map((ws, i) => ({
          ws,
          names: (got[i] as { ok: true; data: string[] }).data,
        })),
      );
    })();
    return () => {
      live = false;
    };
  }, [kind, onUnauthorized]);

  const toggle = async (id: string, on: boolean) => {
    if (!Array.isArray(rows)) return;
    const cur = rows.find((r) => r.ws.id === id)?.names ?? [];
    const next = on ? [...cur, name] : cur.filter((n) => n !== name);
    setError(null);
    const r = await setWorkspaceNames(loadToken(), id, kind, next);
    if (r.ok)
      setRows((all) =>
        Array.isArray(all)
          ? all.map((x) => (x.ws.id === id ? { ...x, names: r.data } : x))
          : all,
      );
    else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(describe(r, { bad_request: "分配被拒绝，请刷新后重试" }));
    }
  };

  return (
    <section aria-label="工作区分配" className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-bold">分配到工作区</h3>
      {rows === "loading" && <p className="m-0 text-mute">加载中…</p>}
      {rows === "failed" && (
        <p role="alert" className="m-0 font-semibold text-acc">
          工作区加载失败
        </p>
      )}
      {Array.isArray(rows) && rows.length === 0 && (
        <p className="m-0 text-mute">还没有工作区</p>
      )}
      {Array.isArray(rows) && rows.length > 0 && (
        <ul className="m-0 list-none border-t border-ink p-0">
          {rows.map(({ ws, names }) => (
            <li
              key={ws.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-line2 py-2"
            >
              <input
                type="checkbox"
                aria-label={`分配给 ${ws.name}`}
                checked={names.includes(name)}
                onChange={(e) => void toggle(ws.id, e.target.checked)}
              />
              <span className="min-w-0">
                <span className="block truncate font-semibold">{ws.name}</span>
                <span className="block truncate font-mono text-xs text-mute">
                  {ws.path}
                </span>
              </span>
              {extra?.(ws)}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
    </section>
  );
}
