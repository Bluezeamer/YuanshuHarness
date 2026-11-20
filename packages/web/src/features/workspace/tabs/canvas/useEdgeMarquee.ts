// 框选时与框相交的连线也被选中（xyflow 自带的框选只顺带选中连在被选卡片上的线）。
import { type Edge, useReactFlow, useStore } from "@xyflow/react";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
} from "react";
import type { FlowNode } from "./model";

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// 沿连线每隔这么多像素取一个点；框比这个小得多时才会漏
const STEP = 8;

/** 这条线（屏幕坐标下）有没有点落在框里 */
function pathHits(path: SVGPathElement, r: Rect): boolean {
  const ctm = path.getScreenCTM();
  if (!ctm) return false;
  const total = path.getTotalLength();
  // 取样间隔按屏幕像素算：先量出一单位路径长度对应多少屏幕像素
  const p0 = path.getPointAtLength(0);
  const p1 = path.getPointAtLength(Math.min(1, total));
  const unit =
    Math.hypot(
      (p1.x - p0.x) * ctm.a + (p1.y - p0.y) * ctm.c,
      (p1.x - p0.x) * ctm.b + (p1.y - p0.y) * ctm.d,
    ) || 1;
  const stride = Math.max(1, STEP / unit);
  for (let len = 0; len <= total + stride; len += stride) {
    const p = path.getPointAtLength(Math.min(len, total));
    const x = p.x * ctm.a + p.y * ctm.c + ctm.e;
    const y = p.x * ctm.b + p.y * ctm.d + ctm.f;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}

export function useEdgeMarquee(
  host: RefObject<HTMLElement | null>,
  nodes: readonly FlowNode[],
  setEdges: Dispatch<SetStateAction<Edge[]>>,
): void {
  const rf = useReactFlow();
  const rect = useStore((s) => s.userSelectionRect);
  // nodes 在依赖里：框扫过卡片时被选中的卡片变了，连在它们上面的线也要跟着变
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodes 只用来触发重算
  useEffect(() => {
    const el = host.current;
    if (!rect || !el) return;
    const box = el.getBoundingClientRect();
    const r: Rect = {
      left: box.left + rect.x,
      top: box.top + rect.y,
      right: box.left + rect.x + rect.width,
      bottom: box.top + rect.y + rect.height,
    };
    const crossed = new Set<string>();
    // 感应层那条路径与看得见的线同形状（看得见的画在卡片之上的另一层里）
    for (const path of el.querySelectorAll<SVGPathElement>(
      ".react-flow__edge-interaction",
    )) {
      const id = path.closest(".react-flow__edge")?.getAttribute("data-id");
      if (id && pathHits(path, r)) crossed.add(id);
    }
    const picked = new Set(
      rf
        .getNodes()
        .filter((n) => n.selected)
        .map((n) => n.id),
    );
    setEdges((es) =>
      es.map((e) => {
        const want =
          crossed.has(e.id) || picked.has(e.source) || picked.has(e.target);
        return !!e.selected === want ? e : { ...e, selected: want };
      }),
    );
  }, [rect, nodes, host, rf, setEdges]);
}
