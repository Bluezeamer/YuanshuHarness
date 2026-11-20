import { type ReactNode, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Menu,
  type MenuItem,
  SearchBox,
} from "../../../ui";
import { PlusIcon } from "../../../ui/icons";

export interface CardGridItem {
  id: string;
  /** 给「⋯」按钮的可访问名 */
  name: string;
  title: ReactNode;
  /** 标题右边的小标记（「生效中」「内置」） */
  badge?: ReactNode;
  description: ReactNode;
  /** 底部一行（卡片数、被引用数……） */
  meta?: ReactNode;
  /** 搜索框匹配的文字 */
  search: string;
  /** 悬停浮出的「⋯」菜单；缺省 = 不带 */
  menu?: MenuItem[];
}

/**
 * 卡片列表页的标准版式（ys-ui-build 的 components §5）：搜索 + 主操作、卡片网格、空状态。
 * 点卡片打开；卡片上的操作都收进「⋯」菜单。放在 `ListColumn` 里，或主从页右侧的滚动列里。
 */
export function CardGrid({
  items,
  searchLabel,
  addLabel,
  onAdd,
  onOpen,
  emptyTitle,
  emptyHint,
  lead,
}: {
  items: readonly CardGridItem[];
  searchLabel: string;
  /** 主按钮文案，缺省 = 没有新建 */
  addLabel?: string;
  onAdd?: () => void;
  onOpen: (id: string) => void;
  /** 一张都没有时的标题 */
  emptyTitle: string;
  emptyHint?: ReactNode;
  /** 工具条上方的说明或提示条 */
  lead?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const shown = items.filter((i) => i.search.includes(q));
  return (
    <>
      {lead}
      <div className="st-cg-bar">
        <SearchBox
          aria-label={searchLabel}
          placeholder={searchLabel}
          className="st-cg-search"
          value={q}
          onChange={setQ}
        />
        {addLabel && onAdd && (
          <Button icon={<PlusIcon size={14} />} onClick={onAdd}>
            {addLabel}
          </Button>
        )}
      </div>
      {shown.length === 0 && (
        <Empty
          title={items.length === 0 ? emptyTitle : "没有符合的结果"}
          {...(items.length === 0 && emptyHint
            ? { description: emptyHint }
            : {})}
        />
      )}
      <div className="st-cg">
        {shown.map((i) => (
          <Card
            key={i.id}
            title={i.title}
            {...(i.badge ? { badge: i.badge } : {})}
            description={i.description}
            {...(i.meta ? { meta: i.meta } : {})}
            {...(i.menu
              ? {
                  actions: <Menu label={`${i.name} 的操作`} items={i.menu} />,
                }
              : {})}
            onOpen={() => onOpen(i.id)}
          />
        ))}
      </div>
    </>
  );
}
