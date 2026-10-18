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
}

export type TreeNode =
  | { kind: "split"; dir: "h" | "v"; children: TreeNode[]; ratios: number[] }
  | { kind: "leaf"; paneId: string };

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
