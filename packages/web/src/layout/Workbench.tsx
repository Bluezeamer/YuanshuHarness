import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  moveToTab,
  newId,
  renamePane,
  renameWindow,
  selectPaneTab,
  selectWindow,
  setPaneConfig,
  setTree,
  windowOf,
} from "./doc";
import { type DropTarget, dropTarget } from "./drag";
import { CloseIcon, SplitDownIcon, SplitRightIcon } from "./icons";
import { PaneLayer } from "./PaneLayer";
import { type ChatConfig, defaultRegistry, EnvContext } from "./panes";
import { SavedLayouts } from "./SavedLayouts";
import {
  layout,
  neighbor,
  paneIds,
  resize,
  tabGroupOf,
  visibleIds,
} from "./tree";
import { useWorkbench } from "./useWorkbench";

const btn =
  "border border-line px-2 py-0.5 text-xs font-semibold hover:bg-ink hover:text-bg";
const iconBtn =
  "grid size-6 place-items-center border border-line hover:bg-ink hover:text-bg";

export const PANE_SOFT_LIMIT = 12;

export function Workbench({
  hub,
  sessions,
  onUnauthorized,
  tabsHost,
}: {
  hub: SessionHub;
  sessions: SessionInfo[];
  onUnauthorized: () => void;
  // 顶栏里放 window 标签的位置；没有时标签行留在工作台内。
  tabsHost?: HTMLElement | null;
}) {
  const registry = useMemo(defaultRegistry, []);
  const wb = useWorkbench(registry, onUnauthorized);
  const { doc, update } = wb;
  const [focus, setFocus] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(
    null,
  );
  // 键盘或程序触发的焦点移动：状态与 DOM 焦点一起走，否则下一次按键还落在旧 pane。
  const goto = (id: string) => {
    setFocus(id);
    setFocusReq((r) => ({ id, n: (r?.n ?? 0) + 1 }));
  };
  useEffect(() => {
    if (!focusReq) return;
    const el = document.querySelector<HTMLElement>(
      `[data-pane-id="${focusReq.id}"]`,
    );
    (
      el?.querySelector<HTMLElement>("textarea,input:not([type=hidden])") ?? el
    )?.focus();
  }, [focusReq]);
  const env = useMemo(() => ({ hub, sessions }), [hub, sessions]);

  const active = doc.windows.find((w) => w.id === doc.activeWindowId);
  const inActive = visibleIds(active?.tree ?? null);
  const focused =
    focus && inActive.includes(focus) ? focus : (inActive[0] ?? null);
  const sessionOf = (paneId: string | null) => {
    const e = paneId ? doc.panes[paneId] : undefined;
    return e?.type === "chat" ? (e.config as ChatConfig).sessionId : null;
  };

  // R24：pane 总数达到软上限时提示，不阻止。
  const [crowded, setCrowded] = useState(false);
  const warnIfCrowded = () =>
    setCrowded(Object.keys(doc.panes).length >= PANE_SOFT_LIMIT);

  // R6：Alt+方向键按位置移动焦点。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.altKey || !focused) return;
    const dir = (
      {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      } as const
    )[e.key as "ArrowLeft"];
    if (!dir) return;
    const rects = layout(active?.tree ?? null, { x: 0, y: 0, w: 1, h: 1 });
    const next = neighbor(rects, focused, dir);
    e.preventDefault();
    if (next) goto(next);
  };

  // R5：pointer 事件拖动。移动超过 4px 才算拖动，避免吞掉标题栏按钮的点击。
  const [pending, setPending] = useState<{
    paneId: string;
    x: number;
    y: number;
  } | null>(null);
  const [dragTarget, setDragTarget] = useState<DropTarget>(null);
  const [dragging, setDragging] = useState(false);
  const [ghost, setGhost] = useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);
  const latest = useRef({ doc, inActive });
  latest.current = { doc, inActive };

  useEffect(() => {
    if (!pending) return;
    let started = false;
    let target: DropTarget = null;
    const label =
      document
        .querySelector(`[data-pane-id="${pending.paneId}"]`)
        ?.getAttribute("aria-label") ?? "";
    // 拖动期间禁用划选，并清掉已经选中的文字。
    const body = document.body.style;
    const prevSelect = body.userSelect;
    body.userSelect = "none";
    window.getSelection?.()?.removeAllRanges();
    const end = () => {
      setPending(null);
      setDragging(false);
      setDragTarget(null);
      setGhost(null);
    };
    const onMove = (e: PointerEvent) => {
      if (
        !started &&
        Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 4
      )
        return;
      started = true;
      setDragging(true);
      setGhost({ x: e.clientX, y: e.clientY, label });
      target = dropTarget(
        e.clientX,
        e.clientY,
        pending.paneId,
        // 被拖的是 tab 组里选中的一项时，组内其他 tab 也算落点：
        // 它们和组共用同一个矩形，这样才能拖到自己所在组的边缘把它拆出来。
        [
          ...latest.current.inActive,
          ...(tabGroupOf(
            windowOf(latest.current.doc, pending.paneId)?.tree ?? {
              kind: "leaf",
              paneId: "",
            },
            pending.paneId,
          ) ?? []),
        ],
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
      else if (t.kind === "tab") update((d) => moveToTab(d, id, t.paneId));
      else
        update((d) => {
          const w = windowOf(d, t.paneId);
          return w
            ? movePane(d, id, w.id, {
                target: t.paneId,
                dir: t.dir,
                before: t.before,
              })
            : d;
        });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
    };
    const onCancel = () => end();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      body.userSelect = prevSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
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

  const split = (paneId: string, dir: "h" | "v") => {
    const w = windowOf(doc, paneId);
    if (!w) return;
    const id = newChat(w.id, { target: paneId, dir });
    if (id) goto(id);
  };

  const menu = (paneId: string) => (
    <span className="flex items-center gap-1">
      <button
        type="button"
        className={iconBtn}
        title="向右分割"
        aria-label="向右分割"
        onClick={() => split(paneId, "h")}
      >
        <SplitRightIcon />
      </button>
      <button
        type="button"
        className={iconBtn}
        title="向下分割"
        aria-label="向下分割"
        onClick={() => split(paneId, "v")}
      >
        <SplitDownIcon />
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
        className={iconBtn}
        title="关闭"
        aria-label="关闭"
        onClick={() => update((d) => closePane(d, paneId))}
      >
        <CloseIcon />
      </button>
    </span>
  );

  const tablist = (
    <div
      role="tablist"
      aria-label="window"
      className="flex items-stretch gap-1"
    >
      {doc.windows.map((w) => (
        <span key={w.id} className="flex items-stretch">
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
            className={`px-3.5 py-3.5 font-semibold ${w.id === doc.activeWindowId ? "border-b-[3px] border-ink" : "border-b-[3px] border-transparent text-mute"}`}
          >
            {w.name}
          </button>
          {doc.windows.length > 1 && (
            <button
              type="button"
              aria-label={`关闭 ${w.name}`}
              className="self-center px-1 text-xs text-mute hover:text-ink"
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
        className={`${btn} self-center`}
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
    </div>
  );

  return (
    <div className="enter relative flex h-full min-h-0 flex-col">
      {tabsHost ? (
        createPortal(tablist, tabsHost)
      ) : (
        <div className="border-b border-line bg-panel px-3">{tablist}</div>
      )}
      <main className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
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
            pane 已有 {Object.keys(doc.panes).length}{" "}
            个，都会常驻内存，可以关掉不用的
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
            onSelectTab={(id) => {
              update((d) => selectPaneTab(d, id));
              goto(id);
            }}
            onCloseTab={(id) => update((d) => closePane(d, id))}
            onRename={(id) => {
              const cur = doc.panes[id]?.name ?? "";
              const name = window.prompt("pane 名称（留空恢复默认）", cur);
              if (name !== null) update((d) => renamePane(d, id, name));
            }}
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
          {ghost && (
            <div
              data-drag-ghost
              style={{ left: ghost.x + 14, top: ghost.y + 14 }}
              className="pointer-events-none fixed max-w-60 truncate border border-ink bg-panel px-2 py-1 text-xs font-semibold opacity-90"
            >
              {ghost.label}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
