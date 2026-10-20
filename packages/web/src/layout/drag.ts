export interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type DropTarget =
  | {
      kind: "edge";
      paneId: string;
      dir: "h" | "v";
      before: boolean;
      preview: PreviewRect;
    }
  // R9a：标题栏 / 中心 30% 且类型相同、tabbed：并入目标的 tab 组。
  | { kind: "tab"; paneId: string; preview: PreviewRect }
  // 标题栏 / 中心 30% 其余情况：两个面板互换位置。
  | { kind: "swap"; paneId: string; preview: PreviewRect }
  | { kind: "window"; windowId: string; preview: PreviewRect }
  | null;

// 与 mock 的 dropZone 同一几何：中心 30%×30% 为 center，其余按偏离中心更远的轴取四向（即四边各 35%）。
export type Zone = "center" | "left" | "right" | "top" | "bottom";
export function dropZone(x: number, y: number, w: number, h: number): Zone {
  if (!w || !h) return "center";
  const px = (x / w - 0.5) * 2;
  const py = (y / h - 0.5) * 2;
  if (Math.abs(px) <= 0.3 && Math.abs(py) <= 0.3) return "center";
  if (Math.abs(px) >= Math.abs(py)) return px < 0 ? "left" : "right";
  return py < 0 ? "top" : "bottom";
}

const box = (r: DOMRect): PreviewRect => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
});

// R5：由指针位置判断落点。先看 window 标签，再看 tab 栏与标题栏（并入 tab 或交换），再看当前 window 内其他 pane 的方位分区。
// 用矩形而不是 elementAtPoint：拖动时 iframe 会吞事件，矩形判断不受影响。
// canMerge(paneId)：被拖的 pane 能否并入 paneId 的 tab 组（同类型且 tabbed）。
export function dropTarget(
  x: number,
  y: number,
  dragging: string,
  candidates: string[],
  activeWindowId: string,
  canMerge: (paneId: string) => boolean,
): DropTarget {
  for (const tab of document.querySelectorAll('[role="tab"][data-window-id]')) {
    const r = tab.getBoundingClientRect();
    const id = tab.getAttribute("data-window-id");
    if (
      id &&
      id !== activeWindowId &&
      x >= r.left &&
      x <= r.right &&
      y >= r.top &&
      y <= r.bottom
    )
      return { kind: "window", windowId: id, preview: box(r) };
  }
  const center = (paneId: string, p: PreviewRect): DropTarget =>
    canMerge(paneId)
      ? { kind: "tab", paneId, preview: p }
      : { kind: "swap", paneId, preview: p };
  for (const strip of document.querySelectorAll("[data-tabstrip]")) {
    const r = strip.getBoundingClientRect();
    const id = strip.getAttribute("data-tabstrip");
    if (id && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
      return center(id, box(r));
  }
  for (const paneId of candidates) {
    if (paneId === dragging) continue;
    const el = document.querySelector(`[data-pane-id="${paneId}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const head = el.querySelector("header")?.getBoundingClientRect();
    const zone =
      head && y >= head.top && y <= head.bottom
        ? "center"
        : dropZone(x - r.left, y - r.top, r.width, r.height);
    const hw = r.width / 2;
    const hh = r.height / 2;
    const edge = (
      dir: "h" | "v",
      before: boolean,
      p: PreviewRect,
    ): DropTarget => ({ kind: "edge", paneId, dir, before, preview: p });
    switch (zone) {
      case "center":
        return center(paneId, box(r));
      case "left":
        return edge("h", true, { ...box(r), width: hw });
      case "right":
        return edge("h", false, { ...box(r), left: r.left + hw, width: hw });
      case "top":
        return edge("v", true, { ...box(r), height: hh });
      case "bottom":
        return edge("v", false, { ...box(r), top: r.top + hh, height: hh });
    }
  }
  return null;
}
