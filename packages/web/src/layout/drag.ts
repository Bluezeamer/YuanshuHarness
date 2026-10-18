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
  | { kind: "window"; windowId: string; preview: PreviewRect }
  | null;

const EDGE = 0.2;

const box = (r: DOMRect): PreviewRect => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
});

// R5：由指针位置判断落点。先看 window 标签，再看当前 window 内其他 pane 的四条边（各 20%）。
// 用矩形而不是 elementAtPoint：拖动时 iframe 会吞事件，矩形判断不受影响。
export function dropTarget(
  x: number,
  y: number,
  dragging: string,
  candidates: string[],
  activeWindowId: string,
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
  for (const paneId of candidates) {
    if (paneId === dragging) continue;
    const el = document.querySelector(`[data-pane-id="${paneId}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const dx = (x - r.left) / r.width;
    const dy = (y - r.top) / r.height;
    const edge = (
      dir: "h" | "v",
      before: boolean,
      p: PreviewRect,
    ): DropTarget => ({
      kind: "edge",
      paneId,
      dir,
      before,
      preview: p,
    });
    const hw = r.width / 2;
    const hh = r.height / 2;
    if (dx < EDGE)
      return edge("h", true, {
        left: r.left,
        top: r.top,
        width: hw,
        height: r.height,
      });
    if (dx > 1 - EDGE)
      return edge("h", false, {
        left: r.left + hw,
        top: r.top,
        width: hw,
        height: r.height,
      });
    if (dy < EDGE)
      return edge("v", true, {
        left: r.left,
        top: r.top,
        width: r.width,
        height: hh,
      });
    if (dy > 1 - EDGE)
      return edge("v", false, {
        left: r.left,
        top: r.top + hh,
        width: r.width,
        height: hh,
      });
  }
  return null;
}
