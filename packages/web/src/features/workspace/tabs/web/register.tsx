import { GlobeIcon } from "../../../../ui/icons";
import { registerTab, tabTypeLabel } from "../registry";
import { WebTab } from "./WebTab";

/** 把 web 标签注册进标签注册表；应用启动时调用一次 */
export function registerWebTab(): void {
  registerTab("web", {
    icon: <GlobeIcon size={11} />,
    title: () => tabTypeLabel("web"),
    render: (props) => <WebTab {...props} />,
  });
}
