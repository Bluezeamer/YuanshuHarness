// 窗格：头（标签条 + 新建 + 主机 + 窗格菜单，空白处可拖整个窗格）、内容、六个落点预览（ui/tiling 的 PaneFrame）。
// 落点由窗格统一判定（dropZoneAt），标签条只贡献 strip 里的插入位置。
// 跨主机的并入（center/strip）仍然接受 drop：交给 store，由它弹出点名两台主机的提示。

import { type CSSProperties, type DragEvent, useRef, useState } from "react";
import { Menu, type MenuItem } from "../../../ui";
import { type DropZone, dropZoneAt, PaneFrame } from "../../../ui/tiling";
import {
  useAnchorSession,
  useHostName,
  useLayoutStore,
} from "../layoutContext";
import type { Directory } from "../model/l2";
import { dropBlocked, tabDragHost } from "../model/l2move";
import { hasHost } from "../model/tabKinds";
import type { Pane } from "../model/types";
import { NewTabMenu } from "../tabs/NewTabMenu";
import { getTabDef, useTitleRev } from "../tabs/registry";
import { beforeTabAt, TabBar } from "../tabs/TabBar";
import { useCloseActions } from "../tabs/terminal/wiring";
import {
  beginDrag,
  type DragItem,
  endDrag,
  getDrag,
  pointIn,
  useDrag,
} from "./drag";
import { TabBody } from "./TabBody";

const ZONE_LABEL: Record<DropZone, string> = {
  left: "左侧拆分",
  right: "右侧拆分",
  top: "上方拆分",
  bottom: "下方拆分",
  center: "并入此窗格",
  strip: "作为标签页",
};

/** 被拖物属于哪台主机；不按主机隔离的标签与未绑主机的窗格为 null（不受限） */
const dragHostOf = (d: DragItem): string | null =>
  d.kind === "tab" ? tabDragHost(d.tab) : d.kind === "pane" ? d.host : null;

export interface PaneViewProps {
  pane: Pane;
  focused: boolean;
  /** 主机色序号 1..6；窗格未绑主机时为 undefined */
  tone?: number;
  directories: readonly Directory[];
  /** 当前窗口内窗格数、窗口总数与当前下标（决定窗格菜单里有哪些项） */
  paneCount: number;
  winCount: number;
  winIndex: number;
}

