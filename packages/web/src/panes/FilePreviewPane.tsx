import { useContext, useEffect, useState } from "react";
import { loadToken } from "../api";
import { EnvContext } from "../layout/env";
import type { PaneProps } from "../layout/types";
import {
  type Preview,
  type RawFailure,
  readDownload,
  readPreview,
} from "./api";
import { baseName, saveBlob, sizeText } from "./download";

export interface FilePreviewConfig {
  environmentId: string | null;
  path: string | null;
}

// 只取前这么多字节：大文件整个拉下来既慢又没法读。
export const PREVIEW_LIMIT = 256 * 1024;

const FAIL: Record<RawFailure, string> = {
  unauthorized: "登录已失效",
  forbidden: "没有权限读取",
  not_found: "文件不存在",
  conflict: "不是普通文件",
  too_large: "文件太大",
  network: "网络不通",
  server: "Server 出错",
};

type State =
  | { kind: "loading" }
  | { kind: "text"; text: string; total: number; shown: number }
  | { kind: "binary"; contentType: string; total: number }
  | { kind: "error"; failure: RawFailure };

const isTextType = (t: string) =>
  t.startsWith("text/") || t.startsWith("application/json");

// 服务端对不认识的扩展名给 octet-stream，这时看开头有没有 NUL 来判断是不是文本。
const looksBinary = (b: Uint8Array) => b.subarray(0, 8192).includes(0);

function classify(p: Preview): State {
  const text =
    isTextType(p.contentType) ||
    (p.contentType.startsWith("application/octet-stream") &&
      !looksBinary(p.bytes));
  if (!text)
    return { kind: "binary", contentType: p.contentType, total: p.total };
  return {
    kind: "text",
    text: new TextDecoder("utf-8").decode(p.bytes),
    total: p.total,
    shown: p.bytes.length,
  };
}

const btn =
  "rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-ink hover:bg-ink hover:text-bg";

export function FilePreviewPane({ config }: PaneProps<FilePreviewConfig>) {
  const env = useContext(EnvContext);
  const [state, setState] = useState<State>({ kind: "loading" });
  const { environmentId, path } = config;

  useEffect(() => {
    if (!environmentId || !path) return;
    let alive = true;
    setState({ kind: "loading" });
    void readPreview(
      loadToken(),
      environmentId,
      path,
      PREVIEW_LIMIT,
      false,
    ).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setState(classify(r.data));
        return;
      }
      if (r.kind === "unauthorized") env?.hub.onUnauthorized();
      setState({ kind: "error", failure: r.kind });
    });
    return () => {
      alive = false;
    };
  }, [environmentId, path, env]);

  if (!environmentId || !path)
    return (
      <p className="p-4 text-xs text-mute" data-fp-pane>
        在文件管理器里点一个文件，这里显示它的内容。
      </p>
    );

  const download = async () => {
    const r = await readDownload(loadToken(), environmentId, path);
    if (r.ok) saveBlob(r.data, baseName(path));
  };
  const isPdf =
    state.kind === "binary" && state.contentType === "application/pdf";
  const lines = state.kind === "text" ? state.text.split("\n") : [];

  return (
    <div className="flex h-full min-h-0 flex-col" data-fp-pane>
      <div className="flex items-center gap-2 border-b border-line bg-line2 px-3 py-1.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-mute"
          title={path}
        >
          {environmentId}:{path}
        </span>
        {isPdf && (
          <button
            type="button"
            className={btn}
            onClick={() =>
              env?.openContent?.({
                type: "pdf",
                host: null,
                config: { environmentId, path, page: 1, scale: 1 },
              })
            }
          >
            用 PDF 阅读器打开
          </button>
        )}
        <button type="button" className={btn} onClick={() => void download()}>
          下载
        </button>
      </div>
      {state.kind === "text" && state.shown < state.total && (
        <p
          role="status"
          className="border-b border-line2 bg-warn-soft px-3 py-1 text-[11px] text-warn-ink"
        >
          文件共 {sizeText(state.total)}，只显示前 {sizeText(state.shown)}
          。完整内容请下载。
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {state.kind === "loading" ? (
          <p className="p-3 text-xs text-mute">加载中…</p>
        ) : state.kind === "error" ? (
          <p role="alert" className="p-3 text-xs text-danger">
            {FAIL[state.failure]}
          </p>
        ) : state.kind === "binary" ? (
          <p role="status" className="p-4 text-xs text-mute">
            这是二进制文件（{state.contentType || "未知类型"}，
            {sizeText(state.total)}）， 不能在这里显示。可以下载后查看。
          </p>
        ) : (
          <ol className="code-ol">
            {lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行号即身份，内容只读
              <li key={i}>{l}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
