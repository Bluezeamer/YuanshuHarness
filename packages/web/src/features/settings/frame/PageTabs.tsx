import { Tabs, type TabsProps } from "../../../ui";

/**
 * 页签条（ys-ui-design 的 X04）：线通栏，文字缩进到页面留白，所有设置页同一个 x。
 * 切页签前用 `useLeaveGuard()` 的 guard 包一层 `onChange`（有未保存修改时先问）。
 */
export function PageTabs(props: TabsProps) {
  return (
    <div className="st-strip">
      <Tabs {...props} />
    </div>
  );
}
