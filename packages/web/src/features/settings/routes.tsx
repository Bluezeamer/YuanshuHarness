import {
  BlocksIcon,
  DefaultsIcon,
  GlobeIcon,
  PhoneIcon,
  ProvidersIcon,
  RemoteIcon,
  ToolsIcon,
  VariablesIcon,
} from "../../ui/icons";
import { BrowserPage } from "./browser/BrowserPage";
import { DefaultsPage } from "./defaults/DefaultsPage";
import { DevicesPage } from "./devices/DevicesPage";
import type { SettingsRoute } from "./frame/types";
import { ProvidersPage } from "./providers/ProvidersPage";
import { RemotePage } from "./remote/RemotePage";
import { StudioPage } from "./studio/StudioPage";
import { ToolsPage } from "./tools/ToolsPage";
import { VariablesPage } from "./variables/VariablesPage";

/**
 * 设置页注册表，顺序即左导航顺序。
 * 新增一个设置页：在 features/settings/<page>/ 写 `XxxPage`，然后在这里追加一项，
 * 并在 index.ts 里引入它的 css。壳、导航、路由不用动。
 */
export const settingsRoutes: SettingsRoute[] = [
  {
    path: "providers",
    label: "供应商与模型",
    icon: ProvidersIcon,
    element: <ProvidersPage />,
  },
  {
    path: "remote",
    label: "远程连接",
    icon: RemoteIcon,
    element: <RemotePage />,
  },
  {
    path: "variables",
    label: "隐私变量",
    icon: VariablesIcon,
    element: <VariablesPage />,
  },
  {
    path: "tools",
    label: "工具与能力",
    icon: ToolsIcon,
    element: <ToolsPage />,
  },
  {
    path: "browser",
    label: "浏览器",
    icon: GlobeIcon,
    element: <BrowserPage />,
  },
  {
    path: "studio",
    label: "提示词与能力",
    icon: BlocksIcon,
    element: <StudioPage />,
  },
  {
    path: "devices",
    label: "手机设备",
    icon: PhoneIcon,
    element: <DevicesPage />,
  },
  {
    path: "defaults",
    label: "默认值设置",
    icon: DefaultsIcon,
    element: <DefaultsPage />,
  },
];
