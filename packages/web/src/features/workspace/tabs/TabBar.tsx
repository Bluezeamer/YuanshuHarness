// 窗格的标签条：点击/关闭/拖拽排序/溢出滚动。
// 键盘：←/→ 在标签间移动并激活，Home/End 跳首尾，Delete 关闭当前标签。
// 拖放：本条只负责「插入位置」指示与标签的 dragstart；真正的 drop 由 PaneView 统一处理
// （strip 区域），位置用 beforeTabAt 现算，避免两处各存一份状态。

import {
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { IconButton, StripMain } from "../../../ui";
import { CloseIcon } from "../../../ui/icons";
import { beginDrag, endDrag, useDrag } from "../layout/drag";
import { useLayoutStore, useSessionTitles } from "../layoutContext";
import { tabDragHost } from "../model/l2move";
import type { Pane, Tab } from "../model/types";
import { getTabDef, tabTypeLabel, useTitleRev } from "./registry";
import { useCloseActions } from "./terminal/wiring";

/** 指针所在位置之后的第一个标签 id；落在所有标签之后返回 undefined（表示放到末尾） */
export function beforeTabAt(
  strip: Element,
  clientX: number,
  skipTid?: string,
): string | undefined {
  for (const el of strip.querySelectorAll<HTMLElement>("[data-tid]")) {
    const tid = el.dataset.tid;
    if (!tid || tid === skipTid) continue;
    const r = el.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return tid;
  }
  return undefined;
}

export interface TabBarProps {
  pane: Pane;
}

export function TabBar({ pane }: TabBarProps) {
  const store = useLayoutStore();
  const { closeTab } = useCloseActions();
  const titles = useSessionTitles();
  useTitleRev();
  const drag = useDrag();
  const strip = useRef<HTMLDivElement>(null);
  // undefined：不显示；null：显示在末尾；string：显示在该标签之前
  const [mark, setMark] = useState<string | null | undefined>(undefined);

  // 当前标签滚进可视区（溢出时）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在当前标签变化时滚动
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pane.active]);

  const sameBox = drag?.kind === "tab";
  const shown = sameBox ? mark : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = pane.tabs;
    const at = tabs.findIndex((t) => t.id === pane.active);
    let to: number | undefined;
    if (e.key === "ArrowRight") to = (at + 1) % tabs.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = tabs.length - 1;
    else if (e.key === "Delete" && tabs[at]) {
      e.preventDefault();
      void closeTab(pane.pid, tabs[at].id);
      return;
    }
    const next = to === undefined ? undefined : tabs[to];
    if (!next) return;
    e.preventDefault();
    store.activateTab(pane.pid, next.id);
    // 激活后焦点跟着走（roving tabindex）
    requestAnimationFrame(() =>
      strip.current
        ?.querySelector<HTMLElement>(`[data-tid="${next.id}"] [role="tab"]`)
        ?.focus(),
    );
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!sameBox || !strip.current) return;
    setMark(beforeTabAt(strip.current, e.clientX, drag.tid) ?? null);
  };

  const onDragStart = (e: DragEvent<HTMLElement>, tab: Tab) => {
    e.stopPropagation(); // 不要连带触发窗格头的「拖窗格」
    beginDrag(e, { kind: "tab", fromPid: pane.pid, tid: tab.id, tab });
  };

  const lastId = pane.tabs.at(-1)?.id;
  return (
    <div
      ref={strip}
      className="ws-pn-tabs u-strip-list"
      role="tablist"
      aria-label="标签页"
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={() => setMark(undefined)}
    >
      {pane.tabs.map((tab) => {
        const def = getTabDef(tab.type);
        const active = tab.id === pane.active;
        // 对话标签的标题是它绑的会话的标题；空对话标签与库里还没有的会话回落到类型名
        const title =
          tab.type === "chat" && tab.sid !== undefined
            ? (titles.get(tab.sid) ?? def.title(tab))
            : def.title(tab);
        // 标题里没有类型前缀（图标已经表示类型），提示与读屏名称里补上
        const kind = tabTypeLabel(tab.type);
        const full =
          tab.type === "chat" || title === kind ? title : `${kind} · ${title}`;
        const tip = def.tip?.(tab);
        const hint = tip ? `${kind} · ${tip}` : full;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: 包裹层只承载拖拽，交互在内部 button 上
          <div
            key={tab.id}
            className="ws-pn-tab u-strip-tab"
            role="presentation"
            data-tid={tab.id}
            data-type={tab.type}
            data-on={active || undefined}
            data-active={active}
            data-temp={tab.temp || undefined}
            data-host={tabDragHost(tab) ?? undefined}
            data-dragging={drag?.kind === "tab" && drag.tid === tab.id}
            data-before={shown === tab.id}
            data-after={shown === null && tab.id === lastId}
            draggable
            onDragStart={(e) => onDragStart(e, tab)}
            onDragEnd={endDrag}
            onAuxClick={(e) => {
              if (e.button === 1) void closeTab(pane.pid, tab.id);
            }}
          >
            <StripMain
              className="ws-pn-tab-btn"
              selected={active}
              title={hint}
              aria-label={full}
              onClick={() => store.activateTab(pane.pid, tab.id)}
              onDoubleClick={() => {
                if (tab.temp) store.patchTab(tab.id, { temp: undefined });
              }}
            >
              <span className="ws-pn-tab-ic">{def.icon}</span>
              <span className="ws-pn-tab-name u-strip-title t-entry">
                {title}
              </span>
            </StripMain>
            <IconButton
              size="sm"
              label={`关闭标签 ${title}`}
              icon={<CloseIcon size={12} />}
              className="ws-pn-x u-strip-x u-reveal"
              tabIndex={-1}
              onClick={() => void closeTab(pane.pid, tab.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
