import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Registry } from "./registry";
import { dividers, layout, tabGroups } from "./tree";
import type { LayoutDoc, PaneBinding, Rect } from "./types";

const UNIT: Rect = { x: 0, y: 0, w: 1, h: 1 };
const FOLLOW: PaneBinding = { mode: "follow" };
// tab 栏高度；tab 组里的 pane 在它下面。
const TAB_H = 30;

interface Place {
  rect: Rect;
  windowId: string;
  tabbed: boolean;
  shown: boolean;
}

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
  onSelectTab,
  onCloseTab,
  onRename,
  onResize,
}: {
  doc: LayoutDoc;
  registry: Registry;
  focusedPaneId: string | null;
  onFocus(paneId: string): void;
  onConfig(
    paneId: string,
    config: unknown,
    configVersion?: number,
    binding?: PaneBinding,
  ): void;
  subtitle?(paneId: string): string | null;
  menu?(paneId: string): React.ReactNode;
  dragHandle?(paneId: string): React.HTMLAttributes<HTMLElement>;
  onSelectTab?(paneId: string): void;
  onCloseTab?(paneId: string): void;
  onRename?(paneId: string): void;
  // delta 是父节点比例的变化量（正数：线向右或向下）。
  onResize?(
    windowId: string,
    path: number[],
    index: number,
    delta: number,
  ): void;
}) {
  // 未被选中的 tab 与选中项共用同一个矩形，只是不可见：它们仍挂载在这一层，实例不重建。
  const { rects, groups } = useMemo(() => {
    const all = new Map<string, Place>();
    const gs: (ReturnType<typeof tabGroups>[number] & { windowId: string })[] =
      [];
    for (const w of doc.windows) {
      for (const [id, rect] of layout(w.tree, UNIT))
        all.set(id, { rect, windowId: w.id, tabbed: false, shown: true });
      for (const g of tabGroups(w.tree, UNIT)) {
        gs.push({ ...g, windowId: w.id });
        for (const id of g.tabs)
          all.set(id, {
            rect: g.rect,
            windowId: w.id,
            tabbed: true,
            shown: id === g.selected,
          });
      }
    }
    return { rects: all, groups: gs };
  }, [doc.windows]);

  const titleOf = (id: string) => {
    const entry = doc.panes[id];
    const resolved = entry ? registry.resolve(entry) : null;
    if (entry?.name) return entry.name;
    const base = resolved ? resolved.type.displayName : "未知 pane";
    const sub = subtitle?.(id);
    return sub ? `${base} · ${sub}` : base;
  };

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
    const total =
      d.dir === "h" ? box.width * d.parent.w : box.height * d.parent.h;
    return total > 0 ? px / total : 0;
  };

  return (
    <div
      ref={ref}
      className="relative min-h-0 flex-1 overflow-hidden"
      data-pane-layer
    >
      {Object.entries(doc.panes).map(([id, entry]) => {
        const place = rects.get(id);
        const active = place?.windowId === doc.activeWindowId;
        const r = place?.rect ?? UNIT;
        const resolved = registry.resolve(entry);
        const type = registry.get(entry.type);
        const title = titleOf(id);
        const shown = !!place?.shown;
        const Comp = resolved?.type.component;
        const focused = active && shown && focusedPaneId === id;
        return (
          <section
            key={id}
            aria-label={title}
            data-pane-id={id}
            data-focused={focused}
            tabIndex={-1}
            inert={!active || !place || !shown}
            onFocusCapture={() => onFocus(id)}
            onPointerDown={() => onFocus(id)}
            style={{
              position: "absolute",
              left: `${r.x * 100}%`,
              top: place?.tabbed
                ? `calc(${r.y * 100}% + ${TAB_H}px)`
                : `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: place?.tabbed
                ? `calc(${r.h * 100}% - ${TAB_H}px)`
                : `${r.h * 100}%`,
              visibility: active && place && shown ? "visible" : "hidden",
            }}
            className={`flex min-h-0 min-w-0 flex-col border bg-bg ${focused ? "border-ink outline outline-2 -outline-offset-2 outline-accent" : "border-line"}`}
          >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: 双击改名是鼠标快捷方式 */}
            <header
              {...(dragHandle?.(id) ?? {})}
              // 标题栏按下时已 setPointerCapture，浏览器会把 dblclick 派给 header 而不是里面的 span，所以监听放在这里。
              onDoubleClick={(e) => {
                if (!(e.target as HTMLElement).closest("button,select,input"))
                  onRename?.(id);
              }}
              className="flex items-center justify-between border-b border-line bg-panel px-3 py-1 text-xs font-semibold"
            >
              <span
                className={`border border-line px-2 py-0.5 ${place?.tabbed ? "border-transparent" : "border-b-2 border-b-ink bg-bg"}`}
              >
                {title}
              </span>
              {menu?.(id)}
            </header>
            <div className="min-h-0 flex-1 overflow-hidden">
              {Comp ? (
                <Comp
                  paneId={id}
                  config={resolved.config as never}
                  focused={focused}
                  binding={entry.binding ?? FOLLOW}
                  onUpdateConfig={(c: never, v?: number, b?: PaneBinding) =>
                    onConfig(id, c, v ?? resolved.configVersion, b)
                  }
                />
              ) : (
                <p className="p-4 text-mute">
                  未知 pane{type ? "（配置版本较新）" : `（${entry.type}）`}
                  ，配置已保留
                </p>
              )}
            </div>
          </section>
        );
      })}
      {groups
        .filter((g) => g.windowId === doc.activeWindowId)
        .map((g) => (
          <div
            key={g.tabs[0]}
            role="tablist"
            aria-label="pane 标签"
            data-tabstrip={g.selected}
            style={{
              position: "absolute",
              left: `${g.rect.x * 100}%`,
              top: `${g.rect.y * 100}%`,
              width: `${g.rect.w * 100}%`,
              height: TAB_H,
            }}
            className="flex items-stretch overflow-hidden border border-b-0 border-line bg-panel text-xs"
          >
            {g.tabs.map((id, i) => {
              const sel = id === g.selected;
              const t = titleOf(id);
              return (
                <span
                  key={id}
                  className={`flex min-w-0 items-center border-r border-line ${sel ? "bg-bg font-semibold" : "text-mute"}`}
                >
                  <div
                    {...(dragHandle?.(id) ?? {})}
                    role="tab"
                    data-tab-id={id}
                    aria-selected={sel}
                    tabIndex={sel ? 0 : -1}
                    onClick={() => onSelectTab?.(id)}
                    onDoubleClick={() => onRename?.(id)}
                    onKeyDown={(e) => {
                      const step =
                        e.key === "ArrowRight"
                          ? 1
                          : e.key === "ArrowLeft"
                            ? -1
                            : 0;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectTab?.(id);
                      } else if (step) {
                        e.preventDefault();
                        const next =
                          g.tabs[(i + step + g.tabs.length) % g.tabs.length];
                        if (next) onSelectTab?.(next);
                      }
                    }}
                    className="truncate px-3 py-1.5"
                  >
                    {t}
                  </div>
                  <button
                    type="button"
                    aria-label={`关闭 ${t}`}
                    className="px-1.5 text-mute hover:text-ink"
                    onClick={() => onCloseTab?.(id)}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      {activeWindow &&
        onResize &&
        lines.map((d) => {
          const vertical = d.dir === "h";
          const key = `${d.path.join(".")}/${d.index}`;
          const step = (delta: number) =>
            onResize(activeWindow.id, d.path, d.index, delta);
          return (
            // biome-ignore lint/a11y/useSemanticElements: 可聚焦、可拖动的 window splitter，<hr> 不带 aria-valuenow 与键盘交互
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
                  ? {
                      height: `${d.rect.h * 100}%`,
                      width: 8,
                      marginLeft: -4,
                      cursor: "col-resize",
                    }
                  : {
                      width: `${d.rect.w * 100}%`,
                      height: 8,
                      marginTop: -4,
                      cursor: "row-resize",
                    }),
                touchAction: "none",
              }}
              className="z-10 bg-transparent hover:bg-accent/40 focus-visible:bg-accent/60"
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
                const delta = toRatio(
                  d,
                  e.clientX - from.x,
                  e.clientY - from.y,
                );
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
