// PDF 阅读：pdf.js 按需加载。
// 连续滚动：所有页按顺序排成一个长列表，滚到哪渲染哪（IntersectionObserver 懒渲染），
// 不是一次全画——3000 页的文档也不会卡死。
// 侧边目录：pdf.js 的 getOutline() 给出书签树，点一项滚到对应页，滚动时高亮当前章节。
// 画布上叠一层透明文字层，所以文字仍可选取复制。
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton, InlineNotice } from "../../../../ui";

export const SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
// 画布多渲染一些像素保证清晰，显示时缩回 CSS 尺寸
const SHARP = 1.5;
// 距离可视区多远就开始渲染（提前量，滚起来不出现白块）
const AHEAD = "800px";
// 字体 / CMap / WASM 解码器由 scripts/copy-pdfjs-assets.mjs 复制到 public/pdfjs/，
// 不传的话 pdf.js 404 后回退内置字体：中文等 CID 文档会显示异常。
const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

// 只加载一次并复用：每页都要用同一个 pdf.js 实例，重复 import 既浪费也会让
// workerSrc 被反复赋值。
let pdfjsLoading: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  pdfjsLoading ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return pdfjsLoading;
}

type Doc =
  | { kind: "loading" }
  | { kind: "ready"; doc: PDFDocumentProxy }
  | { kind: "error" };

/** 书签树：page 是 1 起的页号，null 表示定位不到（外链之类）。 */
interface OutlineNode {
  title: string;
  page: number | null;
  children: OutlineNode[];
}

// pdf.js 的 dest 可能是名字，也可能是数组；统一解析成 1 起的页号。
async function pageOfDest(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number | null> {
  if (!dest) return null;
  try {
    const arr =
      typeof dest === "string" ? await doc.getDestination(dest) : dest;
    const ref = Array.isArray(arr) ? arr[0] : null;
    if (!ref) return null;
    if (typeof ref === "number") return ref + 1;
    const idx = await doc.getPageIndex(
      ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0],
    );
    return idx + 1;
  } catch {
    return null;
  }
}

async function loadOutline(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = await doc.getOutline().catch(() => null);
  if (!raw) return [];
  const walk = async (
    items: {
      title: string;
      dest: string | unknown[] | null;
      items?: unknown[];
    }[],
  ): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = [];
    for (const it of items) {
      const page = await pageOfDest(doc, it.dest);
      const children = Array.isArray(it.items)
        ? await walk(
            it.items as {
              title: string;
              dest: string | unknown[] | null;
              items?: unknown[];
            }[],
          )
        : [];
      out.push({ title: it.title, page, children });
    }
    return out;
  };
  return walk(raw).catch(() => []);
}

