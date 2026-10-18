import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Registry } from "./registry";
import { dividers, layout } from "./tree";
import type { LayoutDoc, Rect } from "./types";

const UNIT: Rect = { x: 0, y: 0, w: 1, h: 1 };

// 所有 window 的 pane 平铺在这一层，按 paneId 做 key，DOM 顺序只随 panes 表的插入顺序，
// 不随布局树变化：移动、分割、切 window 都只改定位与可见性，不换父节点，实例不重挂载。
export function PaneLayer({
  doc,
  registry,
  focusedPaneId,
  onFocus,
  onConfig,
  subtitle,
  menu,
  dragHandle,
  onResize,
}: {
  doc: LayoutDoc;
  registry: Registry;
  focusedPaneId: string | null;
  onFocus(paneId: string): void;
  onConfig(paneId: string, config: unknown, configVersion?: number): void;
  subtitle?(paneId: string): string | null;
  menu?(paneId: string): React.ReactNode;
  dragHandle?(paneId: string): React.HTMLAttributes<HTMLElement>;
  // delta 是父节点比例的变化量（正数：线向右或向下）。
  onResize?(windowId: string, path: number[], index: number, delta: number): void;
}) {
  const rects = useMemo(() => {
    const all = new Map<string, { rect: Rect; windowId: string }>();
    for (const w of doc.windows)
      for (const [id, rect] of layout(w.tree, UNIT))
        all.set(id, { rect, windowId: w.id });
    return all;
  }, [doc.windows]);

  const ref = useRef<HTMLDivElement>(null);
  const [, setSize] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activeWindow = doc.windows.find((w) => w.id === doc.activeWindowId);
  const lines = useMemo(
    () => dividers(activeWindow?.tree ?? null, UNIT),
    [activeWindow?.tree],
  );
  const drag = useRef<{ x: number; y: number } | null>(null);

  // 像素位移换算成父节点比例；容器还没有尺寸时（如 jsdom）不动。
  const toRatio = (d: (typeof lines)[number], dx: number, dy: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return 0;
    const px = d.dir === "h" ? dx : dy;
    const total = (d.dir === "h" ? box.width * d.parent.w : box.height * d.parent.h);
    return total > 0 ? px / total : 0;
  };

  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden" data-pane-layer>
      {Object.entries(doc.panes).map(([id, entry]) => {
        const place = rects.get(id);
        const active = place?.windowId === doc.activeWindowId;
        const r = place?.rect ?? UNIT;
        const resolved = registry.resolve(entry);
        const type = registry.get(entry.type);
        const base = resolved ? resolved.type.displayName : "未知 pane";
        const sub = subtitle?.(id);
        const title = sub ? `${base} · ${sub}` : base;
        const Comp = resolved?.type.component;
        const focused = active && focusedPaneId === id;
        return (
          <section
            key={id}
            role="region"
            aria-label={title}
            data-pane-id={id}
            data-focused={focused}
            inert={!active || !place}
            onFocusCapture={() => onFocus(id)}
            onPointerDown={() => onFocus(id)}
            style={{
              position: "absolute",
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
              visibility: active && place ? "visible" : "hidden",
            }}
            className={`flex min-h-0 min-w-0 flex-col border bg-bg ${focused ? "border-ink outline outline-2 -outline-offset-2 outline-live" : "border-line"}`}
          >
            <header
              {...(dragHandle?.(id) ?? {})}
              className="flex items-center justify-between border-b border-line bg-panel px-3 py-1 text-xs font-semibold"
            >
              <span>{title}</span>
              {menu?.(id)}
            </header>
            <div className="min-h-0 flex-1 overflow-hidden">
              {Comp ? (
                <Comp
                  paneId={id}
                  config={resolved.config as never}
                  focused={focused}
                  onUpdateConfig={(c: never, v?: number) => onConfig(id, c, v ?? resolved.configVersion)}
                />
              ) : (
                <p className="p-4 text-mute">
                  未知 pane{type ? "（配置版本较新）" : `（${entry.type}）`}，配置已保留
                </p>
              )}
            </div>
          </section>
        );
      })}
      {activeWindow &&
        onResize &&
        lines.map((d) => {
          const vertical = d.dir === "h";
          const key = `${d.path.join(".")}/${d.index}`;
          const step = (delta: number) => onResize(activeWindow.id, d.path, d.index, delta);
          return (
            <div
              key={key}
              role="separator"
              tabIndex={0}
              aria-orientation={vertical ? "vertical" : "horizontal"}
              aria-valuenow={Math.round(d.ratio * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="调整 pane 大小"
              data-divider={key}
              style={{
                position: "absolute",
                left: `${d.rect.x * 100}%`,
                top: `${d.rect.y * 100}%`,
                ...(vertical
                  ? { height: `${d.rect.h * 100}%`, width: 8, marginLeft: -4, cursor: "col-resize" }
                  : { width: `${d.rect.w * 100}%`, height: 8, marginTop: -4, cursor: "row-resize" }),
                touchAction: "none",
              }}
              className="z-10 bg-transparent hover:bg-live/40 focus-visible:bg-live/60"
              onKeyDown={(e) => {
                const back = vertical ? "ArrowLeft" : "ArrowUp";
                const fwd = vertical ? "ArrowRight" : "ArrowDown";
                if (e.key === back) step(-0.02);
                else if (e.key === fwd) step(0.02);
                else return;
                e.preventDefault();
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY };
              }}
              onPointerMove={(e) => {
                const from = drag.current;
                if (!from) return;
                const delta = toRatio(d, e.clientX - from.x, e.clientY - from.y);
                drag.current = { x: e.clientX, y: e.clientY };
                if (delta !== 0) step(delta);
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
            />
          );
        })}
    </div>
  );
}
