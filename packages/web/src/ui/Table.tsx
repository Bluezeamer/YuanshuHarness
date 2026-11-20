import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

export type TableProps = Omit<ComponentProps<"table">, "children"> & {
  // 每列的百分比宽度，如 ["30%", "20%", "50%"]；表格始终贴合容器，不设 min-width
  widths: ReadonlyArray<string>;
  // 表格没有可见标题时仍需要一个读屏名
  caption: string;
  children: ReactNode;
};

export function Table({
  widths,
  caption,
  className,
  children,
  ...rest
}: TableProps) {
  return (
    <div className="u-tblwrap">
      <table className={cx("u-tbl", className)} {...rest}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {widths.map((w, i) => (
            // 列宽是位置性的，没有稳定 id
            // biome-ignore lint/suspicious/noArrayIndexKey: colgroup 的列只按位置对应
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        {children}
      </table>
    </div>
  );
}

export type ThProps = Omit<ComponentProps<"th">, "align"> & {
  align?: "start" | "end";
};

export function Th({ align = "start", className, ...rest }: ThProps) {
  return (
    <th
      scope="col"
      data-align={align}
      className={cx("u-th t-group", className)}
      {...rest}
    />
  );
}

export type TdProps = Omit<ComponentProps<"td">, "align"> & {
  align?: "start" | "end";
  // 单行省略：地址、包名、工具名等过长内容在行内截断，展开区再给完整值
  truncate?: boolean;
  mono?: boolean;
};

export function Td({
  align = "start",
  truncate = false,
  mono = false,
  className,
  ...rest
}: TdProps) {
  return (
    <td
      data-align={align}
      data-truncate={truncate || undefined}
      data-mono={mono || undefined}
      className={cx("u-td", mono ? "t-mono" : "t-plain", className)}
      {...rest}
    />
  );
}

export type DetailRowProps = {
  colSpan: number;
  children: ReactNode;
};

// 展开区整行。表格最后一列常是右对齐，detail 必须显式还原左对齐，样式里已处理。
export function DetailRow({ colSpan, children }: DetailRowProps) {
  return (
    <tr className="u-tr-detail">
      <td colSpan={colSpan}>{children}</td>
    </tr>
  );
}
