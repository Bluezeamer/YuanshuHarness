// 文件拖拽的纯判定：被拖的是什么、落在哪、能不能落。无 React、无 DOM，便于逐条测。
import { isUnder, parentOf } from "./paths";

/** 被拖的一项 */
export interface DragEntry {
  /** 条目的绝对路径 */
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

/** 一次拖拽：同一台主机、同一个目录里的若干条目 */
export interface FileDragItem {
  host: string;
  env: string;
  hostName: string;
  /** 本次拖拽带的条目：拖的是选中项之一时是整个选中集（按列表顺序），否则只有被拖的那一行；至少一项 */
  entries: readonly DragEntry[];
  /** 发起拖拽的标签借用的会话（审计归属用），没有则为 null */
  sessionId: string | null;
  /** 发起拖拽的标签 id（幽灵条只在源标签里渲染） */
  tabId: string;
}

/** 落点：目标主机上的一个目录 */
export interface DropTarget {
  host: string;
  env: string;
  hostName: string;
  dir: string;
  /** 落在哪类元素上：目录行 > 面包屑项 > 列表空白（当前目录） */
  via: "row" | "crumb" | "list";
}

export type Verdict =
  | { ok: false; reason: string }
  | { ok: true; same: boolean; label: string };

export const REASON_SELF = "不能移入自身";
export const REASON_HERE = "已在目标目录";
export const REASON_FILE = "文件不能作为目标";

// 同主机时：目录不能放进自身或它的子目录，已经在目标目录里的不用动；跨主机的路径属于两个不同的文件系统，都能落
function refusal(
  item: FileDragItem,
  e: DragEntry,
  t: DropTarget,
): string | null {
  if (item.host !== t.host) return null;
  if (e.isDir && (t.dir === e.path || isUnder(t.dir, e.path)))
    return REASON_SELF;
  return parentOf(e.path) === t.dir ? REASON_HERE : null;
}

/** 落得下去的条目；批量时拒绝的那几项跳过，其余照常落 */
export const eligible = (item: FileDragItem, t: DropTarget): DragEntry[] =>
  item.entries.filter((e) => refusal(item, e, t) === null);

export function judge(item: FileDragItem, t: DropTarget): Verdict {
  const reasons = item.entries.map((e) => refusal(item, e, t));
  if (reasons.every((r) => r !== null))
    return { ok: false, reason: reasons[0] ?? REASON_HERE };
  const same = item.host === t.host;
  return { ok: true, same, label: same ? "移动" : "传输" };
}

/** 幽灵条右侧的判定文案：`移动到 host:/dir` / `→ host:/dir` / 拒绝原因 */
export function hintText(v: Verdict, t: DropTarget): string {
  if (!v.ok) return v.reason;
  return `${v.same ? "移动到 " : "→ "}${t.hostName}:${t.dir}`;
}
