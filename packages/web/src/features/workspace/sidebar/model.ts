// 左轨的展示模型：与库数据（api/）解耦的最小形状，加上把库数据映射过来的纯函数。
// 样张用静态数据直接构造这些类型，真左轨用 toWorkspace / toSession 从服务端数据映射。

import type { LibrarySession } from "../../../api/sessionLibrary";
import type { Workspace, WorkspaceDirectory } from "../../../api/workspaces";
import { fmtDateTime } from "../../../ui/time";

export type Status = "running" | "blocked" | "idle";

export interface Sess {
  id: string;
  title: string;
  status: Status;
  unread?: "result" | "error";
  /** fork 的父会话；左轨里缩进挂在父会话下 */
  parent?: string;
  /** 相对时间拆成数字与中文两段：数字用等宽字，中文用辅助字（ys-ui-design 的 typography §2） */
  ago: [n: string, unit: string];
  archived?: boolean;
  /** 置顶：排在同级会话之前 */
  pinned?: boolean;
  // 以下只给悬停卡片用（样张可以不填）
  /** 展示编号（井号加四位数字） */
  no?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 所在目录；远程目录带主机名前缀 */
  dir?: string;
}

export interface Ws {
  id: string;
  name: string;
  /** 主目录；远程主目录带主机名前缀 */
  path: string;
  extraDirs?: number;
  group: string | null;
  /** 置顶：排在同一分组内其余工作区之前 */
  pinned?: boolean;
  sessions: Sess[];
  // 以下只给悬停卡片用（样张可以不填）
  description?: string;
  /** 全部目录，主目录在前；远程目录带主机名前缀 */
  dirs?: string[];
  createdAt?: string;
}

export interface Group {
  id: string;
  name: string;
  /** 分组色序号（服务端 tone 0..6） */
  tone: number;
}

export interface Section {
  group: Group | null;
  list: Ws[];
}

export interface Agg {
  blocked: number;
  running: number;
  /** 顶层会话数（不含已归档） */
  total: number;
  unread: "error" | "result" | null;
}

export const EMPTY_AGG: Agg = {
  blocked: 0,
  running: 0,
  total: 0,
  unread: null,
};

// 工作区卡片的聚合：最紧急的状态 + 计数；折叠时也靠它亮起来。
export function aggregate(sessions: readonly Sess[]): Agg {
  const live = sessions.filter((s) => !s.archived);
  const marks = live.flatMap((s) => (s.unread ? [s.unread] : []));
  return {
    blocked: live.filter((s) => s.status === "blocked").length,
    running: live.filter((s) => s.status === "running").length,
    total: live.length,
    unread: marks.includes("error")
      ? "error"
      : marks.includes("result")
        ? "result"
        : null,
  };
}

export const mergeAgg = (aggs: readonly Agg[]): Agg => ({
  blocked: aggs.reduce((n, a) => n + a.blocked, 0),
  running: aggs.reduce((n, a) => n + a.running, 0),
  total: aggs.reduce((n, a) => n + a.total, 0),
  unread: aggs.some((a) => a.unread === "error")
    ? "error"
    : aggs.some((a) => a.unread === "result")
      ? "result"
      : null,
});

export const initialOf = (name: string): string =>
  [...name][0]?.toUpperCase() ?? "?";

export interface TreeNode {
  s: Sess;
  kids: Sess[];
}

/** 置顶的排前面，其余保持原顺序（稳定分区） */
const pinnedFirst = <T extends { pinned?: boolean }>(
  list: readonly T[],
): T[] => [...list.filter((x) => x.pinned), ...list.filter((x) => !x.pinned)];

// 顶层会话按原顺序排、置顶的在前；fork 挂在父会话下，父会话不在这一批里（已归档、已删）就升为顶层。
export function treeOf(list: readonly Sess[]): TreeNode[] {
  const ids = new Set(list.map((s) => s.id));
  return pinnedFirst(list.filter((s) => !s.parent || !ids.has(s.parent))).map(
    (s) => ({ s, kids: list.filter((k) => k.parent === s.id) }),
  );
}

/** 按树的显示顺序排平（顶层，紧跟它的 fork）：shift 区间选择用 */
export const flatOrder = (list: readonly Sess[]): Sess[] =>
  treeOf(list).flatMap((n) => [n.s, ...n.kids]);

// ---- 搜索与分区 ----

const has = (text: string, needle: string) =>
  text.toLowerCase().includes(needle);

/** 搜索：工作区名或路径命中就整个显示，否则只留标题命中的会话；一个都不命中的工作区藏起来 */
export function filterWorkspaces(
  workspaces: readonly Ws[],
  query: string,
): { list: Ws[]; shown: Map<string, Sess[]> } {
  const needle = query.trim().toLowerCase();
  const shown = new Map<string, Sess[]>();
  const list: Ws[] = [];
  for (const w of workspaces) {
    const whole = needle === "" || has(w.name, needle) || has(w.path, needle);
    const sessions = whole
      ? w.sessions
      : w.sessions.filter((s) => has(s.title, needle));
    if (whole || sessions.length > 0) {
      list.push(w);
      shown.set(w.id, sessions);
    }
  }
  return { list, shown };
}

