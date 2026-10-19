import { useEffect, useRef, useState } from "react";
import {
  createSession,
  listWorkspaces,
  loadToken,
  type WorkspaceInfo,
} from "../api";
import { actionBtn, describe, field } from "./shared";

// 新建会话：可选 workspace，缺省交给服务端（最早登记的）。
export function NewSession({
  onCreated,
  onCancel,
  onUnauthorized,
}: {
  onCreated(): void;
  onCancel(): void;
  onUnauthorized(): void;
}) {
  const [list, setList] = useState<WorkspaceInfo[] | "loading" | "failed">(
    "loading",
  );
  const [ws, setWs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    let live = true;
    void listWorkspaces(loadToken()).then((r) => {
      if (!live) return;
      if (!r.ok && r.kind === "unauthorized") onUnauthorized();
      setList(r.ok ? r.data : "failed");
      if (r.ok) setWs(r.data[0]?.id ?? "");
    });
    return () => {
      live = false;
    };
  }, [onUnauthorized]);

  useEffect(() => {
    if (list !== "loading") first.current?.focus();
  }, [list]);

  const create = async () => {
    setBusy(true);
    setError(null);
    const r = await createSession(loadToken(), ws ? { workspaceId: ws } : {});
    setBusy(false);
    if (r.ok) onCreated();
    else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(
        describe(r, { bad_request: "工作区目录不可用，请检查或换一个" }),
      );
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 仅用于捕获 Esc
    <div
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
      className="absolute inset-0 z-40 grid place-items-start justify-items-end bg-bg/60 p-4 backdrop-blur-[3px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="新建会话"
        className="enter flex w-[min(360px,92vw)] flex-col gap-4 border border-ink bg-panel p-4"
      >
        <h2 className="m-0 text-base font-bold">新建会话</h2>
        {list === "loading" && <p className="m-0 text-mute">加载工作区…</p>}
        {list === "failed" && (
          <p role="alert" className="m-0 font-semibold text-acc">
            工作区加载失败，将使用服务端默认工作区
          </p>
        )}
        {Array.isArray(list) && list.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor="new-ws" className="text-xs font-semibold">
              工作区
            </label>
            <select
              id="new-ws"
              ref={first}
              value={ws}
              onChange={(e) => setWs(e.target.value)}
              className={field}
            >
              {list.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}（{w.path}）
                </option>
              ))}
            </select>
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 font-semibold text-acc">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            disabled={busy || list === "loading"}
            onClick={() => void create()}
            className={actionBtn}
          >
            创建
          </button>
          <button type="button" onClick={onCancel} className={actionBtn}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
