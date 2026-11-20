import type { ComponentType, ReactNode } from "react";

/** 设置页注册表的条目。新增一个设置页 = 在 `settingsRoutes` 里加一项。 */
export interface SettingsRoute {
  /** URL 片段：页面地址是 `/settings/<path>`，单段小写 slug。 */
  path: string;
  /** 左导航上的名字。 */
  label: string;
  icon: ComponentType<{ size?: number }>;
  /** 页面本体（一个 React 元素，例如 `<ProvidersPage />`）。 */
  element: ReactNode;
}
