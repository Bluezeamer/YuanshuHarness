import type { ReactNode } from "react";

// 设置页的版心（ys-ui-design 的 X04）。每一栏自己滚动，页面不再各自写 overflow。

/** 页签条以下的整块区域：占满设置主区，里面的栏自己滚。 */
export const Page = ({ children }: { children: ReactNode }) => (
  <div className="st-page">{children}</div>
);

/** 主从页：左边 RailList，右边详情列。 */
export const SplitPane = ({
  rail,
  children,
}: {
  rail: ReactNode;
  children: ReactNode;
}) => (
  <div className="st-split">
    {rail}
    <div className="st-detail">{children}</div>
  </div>
);

/** 单栏设置 / 详情内容：最宽 720、居中。 */
export const FormColumn = ({ children }: { children: ReactNode }) => (
  <div className="st-form">{children}</div>
);

/**
 * 列表页（卡片、表格）：内容从页面留白起铺满，整页滚动。
 * footer 放在内容之外、滚动区之内：保存条要贴着滚动区底部，不能被内容的底边距顶起来。
 */
export const ListColumn = ({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) => (
  <div className="st-scroll">
    <div className="st-col">{children}</div>
    {footer}
  </div>
);

/** 单栏设置页：居中的表单放在自己的滚动区里，footer（保存条）贴着滚动区底部。 */
export const FormPane = ({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) => (
  <div className="st-scroll">
    <FormColumn>{children}</FormColumn>
    {footer}
  </div>
);