export function PdfView({ bytes }: { bytes: Uint8Array }) {
  const [doc, setDoc] = useState<Doc>({ kind: "loading" });
  const [scale, setScale] = useState(1);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [current, setCurrent] = useState(1);
  // 每页的 CSS 尺寸；还没渲染过的页先用第一页的比例估个高度，渲染后校正
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const pages = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let alive = true;
    let task: PDFDocumentLoadingTask | null = null;
    setDoc({ kind: "loading" });
    setOutline([]);
    setSizes([]);
    setCurrent(1);
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (!alive) return;
        // pdf.js 会把传入的缓冲区转给 worker，给它一份拷贝，原始字节留给重试
        task = pdfjs.getDocument({
          data: bytes.slice(),
          cMapUrl: `${ASSETS}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${ASSETS}standard_fonts/`,
          wasmUrl: `${ASSETS}wasm/`,
          iccUrl: `${ASSETS}iccs/`,
        });
        const d = await task.promise;
        if (!alive) return;
        const first = await d.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        setSizes(
          Array.from({ length: d.numPages }, () => ({
            w: vp.width,
            h: vp.height,
          })),
        );
        setDoc({ kind: "ready", doc: d });
        void loadOutline(d).then((o) => alive && setOutline(o));
      } catch {
        if (alive) setDoc({ kind: "error" });
      }
    })();
    return () => {
      alive = false;
      void task?.destroy();
    };
  }, [bytes]);

  const total = doc.kind === "ready" ? doc.doc.numPages : 0;

  // Ctrl/⌘ + 滚轮换缩放档位（不缩放整个浏览器页面）
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setScale((s) => {
        const i = SCALES.indexOf(s);
        const next =
          SCALES[
            Math.min(
              SCALES.length - 1,
              Math.max(0, i + (e.deltaY < 0 ? 1 : -1)),
            )
          ];
        return next ?? s;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 滚动时把「最靠上且可见的页」当作当前页；程序内跳转期间先别抢
  const markSize = useCallback((i: number, w: number, h: number) => {
    setSizes((prev) => {
      const cur = prev[i];
      if (!cur || (cur.w === w && cur.h === h)) return prev;
      const next = [...prev];
      next[i] = { w, h };
      return next;
    });
  }, []);

  const markVisible = useCallback((n: number) => setCurrent(n), []);

  const jumpTo = (page: number) => {
    const el = pages.current[page - 1];
    if (!el) return;
    setCurrent(page);
    // jsdom 没实现 scrollIntoView，测试环境里跳过滚动
    el.scrollIntoView?.({ block: "start" });
  };

  const si = SCALES.indexOf(scale);
  const nav = useMemo(() => outline.length > 0, [outline.length]);

  return (
    <div className="ws-pv-pdf">
      <div className="ws-pv-pdfbar">
        <IconButton
          label={navOpen ? "收起目录" : "展开目录"}
          size="sm"
          disabled={!nav}
          icon={<span aria-hidden="true">☰</span>}
          onClick={() => setNavOpen((v) => !v)}
        />
        <span className="ws-pv-pdfpage t-mono" aria-live="polite">
          {total > 0 ? `${current} / ${total}` : ""}
        </span>
        <IconButton
          label="缩小"
          size="sm"
          icon={<span aria-hidden="true">−</span>}
          disabled={si <= 0}
          onClick={() => setScale(SCALES[si - 1] ?? scale)}
        />
        <span className="ws-pv-pdfscale t-mono" title="缩放">
          {Math.round(scale * 100)}%
        </span>
        <IconButton
          label="放大"
          size="sm"
          icon={<span aria-hidden="true">+</span>}
          disabled={si >= SCALES.length - 1}
          onClick={() => setScale(SCALES[si + 1] ?? scale)}
        />
      </div>
      <div className="ws-pv-pdfshell">
        {navOpen && nav && (
          <nav className="ws-pv-pdfnav" aria-label="目录">
            <OutlineTree
              nodes={outline}
              current={current}
              onPick={(p) => {
                jumpTo(p);
                setNavOpen(false);
              }}
            />
          </nav>
        )}
        <div className="ws-pv-pdfbody" ref={body}>
          {doc.kind === "loading" && (
            <p className="ws-pv-note t-aux" role="status">
              正在打开 PDF…
            </p>
          )}
          {doc.kind === "error" && (
            <InlineNotice tone="danger" className="ws-pv-note-bad">
              不是有效的 PDF 文件
            </InlineNotice>
          )}
          {doc.kind === "ready" &&
            sizes.map((s, i) => (
              <PdfPage
                // biome-ignore lint/suspicious/noArrayIndexKey: 页号即身份，内容只读
                key={i}
                doc={doc.doc}
                n={i + 1}
                scale={scale}
                size={s}
                root={body}
                onSize={markSize}
                onVisible={markVisible}
                index={i}
                register={pages}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

/** 单页：进入视口前只占位，进入后才建画布与文字层。 */
function PdfPage({
  doc,
  n,
  index,
  scale,
  size,
  root,
  onSize,
  onVisible,
  register,
}: {
  doc: PDFDocumentProxy;
  n: number;
  index: number;
  scale: number;
  size: { w: number; h: number };
  root: React.RefObject<HTMLDivElement | null>;
  onSize(index: number, w: number, h: number): void;
  onVisible(n: number): void;
  register: React.RefObject<(HTMLDivElement | null)[]>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // 没有 IntersectionObserver（测试环境/旧浏览器）就当作已进入视口，直接渲染
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setNear(true);
          // 页面顶部进入上半屏就算「当前页」
          if (e.isIntersecting && e.intersectionRatio > 0.4) onVisible(n);
        }
      },
      { root: root.current, rootMargin: `${AHEAD} 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [n, onVisible, root]);

  useEffect(() => {
    if (!near) return;
    let alive = true;
    let render: RenderTask | null = null;
    let layer: { cancel(): void } | null = null;
    void (async () => {
      const p = await doc.getPage(n).catch(() => null);
      if (!alive || !p) return;
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      const tl = text.current;
      if (!el || !ctx || !tl) return;
      const viewport = p.getViewport({ scale: scale * SHARP });
      el.width = viewport.width;
      el.height = viewport.height;
      el.style.width = `${viewport.width / SHARP}px`;
      el.style.height = `${viewport.height / SHARP}px`;
      render = p.render({ canvasContext: ctx, viewport, canvas: el });
      render.promise.catch(() => {});
      // 回填的是 scale=1 的原始页面尺寸：外层盒子会自己乘 scale，
      // 这里再乘一次就等于乘了两遍（放大后页面比画布大、文字挤在左上角）。
      const css = p.getViewport({ scale });
      const base = p.getViewport({ scale: 1 });
      onSize(index, Math.round(base.width), Math.round(base.height));
      tl.replaceChildren();
      tl.style.width = `${css.width}px`;
      tl.style.height = `${css.height}px`;
      tl.style.setProperty("--total-scale-factor", String(scale));
      const pdfjs = await loadPdfjs();
      if (!alive) return;
      const textLayer = new pdfjs.TextLayer({
        textContentSource: p.streamTextContent(),
        container: tl,
        viewport: css,
      });
      layer = textLayer;
      textLayer.render().catch(() => {});
      setDrawn(true);
    })();
    return () => {
      alive = false;
      render?.cancel();
      layer?.cancel();
    };
  }, [near, doc, n, index, scale, onSize]);

  return (
    <div
      className="ws-pv-pdfpagebox"
      ref={(el) => {
        box.current = el;
        register.current[index] = el;
      }}
      style={{
        width: `${Math.round(size.w * scale)}px`,
        height: `${Math.round(size.h * scale)}px`,
      }}
    >
      {near && (
        <>
          <canvas ref={canvas} />
          <div ref={text} className="ws-pv-text" />
        </>
      )}
      {!drawn && (
        <span className="ws-pv-pdfpage-n t-mono" aria-hidden="true">
          {n}
        </span>
      )}
    </div>
  );
}

function OutlineTree({
  nodes,
  current,
  onPick,
  depth = 0,
}: {
  nodes: OutlineNode[];
  current: number;
  onPick(page: number): void;
  depth?: number;
}) {
  return (
    <ul className="ws-pv-pdfnav-list">
      {nodes.map((node, i) => {
        // 当前章节：本项页号 ≤ 当前页，且下一同级项的页号更大（或没有下一项）
        const next = nodes[i + 1]?.page ?? null;
        const active =
          node.page !== null &&
          node.page <= current &&
          (next === null || next > current);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 目录项标题可能重复，位置即身份
          <li key={`${node.title}-${i}`}>
            <Button
              variant="ghost"
              size="sm"
              className="ws-pv-pdfnav-item"
              data-active={active || undefined}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              disabled={node.page === null}
              onClick={() => node.page && onPick(node.page)}
            >
              {node.title}
            </Button>
            {node.children.length > 0 && (
              <OutlineTree
                nodes={node.children}
                current={current}
                onPick={onPick}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
