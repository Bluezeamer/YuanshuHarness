import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Anchor } from "../ChatView";
import type { SessionInfo } from "../api";
import type { SessionHub } from "../sessions/hub";
import {
  addPane,
  addWindow,
  closePane,
  closeWindow,
  DOC_VERSION,
  instantiate,
  movePane,
  newId,
  renameWindow,
  selectWindow,
  setTree,
  setPaneConfig,
  windowOf,
} from "./doc";
import { type DropTarget, dropTarget } from "./drag";
import { PaneLayer } from "./PaneLayer";
import { SavedLayouts } from "./SavedLayouts";
import { type ChatConfig, defaultRegistry, EnvContext } from "./panes";
import { layout, neighbor, paneIds, resize } from "./tree";
import { LEFT_MIN_WIDTH, RIGHT_MIN_WIDTH, useSide, useWidth } from "./useSide";
import { useWorkbench } from "./useWorkbench";

function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      role="img"
      aria-label={running ? "运行中" : "空闲"}
      className={`size-2 rounded-full ${running ? "dot-run bg-live" : "bg-ok"}`}
    />
  );
}

const btn =
  "border border-line px-2 py-0.5 text-xs font-semibold hover:bg-ink hover:text-bg";

export const PANE_SOFT_LIMIT = 12;
const NAV_MAX = 24;

