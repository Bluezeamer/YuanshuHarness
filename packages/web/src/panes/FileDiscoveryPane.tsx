import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { loadToken } from "../api";
import { EnvContext } from "../layout/env";
import type { PaneProps } from "../layout/types";
import {
  type FileEntry,
  type FileListing,
  listFiles,
  makeDir,
  type RawFailure,
  readDownload,
  removeEntry,
  uploadFile,
} from "./api";
import { joinPath, saveBlob, sizeText } from "./download";
import { useHost } from "./host";

export interface FileDiscoveryConfig {
  // 记下是哪个环境里的路径：跟随的会话换了主机，旧路径就不适用，回到该主机的 workspace 根。
  environmentId: string | null;
  path: string | null;
}

const FAIL: Record<RawFailure | "bad_request" | "rate_limited", string> = {
  unauthorized: "登录已失效",
  forbidden: "没有权限",
  not_found: "目标不存在",
  conflict: "已存在同名项",
  too_large: "文件太大",
  network: "网络不通",
  server: "Server 出错",
  bad_request: "路径不合法",
  rate_limited: "请求太频繁，稍后再试",
};

const btn =
  "rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-ink hover:bg-ink hover:text-bg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink";

const Icon = ({ dir }: { dir: boolean }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinejoin="round"
    className={`size-3.5 shrink-0 ${dir ? "text-info" : "text-mute"}`}
  >
    {dir ? (
      <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1Z" />
    ) : (
      <path d="M4 2h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM9 2v3h3" />
    )}
  </svg>
);

