import { type ReactNode, type RefObject, useState } from "react";
import { Popover, SearchBox } from "../../../ui";

// 锚点下方的选择器浮层：标题 + 可选搜索 + 列表 + 脚注。
// 关闭时 Popover 卸载内部内容，所以搜索词在每次打开时自然清空。
interface Props {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  title: string;
  /** 标题右侧的小字，如「6 个」「已选 2」 */
  count?: string;
  /** 传了就带搜索框，children 拿到当前搜索词 */
  searchLabel?: string;
  foot?: ReactNode;
  /** 多选列表 */
  multi?: boolean;
  width?: number;
  children: ReactNode | ((q: string) => ReactNode);
}

function Inner({
  title,
  count,
  searchLabel,
  foot,
  multi,
  children,
}: Omit<Props, "open" | "onClose" | "anchorRef" | "width">) {
  const [q, setQ] = useState("");
  return (
    <>
      <div className="ws-cr-pk-head">
        <span className="t-entry">{title}</span>
        {count && <span className="t-mono">{count}</span>}
      </div>
      {searchLabel && (
        <div className="ws-cr-pk-q">
          <SearchBox
            value={q}
            onChange={setQ}
            placeholder={searchLabel}
            aria-label={searchLabel}
            autoFocus
          />
        </div>
      )}
      <div
        className="ws-cr-pk-list"
        role="listbox"
        aria-label={title}
        aria-multiselectable={multi || undefined}
      >
        {typeof children === "function" ? children(q) : children}
      </div>
      {foot && <div className="ws-cr-pk-foot t-aux">{foot}</div>}
    </>
  );
}

export function PickerPop({
  open,
  onClose,
  anchorRef,
  width = 400,
  ...rest
}: Props) {
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      label={rest.title}
      width={width}
      className="ws-cr-pick"
    >
      <Inner {...rest} />
    </Popover>
  );
}
