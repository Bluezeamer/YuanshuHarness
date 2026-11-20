// mermaid 大画布：把卡片里已经渲染好的同一个 <svg> 节点搬进弹层，不重新渲染、不复制 id。
// 缩放/平移沿用图片查看器的交互习惯：滚轮锚点缩放、拖拽平移、适应窗口、1:1。
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, Modal } from "../../ui";
import { copyText } from "../../ui/clipboard";
import { cx } from "../../ui/cx";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
const FIT_GAP = 24;

export function DiagramCanvas({
  hostRef,
  code,
  onClose,
}: {
  /** 卡片里承载 SVG 的容器；关闭时把同一个节点搬回去 */
  hostRef: React.RefObject<HTMLDivElement | null>;
  code: string;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const natural = useRef<{ w: number; h: number } | null>(null);
  const anchor = useRef<{
    nx: number;
    ny: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const pan = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [view, setView] = useState<"preview" | "source">("preview");
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [copied, setCopied] = useState(false);

  const fit = useCallback(() => {
    const el = stage.current;
    const size = natural.current;
    if (!el || !size) return;
    const w = Math.max(1, el.clientWidth - FIT_GAP);
    const h = Math.max(1, el.clientHeight - FIT_GAP);
    setZoom(clampZoom(Math.min(w / size.w, h / size.h, 1)));
    anchor.current = null;
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }, []);

  // 进入预览时把卡片里的 SVG 节点搬进来；切到源码/关闭时搬回去。
  useEffect(() => {
    const host = hostRef.current;
    const el = stage.current;
    if (view !== "preview" || !host || !el) return;
    const svg = host.querySelector("svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") ?? "")
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    natural.current = {
      w: vb[2] || svg.clientWidth || 800,
      h: vb[3] || svg.clientHeight || 600,
    };
    svg.removeAttribute("style");
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    el.appendChild(svg);
    const raf = requestAnimationFrame(fit);
    return () => {
      cancelAnimationFrame(raf);
      host.appendChild(svg);
    };
  }, [view, hostRef, fit]);

  // 缩放通过改写 SVG 的像素尺寸实现，矢量图不会糊。
  useLayoutEffect(() => {
    const svg = stage.current?.querySelector("svg") ?? null;
    const size = natural.current;
    if (!svg || !size) return;
    svg.style.width = `${Math.round(size.w * zoom)}px`;
    svg.style.height = `${Math.round(size.h * zoom)}px`;
    const a = anchor.current;
    const el = stage.current;
    anchor.current = null;
    if (!a || !el) return;
    const rect = svg.getBoundingClientRect();
    el.scrollLeft += rect.left + a.nx * rect.width - a.clientX;
    el.scrollTop += rect.top + a.ny * rect.height - a.clientY;
  }, [zoom]);

  const zoomBy = (factor: number) => {
    const el = stage.current;
    const svg = el?.querySelector("svg") ?? null;
    if (!el || !svg) {
      setZoom((z) => clampZoom(z * factor));
      return;
    }
    const rect = svg.getBoundingClientRect();
    const cx = el.getBoundingClientRect();
    const clientX = cx.left + cx.width / 2;
    const clientY = cx.top + cx.height / 2;
    anchor.current = {
      nx: (clientX - rect.left) / rect.width,
      ny: (clientY - rect.top) / rect.height,
      clientX,
      clientY,
    };
    setZoom((z) => clampZoom(z * factor));
  };

  useEffect(() => {
    const el = stage.current;
    if (!el || view !== "preview") return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const svg = el.querySelector("svg");
      if (svg) {
        const rect = svg.getBoundingClientRect();
        anchor.current = {
          nx: (e.clientX - rect.left) / rect.width,
          ny: (e.clientY - rect.top) / rect.height,
          clientX: e.clientX,
          clientY: e.clientY,
        };
      }
      setZoom((z) => clampZoom(z * Math.exp(-e.deltaY * 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = stage.current;
    if (!el) return;
    pan.current = {
      x: e.clientX,
      y: e.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
    };
    el.setPointerCapture(e.pointerId);
    setPanning(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = stage.current;
    const p = pan.current;
    if (!el || !p) return;
    el.scrollLeft = p.left - (e.clientX - p.x);
    el.scrollTop = p.top - (e.clientY - p.y);
  };
  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = stage.current;
    if (el?.hasPointerCapture(e.pointerId))
      el.releasePointerCapture(e.pointerId);
    pan.current = null;
    setPanning(false);
  };

  const copy = async () => {
    if (!(await copyText(code))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Mermaid 图表"
      description={
        view === "preview"
          ? "滚轮缩放 · 拖拽平移 · Esc 关闭"
          : "源码视图，可一键复制"
      }
      size="full"
      className="md-canvas-modal"
      footer={
        <div className="md-canvas-bar">
          <div className="md-canvas-group">
            <Button
              size="sm"
              onClick={() =>
                setView((v) => (v === "preview" ? "source" : "preview"))
              }
            >
              {view === "preview" ? "查看源码" : "返回预览"}
            </Button>
            <Button size="sm" onClick={() => void copy()}>
              {copied ? "已复制" : "复制源码"}
            </Button>
          </div>
          {view === "preview" && (
            <div className="md-canvas-group">
              <Button
                size="sm"
                onClick={() => zoomBy(1 / 1.25)}
                disabled={zoom <= MIN_ZOOM}
              >
                缩小
              </Button>
              <span className="md-canvas-zoom t-mono" aria-live="polite">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                size="sm"
                onClick={() => zoomBy(1.25)}
                disabled={zoom >= MAX_ZOOM}
              >
                放大
              </Button>
              <Button size="sm" onClick={fit}>
                适应
              </Button>
              <Button size="sm" onClick={() => setZoom(1)}>
                1:1
              </Button>
            </div>
          )}
        </div>
      }
    >
      {view === "preview" ? (
        <div
          className={cx("md-canvas-stage", panning && "is-panning")}
          ref={stage}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        />
      ) : (
        <pre className="md-canvas-src t-code">{code}</pre>
      )}
    </Modal>
  );
}