export function FileDiscoveryPane({
  config,
  binding,
  onUpdateConfig,
}: PaneProps<FileDiscoveryConfig>) {
  const env = useContext(EnvContext);
  const host = useHost(binding);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // 删除、新建目录、覆盖上传都先在头下一行里确认，不弹窗。
  const [mode, setMode] = useState<
    | { kind: "idle" }
    | { kind: "mkdir" }
    | { kind: "delete"; entry: FileEntry }
    | { kind: "overwrite"; file: File }
  >({ kind: "idle" });
  const [dirName, setDirName] = useState("");
  const [tick, setTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const path =
    config.environmentId === host.environmentId && config.path
      ? config.path
      : (host.root ?? "/");
  const go = (next: string) =>
    onUpdateConfig({ environmentId: host.environmentId, path: next });

  const denied = useCallback(
    (kind: string) => {
      if (kind === "unauthorized") env?.hub.onUnauthorized();
    },
    [env],
  );

  // tick 只用来在上传、删除后重新取目录
  useEffect(() => {
    void tick;
    if (!host.ready) return;
    let alive = true;
    setError(null);
    void listFiles(loadToken(), host.environmentId, path, hidden).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setListing(r.data);
        return;
      }
      denied(r.kind);
      setListing(null);
      setError(
        r.kind === "not_found"
          ? "目录不存在"
          : (FAIL[r.kind as keyof typeof FAIL] ?? "读取失败"),
      );
    });
    return () => {
      alive = false;
    };
  }, [host.ready, host.environmentId, path, hidden, tick, denied]);

  const reload = () => setTick((n) => n + 1);
  const dir = listing?.path ?? path;

  const open = (e: FileEntry) => {
    setSelected(e.name);
    if (e.type === "dir") go(joinPath(dir, e.name));
    else if (e.type === "file")
      env?.openContent?.({
        type: "file_preview",
        host: host.environmentId,
        config: {
          environmentId: host.environmentId,
          path: joinPath(dir, e.name),
        },
        same: (p) =>
          (p.config as { environmentId?: string; path?: string }).path ===
            joinPath(dir, e.name) &&
          (p.config as { environmentId?: string }).environmentId ===
            host.environmentId,
      });
  };

  const entry = listing?.entries.find((e) => e.name === selected) ?? null;

  const download = async () => {
    if (entry?.type !== "file") return;
    setNotice(null);
    const r = await readDownload(
      loadToken(),
      host.environmentId,
      joinPath(dir, entry.name),
    );
    if (r.ok) saveBlob(r.data, entry.name);
    else {
      denied(r.kind);
      setNotice(`下载失败：${FAIL[r.kind]}`);
    }
  };

  const upload = async (file: File, overwrite: boolean) => {
    setNotice(null);
    const r = await uploadFile(
      loadToken(),
      host.environmentId,
      joinPath(dir, file.name),
      file,
      overwrite,
      host.sessionId,
    );
    if (r.ok) {
      setMode({ kind: "idle" });
      reload();
    } else if (r.kind === "conflict" && !overwrite) {
      setMode({ kind: "overwrite", file });
    } else {
      denied(r.kind);
      setMode({ kind: "idle" });
      setNotice(`上传失败：${FAIL[r.kind]}`);
    }
  };

  const mkdir = async () => {
    const name = dirName.trim();
    if (!name || name.includes("/")) {
      setNotice("目录名不能为空，也不能含 /");
      return;
    }
    const r = await makeDir(
      loadToken(),
      host.environmentId,
      joinPath(dir, name),
      host.sessionId,
    );
    if (r.ok) {
      setMode({ kind: "idle" });
      setDirName("");
      setNotice(null);
      reload();
    } else {
      denied(r.kind);
      setNotice(`新建失败：${FAIL[r.kind]}`);
    }
  };

  const remove = async (e: FileEntry) => {
    const r = await removeEntry(
      loadToken(),
      host.environmentId,
      joinPath(dir, e.name),
      e.type === "dir",
      host.sessionId,
    );
    setMode({ kind: "idle" });
    if (r.ok) {
      setSelected(null);
      setNotice(null);
      reload();
    } else {
      denied(r.kind);
      setNotice(`删除失败：${FAIL[r.kind]}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-fd-pane>
      <div className="flex items-center gap-2 border-b border-line bg-line2 px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-mute"
          title={`${host.environmentName}:${dir}`}
        >
          {host.environmentName}:{dir}
        </span>
        <label className="flex items-center gap-1 text-[11px] text-mute">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
          />
          隐藏文件
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line2 px-3 py-1.5">
        <button
          type="button"
          className={btn}
          disabled={!listing?.parent}
          onClick={() => listing?.parent && go(listing.parent)}
        >
          上一级
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => setMode({ kind: "mkdir" })}
        >
          新建目录
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => fileInput.current?.click()}
        >
          上传
        </button>
        <button
          type="button"
          className={btn}
          disabled={entry?.type !== "file"}
          onClick={() => void download()}
        >
          下载
        </button>
        <button
          type="button"
          className={`${btn} text-danger`}
          disabled={!entry}
          onClick={() => entry && setMode({ kind: "delete", entry })}
        >
          删除
        </button>
        <button type="button" className={btn} onClick={reload}>
          刷新
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          aria-label="选择要上传的文件"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f, false);
          }}
        />
      </div>
      {mode.kind === "mkdir" && (
        <form
          className="flex items-center gap-2 border-b border-line2 px-3 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void mkdir();
          }}
        >
          <input
            value={dirName}
            onChange={(e) => setDirName(e.target.value)}
            aria-label="新目录名"
            placeholder="新目录名"
            className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-0.5 font-mono text-xs"
          />
          <button type="submit" className={btn}>
            创建
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => setMode({ kind: "idle" })}
          >
            取消
          </button>
        </form>
      )}
      {mode.kind === "delete" && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-line2 bg-danger-soft px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1 truncate">
            {mode.entry.type === "dir"
              ? `删除目录 ${mode.entry.name} 及其全部内容？`
              : `删除 ${mode.entry.name}？`}
          </span>
          <button
            type="button"
            className={`${btn} text-danger`}
            onClick={() => void remove(mode.entry)}
          >
            确认删除
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => setMode({ kind: "idle" })}
          >
            取消
          </button>
        </div>
      )}
      {mode.kind === "overwrite" && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-line2 bg-warn-soft px-3 py-1.5 text-xs text-warn-ink"
        >
          <span className="min-w-0 flex-1 truncate">
            {mode.file.name} 已存在，覆盖？
          </span>
          <button
            type="button"
            className={btn}
            onClick={() => void upload(mode.file, true)}
          >
            覆盖
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => setMode({ kind: "idle" })}
          >
            取消
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="px-3 py-1.5 text-xs text-danger">
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p role="alert" className="p-3 text-xs text-danger">
            {error}
          </p>
        ) : !listing ? (
          <p className="p-3 text-xs text-mute">加载中…</p>
        ) : listing.entries.length === 0 ? (
          <p className="p-3 text-xs text-mute">目录为空</p>
        ) : (
          <ul className="list-none py-1">
            {listing.entries.map((e) => (
              <li key={e.name} className="mx-1">
                <button
                  type="button"
                  aria-pressed={selected === e.name}
                  onClick={() => open(e)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left font-mono text-[12.5px] hover:bg-line2 ${
                    selected === e.name ? "bg-accent-soft text-accent-deep" : ""
                  } ${e.type === "dir" ? "font-semibold" : ""}`}
                >
                  <Icon dir={e.type === "dir"} />
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  {e.symlink !== undefined && (
                    <span className="text-[10px] text-mute">
                      {e.broken ? "断链" : "链接"}
                    </span>
                  )}
                  {e.type === "file" && (
                    <span className="text-[10px] text-mute">
                      {sizeText(e.size)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing?.truncated && (
          <p className="px-3 py-1.5 text-[11px] text-mute">
            目录项过多，只显示前一部分
          </p>
        )}
      </div>
    </div>
  );
}