/** 按分组分区：组的顺序照传入的 groups，没有分组的工作区放最后；每区里置顶的在前；空区丢掉 */
export function sectionsOf(
  workspaces: readonly Ws[],
  groups: readonly Group[],
): Section[] {
  return [
    ...groups.map((g) => ({
      group: g,
      list: pinnedFirst(workspaces.filter((w) => w.group === g.id)),
    })),
    {
      group: null,
      list: pinnedFirst(workspaces.filter((w) => w.group === null)),
    },
  ].filter((s) => s.list.length > 0);
}

// ---- 从库数据映射 ----

/** 相对时间：刚刚 / N 分钟 / N 小时 / N 天 / 月-日（数字等宽、中文辅助字，所以拆两段） */
export function agoOf(iso: string, now: number): Sess["ago"] {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return ["", ""];
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return ["", "刚刚"];
  if (s < 3600) return [String(Math.floor(s / 60)), "分钟"];
  if (s < 86400) return [String(Math.floor(s / 3600)), "小时"];
  if (s < 30 * 86400) return [String(Math.floor(s / 86400)), "天"];
  const d = new Date(t);
  return [`${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`, ""];
}

export function toSession(s: LibrarySession, now: number, dir?: string): Sess {
  return {
    id: s.id,
    title: s.title,
    status:
      s.status === "running" || s.status === "blocked" ? s.status : "idle",
    ...(s.unreadError
      ? { unread: "error" as const }
      : s.unreadResult
        ? { unread: "result" as const }
        : {}),
    ...(s.parentSessionId ? { parent: s.parentSessionId } : {}),
    ago: agoOf(s.updatedAt, now),
    ...(s.lifecycle === "archived" ? { archived: true } : {}),
    ...(s.pinned ? { pinned: true } : {}),
    ...(s.no ? { no: s.no } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(dir ? { dir } : {}),
  };
}

const STATUS_TEXT: Record<Status, string> = {
  running: "执行中",
  blocked: "等你处理",
  idle: "待命",
};

const UNREAD_TEXT = { result: "有新结果", error: "出错了，还没看" } as const;

/** 悬停卡片的键值对：行里放不下的事实；没有的字段不列。parentTitle 只有 fork 才给。 */
export function peekFacts(s: Sess, parentTitle?: string): [string, string][] {
  const status = s.archived
    ? "已归档"
    : [STATUS_TEXT[s.status], s.unread && UNREAD_TEXT[s.unread]]
        .filter(Boolean)
        .join(" · ");
  const rows: [string, string | undefined][] = [
    ["状态", status],
    ["目录", s.dir],
    [
      "来源",
      parentTitle === undefined ? undefined : `从「${parentTitle}」分出`,
    ],
    ["创建于", fmtDateTime(s.createdAt)],
    ["最近活动", fmtDateTime(s.updatedAt)],
    ["编号", s.no],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]);
}

/** 路径太长时留末两段：项目名比前缀更要紧 */
export function shortPath(path: string, max = 30): string {
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  return `…/${parts.slice(-2).join("/")}`;
}

/** 工作区悬停卡片的键值对：行里放不下的事实；没有的字段不列。agg 与行上的状态点同源。 */
export function workspaceFacts(ws: Ws, agg: Agg): [string, string][] {
  const archived = ws.sessions.filter((s) => s.archived).length;
  const [main, ...extra] = ws.dirs ?? (ws.path ? [ws.path] : []);
  const counts =
    agg.total + archived === 0
      ? "还没有对话"
      : [
          `${agg.total} 个`,
          agg.running > 0 && `${agg.running} 个执行中`,
          agg.blocked > 0 && `${agg.blocked} 个等你处理`,
          archived > 0 && `${archived} 个已归档`,
        ]
          .filter(Boolean)
          .join(" · ");
  const last = ws.sessions.reduce<string | undefined>(
    (a, s) =>
      s.updatedAt && (!a || Date.parse(s.updatedAt) > Date.parse(a))
        ? s.updatedAt
        : a,
    undefined,
  );
  const rows: [string, string | undefined][] = [
    ["对话", counts],
    [extra.length > 0 ? "主目录" : "目录", main],
    ...extra.map((d, i): [string, string] => [
      extra.length > 1 ? `附加目录 ${i + 1}` : "附加目录",
      d,
    ]),
    ["创建于", fmtDateTime(ws.createdAt)],
    ["最近活动", fmtDateTime(last)],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]);
}

export function toWorkspace(
  w: Workspace,
  sessions: readonly LibrarySession[],
  now: number,
  hostName: (environmentId: string) => string,
): Ws {
  const [main] = w.directories;
  const labelOf = (d: WorkspaceDirectory) =>
    d.environmentId === "local"
      ? d.path
      : `${hostName(d.environmentId)}:${d.path}`;
  const path = main ? labelOf(main) : "";
  return {
    id: w.id,
    name: w.name,
    path,
    ...(w.directories.length > 1
      ? { extraDirs: w.directories.length - 1 }
      : {}),
    group: w.groupId,
    ...(w.pinned ? { pinned: true } : {}),
    ...(w.description ? { description: w.description } : {}),
    dirs: w.directories.map(labelOf),
    createdAt: w.createdAt,
    sessions: sessions.map((s) => {
      const d = w.directories.find((x) => x.id === s.directoryId);
      return toSession(s, now, d && labelOf(d));
    }),
  };
}
