// 目录布局模型的类型（对应 IMPLEMENTATION.md §5.9）。
// 约定：可能被拒绝的操作返回 Result；不可能失败的纯变换/查询直接返回值。

import type { Tree } from "../../../ui/tiling/tree";
import type { TabType } from "./tabKinds";

/** 主机 id；'server' 表示 daemon 所在机器 */
export type HostId = string;

// ── L2：窗口 → 窗格树 → 标签 ──

export type { TabType } from "./tabKinds";

export interface TabAfx {
  /** 右侧状态的子代理块：看「全部」而不是「现状」 */
  subAll?: boolean;
  /** 展开了「已结束 N 个」的父节点 id */
  subOpen?: string[];
  /** 看过的失败子代理 id（没看过的失败不折叠） */
  subSeen?: string[];
  filter?: string;
  mode?: "struct" | "json";
  q?: string;
  /** 审计左栏宽度 */
  w?: number;
  /** 审计详情里折叠的段 */
  fold?: Record<string, boolean>;
  /**
   * canvas 标签的浏览历史：每一条是 `board:<画布名>` 或 `note:<笔记路径>`，at 是当前条目的下标。
   * 标签在窗格里切走会卸载，历史与当前打开的是画布还是笔记只能靠它还原（刷新页面也一样）
   */
  cv?: { stack: string[]; at: number };
}

export interface Tab {
  id: string;
  type: TabType;
  /** 仅 chat 标签使用：对话 / 审计 */
  ctab?: "chat" | "audit";
  /** chat、sub、job 标签所属会话；preview 的轮末 diff 形态也带（哪个会话的哪一轮） */
  sid?: string;
  /** 临时标签（chat 与 preview）：单击会话行 / 文件行替换它，界面标题用斜体；双击固定 */
  temp?: boolean;
  /** sub 标签对应的执行体 */
  sub?: string;
  /** job 标签对应的后台任务（属于 sid 那个会话） */
  job?: string;
  /** 带主机的标签（term/files/preview/canvas）所在主机；对话、执行体、浏览器没有 */
  host?: HostId;
  cwd?: string;
  /** files / preview 的路径；canvas 标签是它所在的目录（画布在这个目录的 .canvas/ 下） */
  path?: string;
  /** canvas 标签当前打开的画布名 */
  canvas?: string;
  /** preview 标签的另一种形态：显示改动 diff。
   *  turn 有值 = 某一轮的改动（轮末卡片点文件名打开）；turn 为 null = 工作区 vs HEAD（git 面板打开）；
   *  team 为 true = 团队建队以来的改动（右侧状态的团队块打开，属于 sid 那个会话的团队） */
  diff?: { turn: number | null; path: string; team?: true };
  /** web 标签当前显示的浏览器页面 id（浏览器跟工作区走，标签只记它此刻看哪一页） */
  page?: string;
  /** 扩展：服务端终端 id。刷新/重开后凭它接回同一终端（终端生命周期 R3/R5） */
  termId?: string;
  /** 扩展：termId 对应的终端已不存在（服务端 404）。保留 termId 以便展示，不自动新建 */
  termEnded?: boolean;
  afx?: TabAfx;
}

export interface Pane {
  pid: string;
  /** 窗格绑定的主机；只含对话类标签时为 null */
  host: HostId | null;
  tabs: Tab[];
  /** 当前标签 id */
  active: string;
}
export type L2Node = Tree<Pane>;

export interface Window {
  id: string;
  root: L2Node;
  /** 聚焦窗格 pid */
  focus: string;
}

export interface WindowState {
  list: Window[];
  /** 当前窗口下标 */
  active: number;
}

/** 按容器 id 存放的窗口状态。现在容器就是工作区、一份布局里只有一个键；l2move 的函数仍以它为参 */
export type WinMap = Record<string, WindowState>;

// ── Result ──

export type FailCode =
  | "not-found"
  | "invalid"
  | "limit"
  | "last"
  | "cross-session"
  | "host-conflict"
  | "too-new";

export type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: FailCode;
      /** 面向用户的中文说明，主机以 id 表示；UI 可按 code/hosts 换成主机名 */
      error: string;
      /** host-conflict 时给出 [窗格主机, 标签主机] */
      hosts?: [HostId, HostId];
    };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = <T = never>(
  code: FailCode,
  error: string,
  hosts?: [HostId, HostId],
): Result<T> =>
  hosts ? { ok: false, code, error, hosts } : { ok: false, code, error };
