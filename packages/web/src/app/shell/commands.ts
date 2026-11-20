// 命令面板的动作清单与过滤：纯函数，与 React 解耦。
// 分类与顺序：操作 / 窗口 / 视图 / 设置 / 工作区 / 会话。
// 「工作区」「会话」都跨工作区：不搜索时只列最近的几个工作区，搜索才能找到全部工作区与会话。
import type { LibrarySession } from "../../api/sessionLibrary";
import type { Workspace } from "../../api/workspaces";

export type CommandKind =
  | "action"
  | "window"
  | "view"
  | "settings"
  | "workspace"
  | "session";

/** 分类的显示名（面板里的组标题，也参与搜索）。 */
export const KIND_LABEL: Record<CommandKind, string> = {
  action: "操作",
  window: "窗口",
  view: "视图",
  settings: "设置",
  workspace: "工作区",
  session: "会话",
};

const ORDER: readonly CommandKind[] = [
  "action",
  "window",
  "view",
  "settings",
  "workspace",
  "session",
];

/** 不搜索时列出的最近工作区个数 */
export const RECENT_WORKSPACES = 6;

export interface PaletteCommand {
  id: string;
  kind: CommandKind;
  label: string;
  /** 右侧快捷键提示，纯展示 */
  key?: string;
  /** 右侧的一小段说明（会话属于哪个工作区、工作区有几个对话），纯展示 */
  note?: string;
  /** 过滤时除 label 之外也匹配的文字（工作区的目录路径） */
  also?: string;
  run(): void;
}

export interface SettingsEntry {
  path: string;
  label: string;
}

export interface CommandSources {
  hasFocusSession: boolean;
  /** 全部工作区里的会话（含已归档） */
  sessions: readonly LibrarySession[];
  workspaces: readonly Workspace[];
  settings: readonly SettingsEntry[];
  act: {
    newSession(): void;
    newSessionWith(): void;
    newWorkspace(): void;
    newWindow(): void;
    nextWindow(): void;
    toggleRail(): void;
    openOverview(): void;
    selectWorkspace(id: string): void;
    selectSession(id: string): void;
    openSettings(path: string): void;
  };
}

export function buildCommands(src: CommandSources): PaletteCommand[] {
  const { act } = src;
  const out: PaletteCommand[] = [
    {
      id: "new",
      kind: "action",
      label: "新建会话",
      key: "Ctrl+N",
      run: act.newSession,
    },
    {
      id: "new-with",
      kind: "action",
      label: "新建会话（带配置）…",
      run: act.newSessionWith,
    },
    {
      id: "new-ws",
      kind: "action",
      label: "新建工作区…",
      run: act.newWorkspace,
    },
  ];
  if (src.hasFocusSession) {
    out.push(
      {
        id: "win-new",
        kind: "window",
        label: "新建窗口",
        key: "Ctrl+Shift+N",
        run: act.newWindow,
      },
      {
        id: "win-next",
        kind: "window",
        label: "依次切换窗口",
        key: "Ctrl+1…6",
        run: act.nextWindow,
      },
    );
  }
  out.push(
    {
      id: "rail",
      kind: "view",
      label: "折叠 / 展开会话栏",
      key: "Ctrl+\\",
      run: act.toggleRail,
    },
    {
      id: "overview",
      kind: "view",
      label: "打开会话总览",
      key: "Ctrl+Shift+O",
      run: act.openOverview,
    },
  );
  for (const s of src.settings)
    out.push({
      id: `set-${s.path}`,
      kind: "settings",
      label: `设置 · ${s.label}`,
      run: () => act.openSettings(s.path),
    });
  for (const w of recentFirst(src.workspaces, src.sessions))
    out.push({
      id: `ws-${w.id}`,
      kind: "workspace",
      label: w.name,
      note: w.sessionCount > 0 ? `${w.sessionCount} 个对话` : "还没有对话",
      also: w.directories.map((d) => d.path).join(" "),
      run: () => act.selectWorkspace(w.id),
    });
  const names = new Map(src.workspaces.map((w) => [w.id, w.name] as const));
  for (const s of src.sessions)
    out.push({
      id: `ses-${s.id}`,
      kind: "session",
      label: s.title,
      ...(s.workspaceId && names.get(s.workspaceId)
        ? { note: names.get(s.workspaceId) as string }
        : {}),
      run: () => act.selectSession(s.id),
    });
  return out;
}

/** 未归档的工作区，最近有动静的在前：看它名下未归档会话的最近更新，没有会话就看工作区自己。 */
function recentFirst(
  workspaces: readonly Workspace[],
  sessions: readonly LibrarySession[],
): Workspace[] {
  const last = new Map<string, number>();
  for (const s of sessions) {
    if (!s.workspaceId || s.lifecycle === "archived") continue;
    last.set(
      s.workspaceId,
      Math.max(last.get(s.workspaceId) ?? 0, Date.parse(s.updatedAt) || 0),
    );
  }
  const at = (w: Workspace) => last.get(w.id) ?? (Date.parse(w.updatedAt) || 0);
  return workspaces.filter((w) => !w.archived).sort((a, b) => at(b) - at(a));
}

/**
 * 按 label、附带文字与分类做子串过滤（不分大小写）。
 * 空查询：工作区只留最近 RECENT_WORKSPACES 个（buildCommands 已按最近排好），会话一个都不列；
 * 有查询：全部工作区与会话都能搜到。
 */
export function filterCommands(
  list: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    let workspaces = 0;
    return list.filter((c) =>
      c.kind === "session"
        ? false
        : c.kind !== "workspace" || ++workspaces <= RECENT_WORKSPACES,
    );
  }
  return list.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      c.also?.toLowerCase().includes(q) ||
      KIND_LABEL[c.kind].includes(q),
  );
}

/** 按分类分组，组序固定为 CommandKind 的声明顺序（lead 指定的那一类排最前），组内保持原序 */
export function groupCommands(
  list: readonly PaletteCommand[],
  lead?: CommandKind,
): { kind: CommandKind; items: PaletteCommand[] }[] {
  const order = lead ? [lead, ...ORDER.filter((k) => k !== lead)] : ORDER;
  return order
    .map((kind) => ({ kind, items: list.filter((c) => c.kind === kind) }))
    .filter((g) => g.items.length > 0);
}
