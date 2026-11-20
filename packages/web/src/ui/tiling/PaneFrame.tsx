// 平铺布局里的一格：头（调用方给，通常是标签条）+ 内容 + 六个落点叠层。
// 拖放的判定与处理由调用方做（通过 zone / blocked 告诉这里亮哪一块、哪些不可用）；
// 事件、data-*、style 都经 ...rest 落到 <section> 上。

import type { ComponentProps, ReactNode } from "react";
import { cx } from "../cx";
import { DROP_ZONES, type DropZone } from "./zones";

export interface PaneFrameProps
  extends Omit<ComponentProps<"section">, "children"> {
  head: ReactNode;
  children: ReactNode;
  /** 是否为焦点格：非焦点格的当前标签顶线退成灰色；不传则不区分 */
  focused?: boolean;
  /** 指针所在的落点；null = 没有拖拽经过 */
  zone: DropZone | null;
  /** 某个落点是否不可用（画成虚线，文案换成 blockedLabel） */
  blocked?(z: DropZone): boolean;
  zoneLabel(z: DropZone): string;
  blockedLabel: string;
}

export function PaneFrame({
  head,
  children,
  focused,
  zone,
  blocked,
  zoneLabel,
  blockedLabel,
  className,
  ...rest
}: PaneFrameProps) {
  return (
    <section
      className={cx("u-pane", className)}
      data-focus={focused}
      data-dz={zone ?? undefined}
      {...rest}
    >
      {head}
      <div className="u-pane-body">{children}</div>
      {DROP_ZONES.map((z) => {
        const off = blocked?.(z) === true;
        return (
          <div
            key={z}
            className="u-dz"
            data-z={z}
            data-off={off || undefined}
            aria-hidden="true"
          >
            <span className="t-aux">{off ? blockedLabel : zoneLabel(z)}</span>
          </div>
        );
      })}
    </section>
  );
}
