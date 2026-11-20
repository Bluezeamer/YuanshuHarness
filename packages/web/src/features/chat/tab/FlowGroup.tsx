import { type ReactNode, useState } from "react";
import { ListRow } from "../../../ui";
import { ChevronDownIcon, ChevronRightIcon } from "../../../ui/icons";

// 「+12 −3」：加减行数只靠字色区分，不铺底
export function Delta({ add, del }: { add: number; del: number }) {
  return (
    <span className="t-mono">
      <span className="ch-add">+{add}</span>{" "}
      <span className="ch-del">−{del}</span>
    </span>
  );
}

// 对话流里一组东西的外壳：一圈细线，头是一行摘要，点开是各行。
// auto 是默认状态（出错的组默认展开）；用户点过之后就以用户的为准。
export function FlowGroup({
  label,
  hint,
  trail,
  auto = false,
  children,
}: {
  label: ReactNode;
  /** 收起时跟在标题后面的一小段内容预览（命令、路径）；展开后各行自己就写着，不再重复 */
  hint?: ReactNode;
  trail?: ReactNode;
  auto?: boolean;
  children: ReactNode;
}) {
  const [picked, setPicked] = useState<boolean | null>(null);
  const open = picked ?? auto;
  return (
    <div className="ch-group">
      <ListRow
        size="compact"
        label={
          hint && !open ? (
            <span className="ch-line">
              <span className="ch-glabel">{label}</span>
              <span className="ch-arg t-code">{hint}</span>
            </span>
          ) : (
            <span className="ch-glabel">{label}</span>
          )
        }
        lead={open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        expanded={open}
        trail={trail ? <span className="ch-trail">{trail}</span> : undefined}
        onClick={() => setPicked(!open)}
      />
      {open && children}
    </div>
  );
}
