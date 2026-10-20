import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { useContext, useEffect, useRef, useState } from "react";
import { loadToken } from "../api";
import { EnvContext } from "../layout/env";
import type { PaneProps } from "../layout/types";
import { type RawFailure, readBytes } from "./api";
import { baseName } from "./download";

export interface PdfConfig {
  environmentId: string | null;
  path: string | null;
  page: number;
  // 缩放倍数，1 即适合窄 pane 的默认大小
  scale: number;
}

export const SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
// 画布按这个倍数多渲染一些像素保证清晰，显示时缩回 CSS 尺寸。1 倍时一页约 600px 宽。
const SHARP = 1.5;

const FAIL: Record<RawFailure, string> = {
  unauthorized: "登录已失效",
  forbidden: "没有权限读取",
  not_found: "文件不存在",
  conflict: "不是普通文件",
  too_large: "文件太大，无法在浏览器里打开",
  network: "网络不通",
  server: "Server 出错",
};

// pdf.js 体积大，用到时才取。worker 以 ?url 方式由构建产出，仍是同源资源。
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

const btn =
  "grid h-6 min-w-6 place-items-center rounded-lg border border-line bg-panel px-1.5 font-mono text-xs text-mute hover:border-accent hover:bg-accent-soft hover:text-accent-deep disabled:opacity-35 disabled:hover:border-line disabled:hover:bg-panel disabled:hover:text-mute";

type State =
  | { kind: "loading" }
  | { kind: "ready"; doc: PDFDocumentProxy }
  | { kind: "error"; message: string };

export function PdfPane({ config, onUpdateConfig }: PaneProps<PdfConfig>) {
  const env = useContext(EnvContext);
  const [state, setState] = useState<State>({ kind: "loading" });
  const canvas = useRef<HTMLCanvasElement>(null);
  const { environmentId, path } = config;
  const scale = SCALES.includes(config.scale) ? config.scale : 1;

  useEffect(() => {
    if (!environmentId || !path) return;
    let alive = true;
    let loading: PDFDocumentLoadingTask | null = null;
    setState({ kind: "loading" });
    void (async () => {
      const r = await readBytes(loadToken(), environmentId, path);
      if (!alive) return;
      if (!r.ok) {
        if (r.kind === "unauthorized") env?.hub.onUnauthorized();
        setState({ kind: "error", message: FAIL[r.kind] });
        return;
      }
      try {
        const pdfjs = await loadPdfjs();
        if (!alive) return;
        loading = pdfjs.getDocument({ data: r.data });
        const d = await loading.promise;
        if (alive) setState({ kind: "ready", doc: d });
      } catch {
        if (alive) setState({ kind: "error", message: "不是有效的 PDF 文件" });
      }
    })();
    return () => {
      alive = false;
      void loading?.destroy();
    };
  }, [environmentId, path, env]);

  const total = state.kind === "ready" ? state.doc.numPages : 0;
  const page = Math.min(Math.max(1, config.page), Math.max(1, total));

  useEffect(() => {
    if (state.kind !== "ready") return;
    let alive = true;
    let task: RenderTask | null = null;
    void state.doc.getPage(page).then((p) => {
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (!alive || !el || !ctx) return;
      const viewport = p.getViewport({ scale: scale * SHARP });
      el.width = viewport.width;
      el.height = viewport.height;
      el.style.width = `${viewport.width / SHARP}px`;
      el.style.height = `${viewport.height / SHARP}px`;
      task = p.render({ canvasContext: ctx, viewport, canvas: el });
      task.promise.catch(() => {});
    });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [state, page, scale]);

  if (!environmentId || !path)
    return (
      <p className="p-4 text-xs text-mute" data-pdf-pane>
        在文件预览里点「用 PDF 阅读器打开」，或从文件管理器选一个 PDF。
      </p>
    );

  const set = (patch: Partial<PdfConfig>) =>
    onUpdateConfig({ ...config, ...patch });
  const si = SCALES.indexOf(scale);

  return (
    <div className="flex h-full min-h-0 flex-col" data-pdf-pane>
      <div className="flex items-center gap-2 border-b border-line bg-line2 px-3 py-1.5">
        <span className="min-w-0 truncate text-xs font-medium" title={path}>
          {baseName(path)}
        </span>
        <span className="ml-auto font-mono text-[11px] text-mute">
          {total > 0 ? `${page} / ${total}` : ""}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            className={btn}
            aria-label="缩小"
            disabled={si <= 0}
            onClick={() => set({ scale: SCALES[si - 1] ?? scale })}
          >
            −
          </button>
          <span
            className="grid min-w-10 place-items-center font-mono text-[11px] text-mute"
            title="缩放"
          >
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className={btn}
            aria-label="放大"
            disabled={si >= SCALES.length - 1}
            onClick={() => set({ scale: SCALES[si + 1] ?? scale })}
          >
            +
          </button>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            className={btn}
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => set({ page: page - 1 })}
          >
            ←
          </button>
          <button
            type="button"
            className={btn}
            aria-label="下一页"
            disabled={page >= total}
            onClick={() => set({ page: page + 1 })}
          >
            →
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-bg p-3.5">
        {state.kind === "loading" && (
          <p className="text-xs text-mute">加载中…</p>
        )}
        {state.kind === "error" && (
          <p role="alert" className="text-xs text-danger">
            {state.message}
          </p>
        )}
        {state.kind === "ready" && (
          <canvas
            ref={canvas}
            aria-label={`第 ${page} 页`}
            className="mx-auto rounded-lg border border-line bg-panel shadow-card"
          />
        )}
      </div>
    </div>
  );
}