export function PaneView({
  pane,
  focused,
  tone,
  directories,
  paneCount,
  winCount,
  winIndex,
}: PaneViewProps) {
  useTitleRev();
  const store = useLayoutStore();
  const { closePane, closeTab } = useCloseActions();
  const hostName = useHostName();
  const anchor = useAnchorSession();
  const drag = useDrag();
  const root = useRef<HTMLElement>(null);
  const [zone, setZone] = useState<DropZone | null>(null);

  const accepts = (d: DragItem | null): d is DragItem =>
    d !== null && (d.kind !== "session" || store.hasSession(d.sid));
  const usable = accepts(drag);
  const shown = usable ? zone : null;
  const blocked = (z: DropZone) =>
    usable && dropBlocked(pane, dragHostOf(drag), z);

  /**
   * 指针落在本窗格的哪个落点；null = 不接受。
   * 窗格不能放到自己身上；同窗格内拖标签：标签条 = 重排，四边 = 拆出，中部（并入自己）无意义。
   */
  const zoneAt = (e: DragEvent<HTMLElement>): DropZone | null => {
    const d = getDrag();
    if (!accepts(d)) return null;
    if (d.kind === "pane" && d.pid === pane.pid) return null; // 不能放到自己身上
    const z = dropZoneAt(pointIn(e, e.currentTarget));
    if (d.kind === "tab" && d.fromPid === pane.pid && z === "center")
      return null;
    return z;
  };

  const onDragOver = (e: DragEvent<HTMLElement>) => {
    const z = zoneAt(e);
    // 拒绝时清掉旧高亮：从标签条/四边滑到中部后不能残留上一个落点
    if (!z) {
      if (zone !== null) setZone(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (z !== zone) setZone(z);
  };

  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null))
      setZone(null);
  };

  const onDrop = (e: DragEvent<HTMLElement>) => {
    const d = getDrag();
    // 按松手时的实际位置重算落点：只信 dragover 的高亮会在滑到中部松手时误用残留落点
    const z = zoneAt(e);
    setZone(null);
    if (!d || !z) return;
    e.preventDefault();
    endDrag();
    if (d.kind === "session") {
      const strip = e.currentTarget.querySelector(".ws-pn-tabs");
      const before =
        z === "strip" && strip ? beforeTabAt(strip, e.clientX) : undefined;
      store.placeSession(d.sid, pane.pid, z, before);
      return;
    }
    if (d.kind === "pane") {
      store.movePane(d.pid, pane.pid, z);
      return;
    }
    const strip = e.currentTarget.querySelector(".ws-pn-tabs");
    const before =
      z === "strip" && strip ? beforeTabAt(strip, e.clientX, d.tid) : undefined;
    store.moveTab(d.fromPid, d.tid, pane.pid, z, before);
  };

  const active = pane.tabs.find((t) => t.id === pane.active) ?? pane.tabs[0];
  const def = active ? getTabDef(active.type) : null;
  // 带主机的标签没有自己的会话，借工作区的锚点会话
  const sessionId = active
    ? (active.sid ?? (hasHost(active.type) ? anchor : null))
    : null;

  const menu: MenuItem[] = [];
  if (paneCount > 1) {
    menu.push({
      id: "detach",
      label: "移到新窗口",
      onSelect: () => store.detachPane(pane.pid),
    });
  }
  for (let i = 0; i < winCount; i++) {
    if (i === winIndex) continue;
    menu.push({
      id: `to-${i}`,
      label: `移到窗口 ${i + 1}`,
      onSelect: () => store.movePaneToWindow(pane.pid, i),
    });
  }
  if (paneCount > 1) {
    menu.push({
      id: "close",
      label: "关闭窗格",
      tone: "danger",
      separatorBefore: true,
      onSelect: () => void closePane(pane.pid),
    });
  }

  const style = tone
    ? ({ "--tone": `var(--h${tone})` } as CSSProperties)
    : undefined;
  return (
    <PaneFrame
      ref={root}
      className="ws-pane"
      aria-label={pane.host ? `窗格 · ${hostName(pane.host)}` : "窗格"}
      data-pid={pane.pid}
      data-host={pane.host ?? ""}
      data-dragging={drag?.kind === "pane" && drag.pid === pane.pid}
      style={style}
      focused={focused}
      zone={shown}
      blocked={blocked}
      zoneLabel={(z) => ZONE_LABEL[z]}
      blockedLabel="主机不同 · 不可并入"
      onPointerDownCapture={() => !focused && store.focusPane(pane.pid)}
      onFocusCapture={() => !focused && store.focusPane(pane.pid)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      head={
        // biome-ignore lint/a11y/noStaticElementInteractions: 窗格头仅作拖拽手柄，交互在内部控件上
        <div
          className="ws-pn-head u-strip"
          draggable
          onDragStart={(e) =>
            beginDrag(e, { kind: "pane", pid: pane.pid, host: pane.host })
          }
          onDragEnd={endDrag}
        >
          <TabBar pane={pane} />
          <NewTabMenu pane={pane} directories={directories} />
          <div className="ws-pn-end">
            {active &&
              def?.headAction?.({
                tab: active,
                patchTab: (patch) => store.patchTab(active.id, patch),
              })}
            {pane.host && (
              <span
                className="ws-pn-host t-aux"
                title={hostName(pane.host)}
                data-host={pane.host}
              >
                <i className="ws-hdot" />
                <span className="ws-hname">{hostName(pane.host)}</span>
              </span>
            )}
            {menu.length > 0 && <Menu items={menu} label="窗格操作" />}
          </div>
        </div>
      }
    >
      {active && def && (
        <TabBody
          // 按标签 id 做 key：同类型的两个标签（两个终端、两个文件管理器）必须是两个独立实例，
          // 否则切换标签只是换 props，第二个终端会复用第一个终端的连接与状态。
          key={active.id}
          tab={active}
          label={def.title(active)}
        >
          {def.render({
            tab: active,
            pane,
            sessionId,
            active: true,
            patchTab: (patch) => store.patchTab(active.id, patch),
            patchAfx: (patch) => store.patchAfx(active.id, patch),
            close: () => void closeTab(pane.pid, active.id),
          })}
        </TabBody>
      )}
    </PaneFrame>
  );
}
