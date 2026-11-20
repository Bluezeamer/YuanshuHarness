// 当前工作区布局的 L2：窗口条 + 当前窗口的窗格树（ui/tiling 的通用件，这里接上工作区的数据与规则）。
// 窗口条：切换/新增/关闭；拖一个窗格到窗口标签上 = 移到该窗口。
// 键盘：窗口条 ←/→ 切窗口；窗格区 F6 / Shift+F6 在窗格间循环焦点。

import { type KeyboardEvent, useRef } from "react";
import { Empty, Loading } from "../../../ui";
import { TilingLayout, WindowBar } from "../../../ui/tiling";
import {
  useLayoutDirectories,
  useLayoutState,
  useLayoutStore,
} from "../layoutContext";
import { hostTones, panesOf } from "../model/l2";
import type { Window } from "../model/types";
import { useCloseActions } from "../tabs/terminal/wiring";
import { endDrag, getDrag, useDrag } from "./drag";
import { PaneView } from "./PaneView";

export function L2View() {
  const store = useLayoutStore();
  const { closeWindow } = useCloseActions();
  const status = useLayoutState((s) => s.status);
  const st = useLayoutState((s) => s.doc.windows);
  const directories = useLayoutDirectories();
  const drag = useDrag();
  const wrap = useRef<HTMLDivElement>(null);

  if (status === "blocked") {
    return (
      <div className="ws-wnwrap">
        <Empty
          compact
          title="布局来自更新的版本"
          description="当前版本不能编辑"
        />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="ws-wnwrap">
        <Empty
          tone="danger"
          compact
          title="布局载入失败"
          description="刷新页面重试"
        />
      </div>
    );
  }
  const win: Window | undefined = st.list[st.active];
  if (status !== "ready" || !win) {
    return (
      <div className="ws-wnwrap">
        <Loading compact>正在准备窗口</Loading>
      </div>
    );
  }

  const panes = panesOf(win);
  const tones = hostTones(win);
  const movable = drag?.kind === "pane";

  const focusDom = (pid: string) =>
    requestAnimationFrame(() =>
      wrap.current
        ?.querySelector<HTMLElement>(
          `[data-pid="${pid}"] [role="tab"][aria-selected="true"]`,
        )
        ?.focus(),
    );

  const onPanesKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "F6" || panes.length < 2) return;
    e.preventDefault();
    const at = panes.findIndex((p) => p.pid === win.focus);
    const next =
      panes[(at + (e.shiftKey ? -1 : 1) + panes.length) % panes.length];
    if (!next) return;
    store.focusPane(next.pid);
    focusDom(next.pid);
  };

  return (
    <div className="ws-wnwrap" ref={wrap}>
      <WindowBar
        aria-label="窗口"
        addLabel="新建窗口"
        labels={st.list.map((_, i) => `窗口 ${i + 1}`)}
        active={st.active}
        onSwitch={(i) => store.switchWindow(i)}
        onAdd={() => store.addWindow()}
        {...(st.list.length > 1 ? { onClose: (i) => void closeWindow(i) } : {})}
        droppable={movable}
        onDropTo={(i) => {
          const d = getDrag();
          if (d?.kind !== "pane") return;
          endDrag();
          store.movePaneToWindow(d.pid, i);
        }}
        hint={movable ? "拖到窗口标签上，移到该窗口" : undefined}
      />

      {/* biome-ignore lint/a11y/noStaticElementInteractions: 只接 F6 键盘冒泡，焦点在内部窗格控件上 */}
      <div className="ws-wnbody" onKeyDown={onPanesKey}>
        <TilingLayout
          node={win.root}
          handleLabel="调整窗格大小"
          onSizes={(path, sizes) => store.setPaneSizes(path, sizes)}
          renderLeaf={(pane) => (
            <PaneView
              pane={pane}
              focused={pane.pid === win.focus}
              tone={pane.host ? tones[pane.host] : undefined}
              directories={directories}
              paneCount={panes.length}
              winCount={st.list.length}
              winIndex={st.active}
            />
          )}
        />
      </div>
    </div>
  );
}
