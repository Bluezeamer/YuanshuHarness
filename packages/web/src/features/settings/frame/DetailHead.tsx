import type { ReactNode } from "react";
import { Dot, type DotProps } from "../../../ui";

/**
 * 主从页详情头：图标块 + 名字与一行说明 + 状态 + 主操作与「⋯」。
 * 远程连接、工具与能力、供应商三个页同一个版式；图标块里放图标或两个字母。
 */
export function DetailHead({
  icon,
  title,
  sub,
  status,
  actions,
}: {
  icon: ReactNode;
  title: string;
  sub: ReactNode;
  status: {
    text: string;
    tone: NonNullable<DotProps["tone"]>;
    motion?: DotProps["motion"];
  };
  actions: ReactNode;
}) {
  return (
    <header className="st-dh">
      <span className="st-dh-tile" aria-hidden="true">
        {icon}
      </span>
      <div className="st-dh-text">
        <span className="t-block">{title}</span>
        <span className="t-aux st-dh-sub">{sub}</span>
      </div>
      <span className="st-dh-status t-aux">
        <Dot tone={status.tone} motion={status.motion} />
        {status.text}
      </span>
      {actions}
    </header>
  );
}
