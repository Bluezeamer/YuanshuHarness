import type { ReactNode } from "react";
import { IconButton, ListRow, ToastHost } from "../../../ui";
import {
  BackIcon,
  BlocksIcon,
  DefaultsIcon,
  ProvidersIcon,
  RemoteIcon,
  ToolsIcon,
  VariablesIcon,
} from "../../../ui/icons";

const NAV = [
  { id: "providers", label: "供应商与模型", icon: ProvidersIcon },
  { id: "remote", label: "远程连接", icon: RemoteIcon },
  { id: "variables", label: "隐私变量", icon: VariablesIcon },
  { id: "tools", label: "工具与能力", icon: ToolsIcon },
  { id: "studio", label: "提示词与能力", icon: BlocksIcon },
  { id: "defaults", label: "默认值设置", icon: DefaultsIcon },
] as const;

// 对照页里的设置壳：只有外观，导航不跳转；样式就是真壳的（settings/frame/frame.css）。
export function SettingsShell({
  current,
  children,
}: {
  current: (typeof NAV)[number]["id"];
  children: ReactNode;
}) {
  return (
    <div className="st-app" style={{ height: "100%" }}>
      <nav className="st-nav" aria-label="设置">
        <div className="st-nav-h">
          <IconButton label="返回工作区" icon={<BackIcon />} />
          <span className="t-entry">设置</span>
        </div>
        {NAV.map(({ id, label, icon: Icon }) => (
          <ListRow
            key={id}
            label={label}
            lead={<Icon />}
            current={current === id}
          />
        ))}
      </nav>
      <div className="st-main">{children}</div>
      <ToastHost />
    </div>
  );
}
