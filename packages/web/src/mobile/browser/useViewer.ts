// 浏览器画面查看器的手势：单指平移、双指缩放，按钮复位。只在查看器容器上接管触摸（CSS 里 touch-action: none），
// 位置与比例的算法在 viewTransform.ts（纯函数）。画面只读，点按不发给页面。
import {
  type PointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type Box,
  clampView,
  fitView,
  type Pt,
  panView,
  pinchView,
  type View,
  zoomTo,
} from "./viewTransform";

interface Gesture {
  view: View;
  from: Pt[];
}

export function useViewer(resetKey: string) {
  const el = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<Gesture | null>(null);

  // 容器尺寸：旋转屏幕、地址栏收起都会变
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const measure = () => setBox({ w: node.clientWidth, h: node.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // 容器第一次有尺寸、或换了页面：回到适应宽度；之后尺寸变了只保持比例、重新夹进容器
  const boxRef = useRef(box);
  boxRef.current = box;
  const ready = box !== null && box.w > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey 只用来触发复位
  useLayoutEffect(() => {
    if (ready && boxRef.current) setView(fitView(boxRef.current));
  }, [ready, resetKey]);
  useLayoutEffect(() => {
    if (box && box.w > 0)
      setView((v) => (v ? clampView(v, box) : fitView(box)));
  }, [box]);

  const local = (e: PointerEvent): Pt => {
    const r = el.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  // 手指数量变了（多一根、少一根）：以当前画面位置重新起算，免得画面跳一下
  const rebase = () => {
    const v = viewRef.current;
    gesture.current = v
      ? { view: v, from: [...pointers.current.values()] }
      : null;
  };

  const onPointerDown = (e: PointerEvent) => {
    el.current?.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    rebase();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !box || !gesture.current) return;
    pointers.current.set(e.pointerId, local(e));
    const now = [...pointers.current.values()];
    const { view: start, from } = gesture.current;
    const a = now[0];
    const a0 = from[0];
    const b = now[1];
    const b0 = from[1];
    if (a && a0 && b && b0) setView(pinchView(start, [a0, b0], [a, b], box));
    else if (a && a0) setView(panView(start, a.x - a0.x, a.y - a0.y, box));
  };
  const onPointerEnd = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    rebase();
  };

  const fit = useCallback(() => {
    if (box) setView(fitView(box));
  }, [box]);
  const actual = useCallback(() => {
    const v = viewRef.current;
    if (box && v) setView(zoomTo(v, 1, box));
  }, [box]);

  return {
    ref: el,
    view,
    fit,
    actual,
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
  };
}