export function Workbench({
  hub,
  sessions,
  onUnauthorized,
}: {
  hub: SessionHub;
  sessions: SessionInfo[];
  onUnauthorized: () => void;
}) {
  const registry = useMemo(defaultRegistry, []);
  const wb = useWorkbench(registry, onUnauthorized);
  const { doc, update } = wb;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const width = useWidth(root);
  const left = useSide("left", LEFT_MIN_WIDTH, width);
  const right = useSide("right", RIGHT_MIN_WIDTH, width);
  const [focus, setFocus] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<Record<string, Anchor[]>>({});
  const reportAnchors = useCallback((paneId: string, a: Anchor[]) => {
    setAnchors((prev) => {
      const old = prev[paneId];
      const same =
        old?.length === a.length &&
        old.every((x, i) => x.id === a[i]?.id && x.text === a[i]?.text);
      return same ? prev : { ...prev, [paneId]: a };
    });
  }, []);
  const env = useMemo(
    () => ({ hub, sessions, reportAnchors }),
    [hub, sessions, reportAnchors],
  );

  const active = doc.windows.find((w) => w.id === doc.activeWindowId);
  const inActive = paneIds(active?.tree ?? null);
  const focused =
    focus && inActive.includes(focus) ? focus : (inActive[0] ?? null);
  const sessionOf = (paneId: string | null) => {
    const e = paneId ? doc.panes[paneId] : undefined;
    return e?.type === "chat" ? (e.config as ChatConfig).sessionId : null;
  };
  const selected = sessionOf(focused);
  const lastChat = useRef<string | null>(null);
  if (focused && doc.panes[focused]?.type === "chat") lastChat.current = focused;

  // R24：pane 总数达到软上限时提示，不阻止。
  const [crowded, setCrowded] = useState(false);
  const warnIfCrowded = () => setCrowded(Object.keys(doc.panes).length >= PANE_SOFT_LIMIT);

  // R6：Alt+方向键按位置移动焦点。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.altKey || !focused) return;
    const dir = (
      { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const
    )[e.key as "ArrowLeft"];
    if (!dir) return;
    const rects = layout(active?.tree ?? null, { x: 0, y: 0, w: 1, h: 1 });
    const next = neighbor(rects, focused, dir);
    e.preventDefault();
    if (next) setFocus(next);
  };

  // R5：pointer 事件拖动。移动超过 4px 才算拖动，避免吞掉标题栏按钮的点击。
  const [pending, setPending] = useState<{ paneId: string; x: number; y: number } | null>(null);
  const [dragTarget, setDragTarget] = useState<DropTarget>(null);
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ doc, inActive });
  latest.current = { doc, inActive };

  useEffect(() => {
    if (!pending) return;
    let started = false;
    let target: DropTarget = null;
    const end = () => {
      setPending(null);
      setDragging(false);
      setDragTarget(null);
    };
    const onMove = (e: PointerEvent) => {
      if (!started && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 4) return;
      started = true;
      setDragging(true);
      target = dropTarget(
        e.clientX,
        e.clientY,
        pending.paneId,
        latest.current.inActive,
        latest.current.doc.activeWindowId,
      );
      setDragTarget(target);
    };
    const onUp = () => {
      const t = target;
      const id = pending.paneId;
      end();
      if (!started || !t) return;
      if (t.kind === "window") update((d) => movePane(d, id, t.windowId));
      else
        update((d) => {
          const w = windowOf(d, t.paneId);
          return w ? movePane(d, id, w.id, { target: t.paneId, dir: t.dir, before: t.before }) : d;
        });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [pending, update]);

  const dragHandle = (paneId: string): React.HTMLAttributes<HTMLElement> => ({
    onPointerDown: (e) => {
      if ((e.target as HTMLElement).closest("button,select,input")) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setPending({ paneId, x: e.clientX, y: e.clientY });
    },
    style: { cursor: "grab", touchAction: "none" },
  });

  const newChat = (windowId: string, at?: Parameters<typeof addPane>[4]) => {
    const entry = registry.newEntry("chat");
    if (!entry) return null;
    warnIfCrowded();
    const id = newId("p");
    update((d) => addPane(d, windowId, id, entry, at));
    return id;
  };

  // R10：绑定到焦点 chat pane；焦点不是 chat 则找本 window 内的 chat pane，没有就新建。
  const choose = (sessionId: string) => {
    left.close();
    if (!active) return;
    const isChat = (id: string) => doc.panes[id]?.type === "chat";
    const recent = lastChat.current;
    const target =
      (focused && isChat(focused) ? focused : null) ??
      (recent && inActive.includes(recent) && isChat(recent) ? recent : null) ??
      inActive.find(isChat);
    if (!target) {
      const entry = registry.newEntry("chat");
      if (!entry) return;
      warnIfCrowded();
      const id = newId("p");
      update((d) =>
        addPane(d, active.id, id, { ...entry, config: { sessionId } }),
      );
      setFocus(id);
      return;
    }
    update((d) => setPaneConfig(d, target, { sessionId }));
    setFocus(target);
  };

  const split = (paneId: string, dir: "h" | "v") => {
    const w = windowOf(doc, paneId);
    if (!w) return;
    const id = newChat(w.id, { target: paneId, dir });
    if (id) setFocus(id);
  };

  const menu = (paneId: string) => (
    <span className="flex items-center gap-1">
      <button type="button" className={btn} onClick={() => split(paneId, "h")}>
        向右分割
      </button>
      <button type="button" className={btn} onClick={() => split(paneId, "v")}>
        向下分割
      </button>
      {doc.windows.length > 1 && (
        <select
          aria-label="移动到其他 window"
          value=""
          className="border border-line bg-bg text-xs"
          onChange={(e) => {
            const to = e.target.value;
            if (to) update((d) => movePane(d, paneId, to));
          }}
        >
          <option value="">移动到…</option>
          {doc.windows
            .filter((w) => !paneIds(w.tree).includes(paneId))
            .map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
        </select>
      )}
      <button
        type="button"
        className={btn}
        onClick={() => update((d) => closePane(d, paneId))}
      >
        关闭
      </button>
    </span>
  );

  const navPane = focused && doc.panes[focused]?.type === "chat" ? focused : null;
  const navItems = navPane ? (anchors[navPane] ?? []) : [];
  const jump = (id: string) => {
    const root = document.querySelector(`[data-pane-id="${navPane}"]`);
    const el = [...(root?.querySelectorAll("[data-anchor]") ?? [])].find(
      (n) => n.getAttribute("data-anchor") === id,
    );
    el?.scrollIntoView?.({ block: "start" });
  };

  return (
    <div
      ref={setRoot}
      style={{
        gridTemplateColumns: `${left.pinned ? "268px" : "0px"} minmax(0,1fr) ${right.pinned ? "200px" : "0px"}`,
      }}
      className="enter relative grid min-h-0"
    >
      {(left.pinned || left.open) && (
      <aside
        aria-label="会话列表"
        className={`col-start-1 row-start-1 min-h-0 overflow-auto border-r border-line bg-panel ${
          left.open ? "absolute inset-y-0 left-0 z-20 w-[268px]" : ""
        }`}
      >
        <div className="flex justify-end border-b border-line2 p-1">
          {left.open ? (
            <button type="button" className={btn} onClick={left.pin}>
              固定会话列表
            </button>
          ) : (
            <button type="button" className={btn} onClick={left.collapse}>
              折叠会话列表
            </button>
          )}
        </div>
        {sessions.length === 0 ? (
          <p className="p-5 text-mute">还没有会话</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={s.id === selected ? "true" : undefined}
                  onClick={() => choose(s.id)}
                  className={`grid w-full grid-cols-[8px_1fr] items-center gap-3 border-b border-line2 px-5 py-3 text-left hover:bg-ink/5 ${
                    s.id === selected
                      ? "bg-ink/5 shadow-[inset_3px_0_0_var(--ink)]"
                      : ""
                  }`}
                >
                  <StatusDot running={s.running} />
                  <span className="truncate font-semibold">
                    {s.name ?? "未命名会话"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      )}
      <main
        className="col-start-2 row-start-1 flex min-h-0 flex-col"
        onKeyDown={onKeyDown}
      >
        <div
          role="tablist"
          aria-label="window"
          className="flex items-center gap-1 border-b border-line bg-panel px-3"
        >
          {!left.pinned && (
            <button
              type="button"
              className={btn}
              aria-expanded={left.open}
              onClick={left.toggleOpen}
            >
              {left.open ? "收起会话列表" : "展开会话列表"}
            </button>
          )}
          {doc.windows.map((w) => (
            <span key={w.id} className="flex items-center">
              <button
                type="button"
                role="tab"
                data-window-id={w.id}
                aria-selected={w.id === doc.activeWindowId}
                onClick={() => update((d) => selectWindow(d, w.id))}
                onDoubleClick={() => {
                  const name = window.prompt("window 名称", w.name)?.trim();
                  if (name) update((d) => renameWindow(d, w.id, name));
                }}
                className={`px-3 py-2 text-sm font-semibold ${w.id === doc.activeWindowId ? "border-b-2 border-ink" : "text-mute"}`}
              >
                {w.name}
              </button>
              {doc.windows.length > 1 && (
                <button
                  type="button"
                  aria-label={`关闭 ${w.name}`}
                  className="px-1 text-xs text-mute hover:text-ink"
                  onClick={() => update((d) => closeWindow(d, w.id))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          <button
            type="button"
            aria-label="新建 window"
            className={btn}
            onClick={() => update(addWindow)}
          >
            +
          </button>
          <SavedLayouts
            currentVersion={DOC_VERSION}
            snapshot={() => {
              if (!active) return null;
              const panes = Object.fromEntries(
                paneIds(active.tree).flatMap((id) =>
                  doc.panes[id] ? [[id, doc.panes[id]]] : [],
                ),
              );
              return { name: active.name, tree: active.tree, panes };
            }}
            onApply={(sv) => update((d) => instantiate(d, sv))}
            onUnauthorized={onUnauthorized}
          />
          {!right.pinned && (
            <button
              type="button"
              className={`${btn} ml-auto`}
              aria-expanded={right.open}
              onClick={right.toggleOpen}
            >
              {right.open ? "收起输入导航" : "展开输入导航"}
            </button>
          )}
        </div>
        {wb.save.kind === "readonly" && (
          <p role="alert" className="p-2 text-sm text-acc">
            布局来自更新的版本，只读展示，不会保存
          </p>
        )}
        {wb.save.kind === "failed" && (
          <p role="alert" className="p-2 text-sm text-acc">
            布局保存失败，本地改动已保留
          </p>
        )}
        {wb.save.kind === "conflict" && (
          <p role="alert" className="flex gap-3 p-2 text-sm text-acc">
            布局已在别处修改
            <button type="button" className={btn} onClick={wb.adoptServer}>
              采用服务器版本
            </button>
            <button type="button" className={btn} onClick={wb.keepLocal}>
              以本地覆盖
            </button>
          </p>
        )}
        {crowded && (
          <p role="status" className="p-2 text-sm text-mute">
            pane 已有 {Object.keys(doc.panes).length} 个，都会常驻内存，可以关掉不用的
          </p>
        )}
        {wb.repaired && (
          <p className="p-2 text-sm text-mute">布局比例异常，已按等分修复</p>
        )}
        {active && !active.tree && (
          <div className="flex items-center gap-3 p-7 text-mute">
            空 window
            <button
              type="button"
              className={btn}
              onClick={() => newChat(active.id)}
            >
              新建 pane
            </button>
          </div>
        )}
        <EnvContext.Provider value={env}>
          <PaneLayer
            doc={doc}
            registry={registry}
            focusedPaneId={focused}
            onFocus={setFocus}
            onConfig={(id, c, v) => update((d) => setPaneConfig(d, id, c, v))}
            subtitle={(id) => {
              const sid = sessionOf(id);
              const s = sid ? sessions.find((x) => x.id === sid) : undefined;
              return s ? (s.name ?? "未命名会话") : null;
            }}
            menu={menu}
            dragHandle={dragHandle}
            onResize={(windowId, path, index, delta) =>
              update((d) => {
                const w = d.windows.find((x) => x.id === windowId);
                if (!w?.tree) return d;
                const next = resize(w.tree, path, index, delta);
                return next === w.tree ? d : setTree(d, windowId, next);
              })
            }
          />
        </EnvContext.Provider>
      </main>
      {dragging && (
        // 盖住整个页面，iframe 类 pane 不会在拖动时吞掉 pointer 事件。
        <div aria-hidden="true" className="fixed inset-0 z-30 cursor-grabbing">
          {dragTarget && (
            <div
              data-drop-preview={dragTarget.kind}
              style={dragTarget.preview}
              className="pointer-events-none fixed border-2 border-live bg-live/20"
            />
          )}
        </div>
      )}
      {(right.pinned || right.open) && (
      <nav
        aria-label="输入导航"
        className={`col-start-3 row-start-1 min-h-0 overflow-auto border-l border-line bg-panel ${
          right.open ? "absolute inset-y-0 right-0 z-20 w-[240px]" : ""
        }`}
      >
        <div className="flex justify-end border-b border-line2 p-1">
          {right.open ? (
            <button type="button" className={btn} onClick={right.pin}>
              固定输入导航
            </button>
          ) : (
            <button type="button" className={btn} onClick={right.collapse}>
              折叠输入导航
            </button>
          )}
        </div>
        {navItems.length === 0 ? (
          <p className="p-4 text-sm text-mute">没有可跳转的消息</p>
        ) : (
          <ol className="m-0 list-none p-0">
            {navItems.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  aria-label={a.text}
                  data-text={
                    a.text.length > NAV_MAX ? `${a.text.slice(0, NAV_MAX)}…` : a.text
                  }
                  onClick={() => jump(a.id)}
                  className="w-full truncate border-b border-line2 px-4 py-2 text-left text-sm before:content-[attr(data-text)] hover:bg-ink/5"
                />
              </li>
            ))}
          </ol>
        )}
      </nav>
      )}
    </div>
  );
}
