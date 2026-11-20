// 窗格头的「+」：先选类型；主机级标签（终端/文件）再选主机，
// 首项是「本窗格 · 主机」，选别的主机会在右侧自动新建窗格（store.addTab 里路由）。
// 只有一台候选主机时跳过第二步。基于 ui/Popover，键盘行为与 ui/Menu 一致。

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { IconButton, MenuRow, Popover } from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import { useHostName, useLayoutStore } from "../layoutContext";
import { type Directory, orderHostChoices } from "../model/l2";
import type { Pane, TabType } from "../model/types";
import {
  CREATABLE_TABS,
  getTabDef,
  HOST_LEVEL,
  tabTypeLabel,
} from "./registry";

const items = (root: HTMLElement | null) =>
  Array.from(
    root?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ??
      [],
  );

export interface NewTabMenuProps {
  pane: Pane;
  directories: readonly Directory[];
}

export function NewTabMenu({ pane, directories }: NewTabMenuProps) {
  const store = useLayoutStore();
  const hostName = useHostName();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<TabType | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // 菜单打开或换步时，把焦点交给第一项
  // biome-ignore lint/correctness/useExhaustiveDependencies: picking 变化即换了一屏
  useEffect(() => {
    if (open) items(list.current)[0]?.focus();
  }, [open, picking]);

  const close = () => {
    setOpen(false);
    setPicking(null);
  };

  const hosts = orderHostChoices(
    pane.host,
    directories.map((w) => w.host),
  );

  const create = (type: TabType, host?: string) => {
    close();
    anchor.current?.focus();
    if (!host) {
      // 没有主机的类型直接建（浏览器跟工作区走）
      store.addTab(pane.pid, type, {});
      return;
    }
    const path = directories.find((w) => w.host === host)?.path;
    store.addTab(pane.pid, type, {
      host,
      ...(type === "term" && path ? { cwd: path } : {}),
      ...(type === "files" && path ? { path } : {}),
    });
  };

  // 画布跟着工作区的主目录（逻辑 local）走，不用选主机
  const createCanvas = () => {
    close();
    anchor.current?.focus();
    const main = directories[0];
    if (main)
      store.addTab(pane.pid, "canvas", { host: main.host, path: main.path });
  };

  const choose = (type: TabType) => {
    if (type === "canvas") return createCanvas();
    if (!HOST_LEVEL.has(type)) return create(type);
    if (hosts.length <= 1) return create(type, hosts[0] ?? "server");
    setPicking(type);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = items(list.current);
    const at = els.indexOf(document.activeElement as HTMLElement);
    const to = {
      ArrowDown: (at + 1) % els.length,
      ArrowUp: (at - 1 + els.length) % els.length,
      Home: 0,
      End: els.length - 1,
    }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      els[to]?.focus();
    } else if (e.key === "ArrowLeft" && picking) {
      e.preventDefault();
      setPicking(null);
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <>
      <IconButton
        ref={anchor}
        label="新建标签页"
        icon={<PlusIcon />}
        className="u-strip-add"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      />
      <Popover
        open={open}
        onClose={close}
        anchorRef={anchor}
        label="新建标签页"
        placement="bottom-start"
        width={208}
        role="menu"
        panelRef={list}
        onKeyDown={onKeyDown}
        className="u-menu"
      >
        {picking ? (
          <>
            <div className="ws-menu-h t-aux">
              {tabTypeLabel(picking)} · 选择主机
            </div>
            <MenuRow onClick={() => setPicking(null)}>
              <span>返回类型</span>
            </MenuRow>
            <hr className="u-menu-sep" />
            {hosts.map((h) => (
              <MenuRow key={h} onClick={() => create(picking, h)}>
                <span>{hostName(h)}</span>
                {h === pane.host && <span className="u-menu-hint">本窗格</span>}
              </MenuRow>
            ))}
            <hr className="u-menu-sep" />
            <div className="ws-menu-note t-aux">
              其他主机在右侧新建窗格 · 一个窗格只装一台主机
            </div>
          </>
        ) : (
          CREATABLE_TABS.map((type) => (
            <MenuRow key={type} onClick={() => choose(type)}>
              <span className="ws-menu-lab">
                <span className="ws-menu-ic">{getTabDef(type).icon}</span>
                <span>{tabTypeLabel(type)}</span>
              </span>
            </MenuRow>
          ))
        )}
      </Popover>
    </>
  );
}
