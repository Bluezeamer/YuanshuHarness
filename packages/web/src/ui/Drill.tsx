import type { ReactNode } from "react";
import { IconButton } from "./Button";
import { BackIcon } from "./icons";

// 弹窗里的二级页：摘要行点进去换成这一页，左上角返回。工作区 / 会话弹窗、添加变量弹窗共用。
export function Drill({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="u-drill">
      <div className="u-drill-head">
        <IconButton
          label="返回"
          icon={<BackIcon aria-hidden />}
          onClick={onBack}
        />
        <span className="t-block">{title}</span>
      </div>
      <div className="u-drill-body">{children}</div>
    </div>
  );
}
