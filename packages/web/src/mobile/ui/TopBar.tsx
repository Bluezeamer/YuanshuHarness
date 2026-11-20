import type { ReactNode } from "react";
import { IconButton } from "../../ui";
import { BackIcon } from "../../ui/icons";

export interface TopBarProps {
  title: ReactNode;
  /** 有它就在最左边出一个返回按钮 */
  onBack?: () => void;
  /** 没有返回按钮时放在标题前的东西（列表页的品牌标记） */
  lead?: ReactNode;
  /** 右边的操作，每个都是 ≥48 的触控目标 */
  end?: ReactNode;
}

// 页面顶栏：返回 / 标题 / 操作。返回按钮与系统返回键走同一个 nav.back()。
export function TopBar({ title, onBack, lead, end }: TopBarProps) {
  return (
    <header className="m-top">
      {onBack ? (
        <IconButton label="返回" icon={<BackIcon />} onClick={onBack} />
      ) : (
        lead
      )}
      <h1 className="m-top-title t-block">{title}</h1>
      <div className="m-top-end">{end}</div>
    </header>
  );
}
