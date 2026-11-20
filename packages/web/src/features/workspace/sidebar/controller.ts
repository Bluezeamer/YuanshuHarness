// 左轨的控制器：展示组件（Sidebar 及其零件）只认这个接口。
// 真左轨由 useSidebarController 用库数据实现，样张（gallery）用静态数据实现同一个接口。

import type { DragEvent, MouseEvent } from "react";
import type { RemovalPreview } from "../../../api/workspaces";
import type { Agg, Group, Section, Sess, Ws } from "./model";

/** 「已归档工作区」栏在 archivedOpen 里用的键 */
export const ARCHIVED_WORKSPACES = "@archived-workspaces";

export interface MenuAt {
  x: number;
  y: number;
  kind: "session" | "workspace";
  id: string;
}

export type Confirm =
  | { kind: "workspace"; ws: Ws; preview: RemovalPreview | null }
  | { kind: "session"; list: Sess[]; derived: number }
  /** 解散分组：里面的工作区回到未分组，工作区本身不动 */
  | { kind: "group"; group: Group; count: number };

export interface Selection {
  kind: "session" | "workspace";
  ids: readonly string[];
}

/** 工作区拖拽的落点：放进某个分组（null = 未分组）的最后，或插到另一个工作区前面 */
export type WsDropTarget = { group: string | null } | { before: string };

/** 展示用的拖拽态：被拖的会话 / 工作区、工作区正悬在哪个落点上 */
export interface DragView {
  session?: string;
  workspace?: string;
  over?: WsDropTarget;
}

/** 起名 / 改名弹窗的描述；submit 时给的是去掉首尾空白后的非空名字 */
export interface NameDialogSpec {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  maxLength?: number;
  onSubmit(name: string): void;
}

/** 壳里渲染的弹窗：工作区（新建 / 编辑）与会话（新建带配置 / 以此配置新建 / 设置） */
export type DialogSpec =
  | { kind: "workspace"; mode: "create" }
  | { kind: "workspace"; mode: "edit"; workspaceId: string }
  | { kind: "session"; mode: "create"; workspaceId: string }
  | {
      kind: "session";
      mode: "from" | "edit";
      workspaceId: string;
      sessionId: string;
    };

/** 编辑分组（名称 + 颜色）弹窗的描述 */
export interface GroupDialogSpec {
  name: string;
  /** 分组色序号 0..6 */
  tone: number;
  onSubmit(name: string, tone: number): void;
}

export interface SidebarController {
  // ── 数据 ──
  /** 全部工作区（未按搜索过滤） */
  workspaces: readonly Ws[];
  /** 按搜索过滤、按分组分好区的工作区 */
  sections: readonly Section[];
  /** 已归档的工作区（只是不显示，收在列表底部） */
  archivedWorkspaces: readonly Ws[];
  /** 搜索后某个工作区里要显示的会话（含已归档，由块自己分开） */
  shown(w: Ws): readonly Sess[];
  aggOf(w: Ws): Agg;
  /** 库数据还没到 */
  loading: boolean;

  // ── 状态 ──
  query: string;
  setQuery(q: string): void;
  currentWorkspace: string | null;
  currentSession: string | null;
  /** 窗格里正在显示的会话 */
  viewing: ReadonlySet<string>;
  open: ReadonlySet<string>;
  toggleOpen(id: string): void;
  /** 某个工作区底部的「已归档会话」是否展开；键为 ARCHIVED_WORKSPACES 时指「已归档工作区」那一栏 */
  archivedOpen: ReadonlySet<string>;
  toggleArchived(id: string): void;
  groupClosed: ReadonlySet<string>;
  toggleGroup(id: string): void;
  selection: Selection | null;
  clearSelection(): void;
  menu: MenuAt | null;
  /** 在没选中的行上右键会先清掉原来的选择：菜单只对这一行；在选中的行上右键，菜单就是对整个选择的批量操作 */
  setMenu(m: MenuAt | null): void;
  nameDialog: NameDialogSpec | null;
  closeNameDialog(): void;
  groupDialog: GroupDialogSpec | null;
  closeGroupDialog(): void;
  confirm: Confirm | null;
  confirmError: string | null;
  confirmBusy: boolean;
  doConfirm(): void;
  closeConfirm(): void;
  drag?: DragView;

  // ── 动作 ──
  /** 单击：临时查看；ctrl/⌘ 加选、shift 区间选 */
  pickSession(id: string, ev: MouseEvent): void;
  /** 双击：固定 */
  pinSession(id: string): void;
  /** 会话行开始 / 结束拖拽：拖进主区窗格，落点处放它的对话标签 */
  dragSession(e: DragEvent, id: string): void;
  dragEnd(): void;
  /** 工作区头开始拖；悬停在某个落点上（null = 离开）；放下 */
  dragWorkspace(e: DragEvent, id: string): void;
  dragOver(target: WsDropTarget | null): void;
  dropWorkspace(target: WsDropTarget): void;
  pickWorkspace(id: string, ev: MouseEvent): void;
  newWorkspace(): void;
  openSettings(): void;
  /** 打开「会话总览」（目前是命令面板里的会话列表） */
  openOverview(): void;
  /** 直接按工作区的默认配置建一个并打开，不弹窗 */
  newSession(workspaceId: string): void;
  /** 带配置新建：弹窗里逐项改了再建 */
  newSessionWith(workspaceId: string): void;
  editWorkspace(id: string): void;
  sessionSettings(id: string): void;
  newSessionFrom(id: string): void;
  refreshContext(sessionId: string): void;
  archiveSessions(ids: readonly string[]): void;
  restoreSessions(ids: readonly string[]): void;
  /** 置顶 / 取消置顶（排在同级之前）；与 pinSession（把临时标签固定下来）不是一回事 */
  setSessionPinned(id: string, pinned: boolean): void;
  setWorkspacePinned(id: string, pinned: boolean): void;
  archiveWorkspaces(ids: readonly string[], archived: boolean): void;
  askRemoveSessions(ids: readonly string[]): void;
  /** 多个工作区逐个确认（每个都要看它自己的影响范围） */
  askRemoveWorkspaces(ids: readonly string[]): void;
  renameSession(id: string): void;
  renameWorkspace(id: string): void;
  joinGroup(workspaceIds: readonly string[], groupId: string | null): void;
  newGroup(workspaceIds: readonly string[]): void;
  editGroup(id: string): void;
  /** 解散分组：先弹确认 */
  askRemoveGroup(id: string): void;
  groups: readonly { id: string; name: string }[];

  // ── 仅样张用 ──
  /** 收起态下强制展开某个工作区的浮层 */
  flyOpen?: string | null;
}
