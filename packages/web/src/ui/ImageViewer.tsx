import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "./Button";
import {
  BackIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  RotateCwIcon,
} from "./icons";
import { Modal } from "./Modal";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

// 查看器需要的最小可用画面；窗口放不下时直接全屏，不硬塞一个小窗。
const MIN_VIEW_W = 900;
const MIN_VIEW_H = 600;
const fitsWindow = () =>
  window.innerWidth >= MIN_VIEW_W + 80 && window.innerHeight >= MIN_VIEW_H + 80;

export interface ImageViewerItem {
  id: string;
  name: string;
  src: string;
}

export interface ImageViewerProps {
  images: readonly ImageViewerItem[];
  index: number;
  onIndex(next: number): void;
  onClose(): void;
}

type Anchor = {
  /** 锚点在画布内的归一化坐标 */
  nx: number;
  ny: number;
  /** 锚点在视口中的位置；缩放后让这一点留在原处 */
  clientX: number;
  clientY: number;
};

/**
 * 单张 / 同批图片查看器：滚轮按鼠标位置缩放，放大后可拖拽平移，支持旋转、
 * 左右切换、重置和 1:1 原始像素。与聊天附件解耦，可复用到其他图片预览场景。
 */
export function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
}: ImageViewerProps) {
  const current = images[index];
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const zoomAnchor = useRef<Anchor | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(fitsWindow);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  const count = images.length;
  const prev = () => onIndex((index - 1 + count) % count);
  const next = () => onIndex((index + 1) % count);

  // 换图时回到适应窗口，避免上一张的缩放/旋转串到下一张。
  // biome-ignore lint/correctness/useExhaustiveDependencies: index 变化即重置，natural 不参与
  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setNatural(null);
    setFit(null);
  }, [index]);

  useEffect(() => {
    const onResize = () => setFullscreen(fitsWindow());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const anchorFrom = (clientX: number, clientY: number): Anchor | null => {
    const el = canvas.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      nx: (clientX - rect.left) / rect.width,
      ny: (clientY - rect.top) / rect.height,
      clientX,
      clientY,
    };
  };

  const anchorAtCenter = (): Anchor | null => {
    const el = stage.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return anchorFrom(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const zoomBy = (factor: number) => {
    zoomAnchor.current = anchorAtCenter();
    setZoom((z) => clampZoom(z * factor));
  };

  // 滚轮缩放；锚点取鼠标位置。放大后如果画面超出容器，按住拖动可以平移。
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.current?.getBoundingClientRect();
      zoomAnchor.current =
        rect && rect.width > 0 && rect.height > 0
          ? {
              nx: (e.clientX - rect.left) / rect.width,
              ny: (e.clientY - rect.top) / rect.height,
              clientX: e.clientX,
              clientY: e.clientY,
            }
          : null;
      const factor = Math.exp(-e.deltaY * 0.0015);
      setZoom((z) => clampZoom(z * factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 缩放后把锚点重新对回原位；scroll 容器够大时才会真正移动，图片小于容器时
  // 仍由 margin:auto 居中。
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom 变化后重算滚动位置，anchor 只读 ref
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const c = canvas.current;
    const s = stage.current;
    if (!a || !c || !s) return;
    zoomAnchor.current = null;
    const rect = c.getBoundingClientRect();
    s.scrollLeft += rect.left + a.nx * rect.width - a.clientX;
    s.scrollTop += rect.top + a.ny * rect.height - a.clientY;
  }, [zoom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(1.25);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomBy(1 / 1.25);
      } else if (e.key === "0") {
        e.preventDefault();
        zoomAnchor.current = null;
        setZoom(1);
        setRotation(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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

  const reset = () => {
    zoomAnchor.current = null;
    setZoom(1);
    setRotation(0);
  };

  const actualSize = () => {
    if (!fit || !natural || fit.w <= 0) return;
    zoomAnchor.current = anchorAtCenter();
    setZoom(clampZoom(natural.w / fit.w));
  };

  if (!current) return null;
  const rotated = Math.abs(rotation % 180) === 90;
  const box = fit
    ? {
        w: (rotated ? fit.h : fit.w) * zoom,
        h: (rotated ? fit.w : fit.h) * zoom,
      }
    : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${index + 1} / ${count} · ${current.name}`}
      size={fullscreen ? "full" : "xl"}
      className="u-iv-modal"
      footer={
        <div className="u-iv-bar">
          <div className="u-iv-group">
            <IconButton
              label="上一张"
              size="sm"
              icon={<BackIcon size={13} />}
              disabled={count < 2}
              onClick={prev}
            />
            <IconButton
              label="下一张"
              size="sm"
              icon={<ChevronRightIcon size={13} />}
              disabled={count < 2}
              onClick={next}
            />
          </div>
          <div className="u-iv-group">
            <IconButton
              label="逆时针旋转"
              size="sm"
              icon={<RotateCcwIcon size={13} />}
              onClick={() => setRotation((r) => r - 90)}
            />
            <IconButton
              label="顺时针旋转"
              size="sm"
              icon={<RotateCwIcon size={13} />}
              onClick={() => setRotation((r) => r + 90)}
            />
          </div>
          <div className="u-iv-group">
            <IconButton
              label="缩小"
              size="sm"
              icon={<MinusIcon size={12} />}
              onClick={() => zoomBy(1 / 1.25)}
            />
            <span className="u-iv-zoom t-mono" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <IconButton
              label="放大"
              size="sm"
              icon={<PlusIcon size={12} />}
              onClick={() => zoomBy(1.25)}
            />
          </div>
          <Button size="sm" onClick={reset}>
            重置
          </Button>
          <Button
            size="sm"
            onClick={actualSize}
            disabled={!natural}
            title="按原始像素显示；可配合滚轮查看细节"
          >
            1:1 原图
          </Button>
        </div>
      }
    >
      <div
        className={`u-iv-stage${panning ? " is-panning" : ""}`}
        ref={stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          ref={canvas}
          className="u-iv-canvas"
          style={box ? { width: box.w, height: box.h } : undefined}
        >
          <img
            ref={img}
            className="u-iv-img"
            src={current.src}
            alt={current.name}
            draggable={false}
            style={
              fit
                ? {
                    width: fit.w * zoom,
                    height: fit.h * zoom,
                    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                  }
                : undefined
            }
            onLoad={(e) => {
              const el = e.currentTarget;
              const naturalW = el.naturalWidth;
              const naturalH = el.naturalHeight;
              const rect = stage.current?.getBoundingClientRect();
              setNatural({ w: naturalW, h: naturalH });
              if (rect && rect.width > 0 && rect.height > 0) {
                const scale = Math.min(
                  rect.width / naturalW,
                  rect.height / naturalH,
                  1,
                );
                setFit({ w: naturalW * scale, h: naturalH * scale });
              }
            }}
          />
        </div>
      </div>
      {natural && (
        <p className="u-iv-meta t-aux">
          {natural.w} × {natural.h} px · 滚轮缩放 · 拖拽平移 · ←/→ 切换 · 0 重置
        </p>
      )}
    </Modal>
  );
}
