import { useEffect, useRef, useState } from "react";
import { type DirListing, listDirs, loadToken } from "../api";
import { actionBtn, describe } from "./shared";

export interface DirChoice {
  path: string;
  usable: boolean;
}

type View =
  | { state: "loading" }
  | { state: "failed"; msg: string }
  | { state: "ok"; data: DirListing };

// 本期唯一主机是本机。onChange 在加载中或失败时给 null。
// jump 每次换新对象即可让选择器跳到指定目录。
export function DirPicker({
  jump,
  onChange,
  onUnauthorized,
}: {
  jump?: { path: string };
  onChange(c: DirChoice | null): void;
  onUnauthorized(): void;
}) {
  const [req, setReq] = useState<string | undefined>(jump?.path);
  const [hidden, setHidden] = useState(false);
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<View>({ state: "loading" });
  const cbs = useRef({ onChange, onUnauthorized });
  cbs.current = { onChange, onUnauthorized };

  useEffect(() => {
    if (jump) setReq(jump.path);
  }, [jump]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry 仅用于触发重新加载
  useEffect(() => {
    let live = true;
    setView({ state: "loading" });
    cbs.current.onChange(null);
    void listDirs(loadToken(), req, hidden).then((r) => {
      if (!live) return;
      if (r.ok) {
        setView({ state: "ok", data: r.data });
        cbs.current.onChange({
          path: r.data.path,
          usable: r.data.readable && r.data.writable,
        });
      } else {
        if (r.kind === "unauthorized") cbs.current.onUnauthorized();
        setView({
          state: "failed",
          msg: describe(r, { bad_request: "目录不存在或不是目录" }),
        });
      }
    });
    return () => {
      live = false;
    };
  }, [req, hidden, retry]);

  const d = view.state === "ok" ? view.data : null;
  const parts = d ? d.path.split("/").filter(Boolean) : [];
  const crumbs = [
    { label: "/", name: "根目录", path: "/" },
    ...parts.map((p, i) => ({
      label: p,
      name: p,
      path: `/${parts.slice(0, i + 1).join("/")}`,
    })),
  ];
  const usable = d ? d.readable && d.writable : false;
  const avail = !d
    ? ""
    : !d.readable
      ? "不可读"
      : !d.writable
        ? "只读"
        : "可读写";

  return (
    <section aria-label="选择目录" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold">
          主机：<span className="font-mono">本机</span>
        </span>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
          />
          显示隐藏目录
        </label>
      </div>

      {view.state === "loading" && <p className="m-0 text-mute">加载目录…</p>}
      {view.state === "failed" && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="m-0 font-semibold text-danger">
            {view.msg}
          </p>
          <button
            type="button"
            onClick={() => setRetry((n) => n + 1)}
            className={actionBtn}
          >
            重试
          </button>
        </div>
      )}

      {d && (
        <>
          <nav
            aria-label="路径"
            className="flex flex-wrap items-center gap-x-1 font-mono text-xs"
          >
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-x-1">
                {i > 1 && <span aria-hidden="true">/</span>}
                {i === crumbs.length - 1 ? (
                  <span aria-current="location" className="font-bold">
                    {c.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={c.name}
                    onClick={() => setReq(c.path)}
                    className="px-1 hover:bg-ink hover:text-bg"
                  >
                    {c.label}
                  </button>
                )}
              </span>
            ))}
          </nav>

          {d.dirs.length === 0 ? (
            <p className="m-0 border border-line px-3 py-2 text-mute">
              {d.readable ? "没有子目录" : "无法读取该目录"}
            </p>
          ) : (
            <ul
              aria-label="子目录"
              className="m-0 max-h-60 list-none overflow-y-auto border border-ink p-0"
            >
              {d.dirs.map((n) => (
                <li key={n} className="border-b border-line2 last:border-b-0">
                  <button
                    type="button"
                    onClick={() =>
                      setReq(d.path === "/" ? `/${n}` : `${d.path}/${n}`)
                    }
                    className="w-full px-3 py-1.5 text-left font-mono text-xs hover:bg-ink/5"
                  >
                    {n}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {d.truncated && (
            <p className="m-0 text-xs text-mute">
              目录项过多，仅显示前 {d.dirs.length} 项，可能缺少部分子目录
            </p>
          )}
          <p role="status" className="m-0 text-xs">
            当前目录：
            <span
              className={`font-semibold ${usable ? "text-ok-ink" : "text-danger"}`}
            >
              {avail}
            </span>
            {!usable && "，不能用作工作区"}
          </p>
        </>
      )}
    </section>
  );
}
