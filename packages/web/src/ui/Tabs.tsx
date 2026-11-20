import type { KeyboardEvent, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cx } from "./cx";

export type TabItem = { id: string; label: string; count?: number };

export type TabsProps = {
  tabs: ReadonlyArray<TabItem>;
  value: string;
  onChange: (id: string) => void;
  "aria-label": string;
  // 与 TabPanel 共用的 id 前缀，用来接 aria-controls / aria-labelledby
  idBase: string;
  // 页签行右侧的 mono 小字，窄屏隐藏
  right?: ReactNode;
  className?: string;
};

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const panelId = (base: string, id: string) => `${base}-panel-${id}`;

// 页签：自动激活（方向键移动即切换），选中下划线是一枚滑动的 2px 墨色。
export function Tabs({
  tabs,
  value,
  onChange,
  idBase,
  right,
  className,
  ...rest
}: TabsProps) {
  const list = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState({ x: 0, w: 0 });

  // 量选中页签的位置；字体加载或容器缩放后宽度会变，所以随尺寸变化重量
  // biome-ignore lint/correctness/useExhaustiveDependencies: value 与 tabs 变化时要重新量
  useLayoutEffect(() => {
    const measure = () => {
      const el = list.current?.querySelector<HTMLElement>(
        '[aria-selected="true"]',
      );
      if (el) setInk({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !list.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(list.current);
    return () => ro.disconnect();
  }, [value, tabs]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((t) => t.id === value);
    const to = {
      ArrowRight: (at + 1) % tabs.length,
      ArrowLeft: (at - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[e.key];
    const next = to === undefined ? undefined : tabs[to];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    list.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(tabId(idBase, next.id))}`)
      ?.focus();
  };

  return (
    <div className={cx("u-tabs", className)}>
      <div
        ref={list}
        role="tablist"
        className="u-tablist"
        onKeyDown={onKeyDown}
        {...rest}
      >
        {tabs.map((t) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={tabId(idBase, t.id)}
              aria-selected={selected}
              aria-controls={panelId(idBase, t.id)}
              tabIndex={selected ? 0 : -1}
              className="u-tab t-plain"
              onClick={() => onChange(t.id)}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="u-tab-n t-mono">{t.count}</span>
              )}
            </button>
          );
        })}
        <span
          aria-hidden="true"
          className="u-tab-ink"
          style={{ left: ink.x, width: ink.w }}
        />
      </div>
      {right && <div className="u-tabs-r t-mono">{right}</div>}
    </div>
  );
}

export type TabPanelProps = {
  idBase: string;
  id: string;
  value: string;
  className?: string;
  children: ReactNode;
};

// 只渲染当前页签的面板，其余不挂载：隐藏页签里的表单不参与校验，也不在后台跑副作用。
// 需要跨页签保留的状态由使用方提升到页签之上。
export function TabPanel({
  idBase,
  id,
  value,
  className,
  children,
}: TabPanelProps) {
  if (id !== value) return null;
  return (
    <div
      role="tabpanel"
      id={panelId(idBase, id)}
      aria-labelledby={tabId(idBase, id)}
      className={className}
    >
      {children}
    </div>
  );
}
