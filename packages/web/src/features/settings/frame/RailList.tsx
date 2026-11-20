import { type ReactNode, useState } from "react";
import { Button, ListRow, Menu, type MenuItem, SearchBox } from "../../../ui";
import { ChevronRightIcon, PlusIcon } from "../../../ui/icons";

export interface RailItem {
  id: string;
  label: string;
  sub?: string;
  /** 平时显示的状态（点或几个字）；悬停时让位给「⋯」 */
  trail?: ReactNode;
  /** 悬停详情卡片的内容（PeekCard）；缺省 = 不带卡片 */
  peek?: ReactNode;
  /** 「⋯」菜单里的进一步操作；缺省 = 不带「⋯」 */
  menu?: MenuItem[];
}

export interface RailSection {
  key: string;
  /** 缺省 = 不分段，直接列行 */
  name?: string;
  /** 组头悬停出现的「⋯」菜单 */
  menu?: MenuItem[];
  items: RailItem[];
}

/**
 * 主从页左列表的标准件（ys-ui-design 的 X04、X05）：头（标题 + 数量）、搜索、
 * 可折叠分段、行（平时只有名字 / 副标题 / 状态，悬停浮出「⋯」与详情卡片）、底部添加。
 * 搜索（给 onQuery）、添加（给 onAdd）、行的卡片与菜单都可以不要：纯分类导航（卡片库的分组）只留头与行。
 */
export function RailList({
  title,
  total,
  menu,
  query = "",
  onQuery,
  searchLabel = "",
  sections,
  sel,
  onSel,
  addLabel,
  onAdd,
  noneText,
}: {
  title: string;
  total: number;
  /** 头部的「⋯」菜单：作用于整张列表的操作（检查更新、全部检测…） */
  menu?: MenuItem[];
  query?: string;
  onQuery?: (q: string) => void;
  searchLabel?: string;
  sections: RailSection[];
  sel: string | null;
  onSel: (id: string) => void;
  addLabel?: string;
  onAdd?: () => void;
  noneText: string;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim() !== "";
  const toggle = (key: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <aside className="st-rail" aria-label={title}>
      <div className="st-rail-h">
        <span className="t-group">{title}</span>
        <span className="t-mono">{total}</span>
        {menu && (
          <Menu
            className="st-rail-h-menu"
            label={`${title}的操作`}
            items={menu}
          />
        )}
      </div>
      {onQuery && (
        <SearchBox
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={onQuery}
        />
      )}
      <div className="st-rail-list">
        {sections.map((s) => {
          const open = searching || !closed.has(s.key);
          return (
            <div key={s.key} className="st-rail-sec">
              {s.name !== undefined && (
                <ListRow
                  size="compact"
                  className="st-rail-grp"
                  label={s.name}
                  lead={
                    <ChevronRightIcon
                      className="st-chev"
                      data-open={open || undefined}
                      aria-hidden
                    />
                  }
                  trail={<span className="t-mono">{s.items.length}</span>}
                  actions={
                    s.menu ? (
                      <Menu label={`${s.name} 的操作`} items={s.menu} />
                    ) : undefined
                  }
                  onClick={() => toggle(s.key)}
                />
              )}
              {open &&
                s.items.map((it) => (
                  <ListRow
                    key={it.id}
                    label={it.label}
                    {...(it.sub ? { sub: it.sub } : {})}
                    {...(it.trail ? { trail: it.trail } : {})}
                    {...(it.peek ? { peek: it.peek } : {})}
                    {...(it.menu
                      ? {
                          actions: (
                            <Menu
                              label={`${it.label} 的操作`}
                              items={it.menu}
                            />
                          ),
                        }
                      : {})}
                    current={it.id === sel}
                    onClick={() => onSel(it.id)}
                  />
                ))}
            </div>
          );
        })}
        {sections.length === 0 && (
          <p className="st-rail-none t-aux">{noneText}</p>
        )}
      </div>
      {onAdd && (
        <Button
          variant="outline"
          className="st-rail-add"
          icon={<PlusIcon size={14} />}
          onClick={onAdd}
        >
          {addLabel}
        </Button>
      )}
    </aside>
  );
}
