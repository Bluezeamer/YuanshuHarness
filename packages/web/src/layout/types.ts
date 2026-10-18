// pane 类型注册表与布局文档的类型定义。

export interface PaneType<C = unknown> {
  id: string;
  displayName: string;
  component: React.ComponentType<PaneProps<C>>;
  defaultConfig: () => C;
  configVersion: number;
  migrateConfig?: (old: unknown, fromVersion: number) => C;
}

export interface PaneProps<C = unknown> {
  paneId: string;
  config: C;
  focused: boolean;
  onUpdateConfig: (config: C, configVersion?: number) => void;
}

export interface PaneEntry {
  type: string;
  configVersion: number;
  config: unknown;
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
