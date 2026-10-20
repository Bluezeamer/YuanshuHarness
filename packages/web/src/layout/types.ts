// pane 类型注册表与布局文档的类型定义。

// 视图分组（对齐 mock VIEWS）：picker 按组展示，代号用于面板头的小标。
export type PaneGroup = "会话" | "主机" | "文档" | "预览" | "协作";

// follow 语义：session 跟随活动会话；host 跟随活动会话所在主机；none 与会话无关，新建时默认钉住。
export type PaneFollow = "session" | "host" | "none";

export interface PaneType<C = unknown> {
  id: string;
  displayName: string;
  group: PaneGroup;
  code: string;
  // 类型容器：头下带 tab 条，每个 tab 是带独立状态的实例（文件 / URL / 文档 / shell）。
  tabbed: boolean;
  follow: PaneFollow;
  component: React.ComponentType<PaneProps<C>>;
  defaultConfig: () => C;
  configVersion: number;
  migrateConfig?: (old: unknown, fromVersion: number) => C;
}

// 真实面板需要提供的部分；元数据（标识、分组、tabbed、follow）由 panes.tsx 的 META 统一给。
export type PaneImpl<C = unknown> = Pick<
  PaneType<C>,
  "component" | "defaultConfig" | "configVersion" | "migrateConfig"
>;

export type PaneBinding =
  | { mode: "follow" }
  | { mode: "fixed"; sessionId: string | null; host: string | null };

export interface PaneProps<C = unknown> {
  paneId: string;
  config: C;
  focused: boolean;
  binding: PaneBinding;
  onUpdateConfig: (
    config: C,
    configVersion?: number,
    binding?: PaneBinding,
  ) => void;
}

export interface PaneEntry {
  type: string;
  configVersion: number;
  config: unknown;
  // 缺省按 follow：旧文档没有这个字段，不需要迁移。
  binding?: PaneBinding;
  // 用户自定义的 pane 名称；没有时用类型名与会话名。
  name?: string;
}

export type TreeNode =
  | { kind: "split"; dir: "h" | "v"; children: TreeNode[]; ratios: number[] }
  // R9a：有 tabs 时叶子是一个 tab 组，tabs 含组内全部 paneId，paneId 是选中项。
  | { kind: "leaf"; paneId: string; tabs?: string[] };

export interface LayoutWindow {
  id: string;
  name: string;
  tree: TreeNode | null;
}

export interface LayoutDoc {
  version: number;
  windows: LayoutWindow[];
  activeWindowId: string;
  panes: Record<string, PaneEntry>;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
