// 标签类型注册表：type -> { icon, title(tab), render(props) }。
// P2a 只放接口与占位渲染器；chat/sub/term/files/web/preview 的真实内容由别的任务
// 通过 registerTab(type, def) 接入，不需要改本文件。

import { type ReactNode, useSyncExternalStore } from "react";
import { Empty } from "../../../ui";
import { CREATABLE_TABS, isHostType, TAB_KINDS } from "../model/tabKinds";
import type { Pane, Tab, TabAfx, TabType } from "../model/types";

/** 标签内容渲染器拿到的 props（终端等标签任务按它实现） */
export interface TabRenderProps {
  tab: Tab;
  pane: Pane;
  /**
   * chat / sub / web 标签是它自己绑的会话（空对话标签为 null）；
   * term / files / preview 是工作区级标签，取「锚点会话」（当前窗口里正在显示的会话，用来借一条会话流做文件监听），
   * 没有为 null。
   */
  sessionId: string | null;
  /** 是否为所在窗格的当前标签（非当前标签通常不渲染，但注册表允许保活） */
  active: boolean;
  patchTab(patch: Partial<Tab>): void;
  patchAfx(patch: Partial<TabAfx>): void;
  close(): void;
}

export interface TabDef {
  icon: ReactNode;
  title(tab: Tab): string;
  /** 悬停提示里放在类型名后面的完整信息（路径、目录）；缺省用标题 */
  tip?(tab: Tab): string;
  render(props: TabRenderProps): ReactNode;
  /** 窗格头里标签条右端的一个小入口（当前标签是这个类型时才出现）；对话标签用它放「审计 N」 */
  headAction?(props: Pick<TabRenderProps, "tab" | "patchTab">): ReactNode;
}

const glyph = (d: string): ReactNode => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

const ICON: Record<TabType, ReactNode> = {
  chat: glyph("M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"),
  sub: glyph("M4 3v5a3 3 0 0 0 3 3h5M10 8l2 3-2 3"),
  job: glyph("M2.5 3.5h11v9h-11zM5 6.5h6M5 9.5h4"),
  term: glyph("M2.5 3.5h11v9h-11zM5 7l2 1.5L5 10M8.5 10h2.5"),
  files: glyph("M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z"),
  web: glyph(
    "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11",
  ),
  preview: glyph("M4 2.5h5l3 3v8h-8zM9 2.5v3h3"),
  canvas: glyph("M2.5 3.5h5v4h-5zM9 9h4.5v4H9zM7.5 5.5H11V9"),
};

/** 占位标题：类型名 + 路径/地址的末段 */
function defaultTitle(tab: Tab): string {
  const base = TAB_KINDS[tab.type].label;
  const hint = tab.path || tab.sub || tab.job;
  if (!hint) return base;
  const last = hint.split("/").filter(Boolean).pop() ?? hint;
  return `${base} · ${last}`;
}

function placeholder({ tab }: TabRenderProps): ReactNode {
  return (
    <div className="ws-tab-ph">
      <Empty
        title={TAB_KINDS[tab.type].label}
        description={`${tab.type} · ${tab.id}`}
      />
    </div>
  );
}

const defs = new Map<TabType, TabDef>(
  (Object.keys(TAB_KINDS) as TabType[]).map((type) => [
    type,
    { icon: ICON[type], title: defaultTitle, render: placeholder },
  ]),
);

/** 注册（或覆盖）一种标签类型；只需要覆盖的字段可用 getTabDef 取旧值再展开 */
export function registerTab(type: TabType, def: TabDef): void {
  defs.set(type, def);
}

export function getTabDef(type: TabType): TabDef {
  // 构造时已覆盖全部 TabType，Map 里一定有
  return defs.get(type) as TabDef;
}

// 标题依赖异步数据（执行体 / 后台任务的名称缓存）：缓存变了通知标签条重画，否则刷新后没点开过的标签一直停在兜底标题。
let titleRev = 0;
const titleSubs = new Set<() => void>();

export function titlesChanged(): void {
  titleRev += 1;
  for (const f of titleSubs) f();
}

/** 订阅标题数据的变化；读标题的组件（标签条、窗格）调一次，变了就重画 */
export function useTitleRev(): number {
  return useSyncExternalStore(
    (cb) => {
      titleSubs.add(cb);
      return () => titleSubs.delete(cb);
    },
    () => titleRev,
  );
}

export const tabTypeLabel = (type: TabType): string => TAB_KINDS[type].label;

export { CREATABLE_TABS };

export const HOST_LEVEL: ReadonlySet<TabType> = new Set(
  (Object.keys(TAB_KINDS) as TabType[]).filter(isHostType),
);
