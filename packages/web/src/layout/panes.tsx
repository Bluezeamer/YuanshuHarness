import { type AuditConfig, AuditPane } from "../panes/AuditPane";
import {
  type BrowserLiveConfig,
  BrowserLivePane,
} from "../panes/BrowserLivePane";
import {
  type FileDiscoveryConfig,
  FileDiscoveryPane,
} from "../panes/FileDiscoveryPane";
import {
  type FilePreviewConfig,
  FilePreviewPane,
} from "../panes/FilePreviewPane";
import { type PdfConfig, PdfPane } from "../panes/PdfPane";
import { type TerminalConfig, TerminalPane } from "../panes/TerminalPane";
import { type WebPreviewConfig, WebPreviewPane } from "../panes/WebPreviewPane";
import { type ChatConfig, ChatPane } from "./ChatPane";
import { Registry } from "./registry";
import { TopologyPane } from "./TopologyPane";
import type { PaneFollow, PaneGroup, PaneImpl, PaneProps } from "./types";

export type { ChatConfig } from "./ChatPane";
export { EnvContext } from "./env";

interface PaneMeta {
  id: string;
  displayName: string;
  group: PaneGroup;
  code: string;
  tabbed: boolean;
  follow: PaneFollow;
}

// 视图类型元数据，对齐 mock 的 VIEWS。类型标识是持久化字符串，写进用户布局后不能改名。
export const PANE_META: PaneMeta[] = [
  {
    id: "chat",
    displayName: "对话",
    group: "会话",
    code: "CH",
    tabbed: false,
    follow: "session",
  },
  {
    id: "terminal",
    displayName: "终端",
    group: "主机",
    code: "SH",
    tabbed: true,
    follow: "host",
  },
  {
    id: "filediscovery",
    displayName: "文件管理器",
    group: "主机",
    code: "FS",
    tabbed: false,
    follow: "host",
  },
  {
    id: "file_preview",
    displayName: "文件预览",
    group: "文档",
    code: "FD",
    tabbed: true,
    follow: "host",
  },
  {
    id: "pdf",
    displayName: "PDF 文档",
    group: "文档",
    code: "PD",
    tabbed: true,
    follow: "none",
  },
  {
    id: "web_preview",
    displayName: "网页预览",
    group: "预览",
    code: "WB",
    tabbed: true,
    follow: "host",
  },
  {
    id: "browser_live",
    displayName: "侧边浏览器",
    group: "预览",
    code: "SB",
    tabbed: false,
    follow: "session",
  },
  {
    id: "audit",
    displayName: "执行审计",
    group: "协作",
    code: "AU",
    tabbed: false,
    follow: "session",
  },
  {
    id: "topology",
    displayName: "协作拓扑",
    group: "协作",
    code: "TP",
    tabbed: false,
    follow: "session",
  },
];

const impl = <C,>(i: PaneImpl<C>) => i as unknown as PaneImpl<never>;

// 接入点：真实面板在这里按类型标识加一项 { component, defaultConfig, configVersion }，
// 组件用 useBound(binding) 取得自己所绑定的会话；没有列在这里的类型显示「待接入」占位。
const IMPLEMENTED: Record<string, PaneImpl<never>> = {
  chat: impl<ChatConfig>({
    component: ChatPane,
    defaultConfig: () => ({ sessionId: null }),
    configVersion: 1,
  }),
  terminal: impl<TerminalConfig>({
    component: TerminalPane,
    defaultConfig: () => ({ label: null }),
    configVersion: 1,
  }),
  filediscovery: impl<FileDiscoveryConfig>({
    component: FileDiscoveryPane,
    defaultConfig: () => ({ environmentId: null, path: null }),
    configVersion: 1,
  }),
  file_preview: impl<FilePreviewConfig>({
    component: FilePreviewPane,
    defaultConfig: () => ({ environmentId: null, path: null }),
    configVersion: 1,
  }),
  pdf: impl<PdfConfig>({
    component: PdfPane,
    defaultConfig: () => ({
      environmentId: null,
      path: null,
      page: 1,
      scale: 1,
    }),
    configVersion: 1,
  }),
  web_preview: impl<WebPreviewConfig>({
    component: WebPreviewPane,
    defaultConfig: () => ({ url: "" }),
    configVersion: 1,
  }),
  browser_live: impl<BrowserLiveConfig>({
    component: BrowserLivePane,
    defaultConfig: () => ({}),
    configVersion: 1,
  }),
  audit: impl<AuditConfig>({
    component: AuditPane,
    defaultConfig: () => ({ kind: null }),
    configVersion: 1,
  }),
  topology: impl<Record<string, never>>({
    component: TopologyPane,
    defaultConfig: () => ({}),
    configVersion: 1,
  }),
};

function Pending({ displayName }: { displayName: string }) {
  return (
    <div
      role="status"
      data-pane-pending
      className="grid h-full place-items-center p-7 text-center text-mute"
    >
      <p>「{displayName}」待接入：依赖的服务端接口尚未合并</p>
    </div>
  );
}

const pending = (displayName: string): PaneImpl<never> => ({
  component: (_: PaneProps<never>) => <Pending displayName={displayName} />,
  defaultConfig: () => ({}) as never,
  configVersion: 1,
});

export function defaultRegistry(): Registry {
  const r = new Registry();
  for (const m of PANE_META)
    r.register({ ...m, ...(IMPLEMENTED[m.id] ?? pending(m.displayName)) });
  return r;
}
