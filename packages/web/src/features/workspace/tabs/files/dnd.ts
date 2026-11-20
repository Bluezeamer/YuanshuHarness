// 文件管理器的拖放：整行拖拽（单个条目）、落点判定、同主机移动 / 跨主机传输。
// 拖拽物放在 dndStore 的单例里（kind: "file"），与 layout/drag.ts 的标签/窗格/会话拖拽互不相通：
// 两边的 dragover 在对方没有拖拽物时都直接放行，所以文件行拖过窗格不会触发窗格落点。
import {
  type DragEvent,
  type RefObject,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { FileEntry } from "../../../../api/files";
import { toast } from "../../../../ui";
import { useHostName, useLayoutStore } from "../../layoutContext";
import {
  beginFileDrag,
  endFileDrag,
  getFileDrag,
  IDLE_HINT,
  setHint,
  setHover,
  useFileDrag,
  useHover,
} from "./dndStore";
import type { FileRowProps } from "./FileRow";
import { emitFsChange } from "./fsEvents";
import { moveEntries } from "./move";
import { baseName, joinPath } from "./paths";
import { retargetPreviews } from "./retarget";
import { startTransfer } from "./transfer";
import {
  type DropTarget,
  eligible,
  type FileDragItem,
  hintText,
  judge,
  REASON_FILE,
} from "./verdict";

/** 当前被标记的落点：目录行 / 面包屑段 / 列表空白 */
export type DzMark =
  | { at: "row"; name: string; label: string }
  | { at: "crumb"; path: string; label: string }
  | { at: "list"; label: string };

export type MarkAt =
  | { at: "row"; name: string }
  | { at: "crumb"; path: string }
  | { at: "list" };

/** resolve 的结果：可落的目录，或明确拒绝（文件行） */
export type Resolved =
  | { t: DropTarget; mark: MarkAt }
  | { reject: string }
  | null;

const sameMark = (a: DzMark | null, b: DzMark | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.at === b.at &&
    a.label === b.label &&
    JSON.stringify(a) === JSON.stringify(b));

export interface ResolveArgs {
  host: string;
  env: string;
  hostName: string;
  /** 当前目录的绝对路径 */
  here: string;
  root: RefObject<HTMLElement | null>;
}

/**
 * 落点优先级：目录行 > 面包屑项 > 列表空白（当前目录）；文件行明确拒绝。
 * 内部文件行拖拽与外部系统文件拖入共用这一套判定，区别只在文件行：
 * 内部拖拽不能把文件当目标（fileRow: "reject"），外部拖入落在文件行上按资源管理器的手感落到当前目录（"here"）。
 */
export function resolveDrop(
  el: EventTarget | null,
  args: ResolveArgs,
  fileRow: "reject" | "here" = "reject",
): Resolved {
  const node = el as Element | null;
  const { host, env, hostName, here, root } = args;
  const box = root.current;
  if (!node?.closest || !box) return null;
  const base = { host, env, hostName } as const;
  const row = node.closest<HTMLElement>(".ws-fm-row");
  if (row && box.contains(row) && row.dataset.kind !== "dir") {
    if (fileRow === "reject") return { reject: REASON_FILE };
    return { t: { ...base, dir: here, via: "list" }, mark: { at: "list" } };
  }
  if (row && box.contains(row) && row.dataset.name) {
    const name = row.dataset.name;
    return {
      t: { ...base, dir: joinPath(here, name), via: "row" },
      mark: { at: "row", name },
    };
  }
  const crumb = node.closest<HTMLElement>(".ws-fm-crumb button[data-path]");
  if (crumb && box.contains(crumb) && crumb.dataset.path) {
    return {
      t: { ...base, dir: crumb.dataset.path, via: "crumb" },
      mark: { at: "crumb", path: crumb.dataset.path },
    };
  }
  const list = node.closest(".ws-fm-list");
  if (list && box.contains(list))
    return { t: { ...base, dir: here, via: "list" }, mark: { at: "list" } };
  return null;
}

export interface UseFileDndArgs {
  tabId: string;
  sessionId: string | null;
  host: string;
  env: string;
  /** 当前目录的绝对路径 */
  here: string;
  root: RefObject<HTMLElement | null>;
  /** 多选中的条目（拖其中一个就带整批） */
  selected?: readonly FileEntry[];
}

export function useFileDnd({
  tabId,
  sessionId,
  host,
  env,
  here,
  root,
  selected,
}: UseFileDndArgs) {
  const store = useLayoutStore();
  const hostName = useHostName()(host);
  const item = useFileDrag();
  const [mark, setMark] = useState<DzMark | null>(null);

  // 拖拽被 Esc 取消、在别处结束，或指针移到了别的标签上：本标签的落点标记跟着清掉
  const hover = useHover();
  useEffect(() => {
    if (!item || hover !== tabId) setMark(null);
  }, [item, hover, tabId]);

  /** 落点优先级见 resolveDrop：目录行 > 面包屑项 > 列表空白（当前目录）；文件行明确拒绝 */
  const resolve = useCallback(
    (el: EventTarget | null): Resolved =>
      resolveDrop(el, { host, env, hostName, here, root }),
    [host, env, hostName, here, root],
  );

  /** 目标窗格的主机色（窗格用 --tone 传入）；同主机时不用 */
  const paneTone = () =>
    root.current
      ?.closest<HTMLElement>(".ws-pane")
      ?.style.getPropertyValue("--tone") || null;

  const onDragOver = (e: DragEvent<HTMLElement>) => {
    const it = getFileDrag();
    if (!it) return;
    setHover(tabId);
    const r = resolve(e.target);
    if (!r) {
      // 不是落点：不 preventDefault，浏览器显示禁止光标
      setMark(null);
      setHint({ text: "拖到目录上", bad: false, tone: null });
      return;
    }
    e.preventDefault();
    if ("reject" in r) {
      e.dataTransfer.dropEffect = "none";
      setMark(null);
      setHint({ text: r.reject, bad: true, tone: null });
      return;
    }
    const v = judge(it, r.t);
    e.dataTransfer.dropEffect = !v.ok ? "none" : v.same ? "move" : "copy";
    setHint({
      text: hintText(v, r.t),
      bad: !v.ok,
      tone: v.ok && !v.same ? paneTone() : null,
    });
    // 拒绝时不给落点底纹
    const next: DzMark | null = v.ok
      ? ({ ...r.mark, label: v.label } as DzMark)
      : null;
    setMark((cur) => (sameMark(cur, next) ? cur : next));
  };

  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!getFileDrag()) return;
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setMark(null);
      setHint(IDLE_HINT(getFileDrag()?.hostName ?? ""));
    }
  };

  const onDrop = (e: DragEvent<HTMLElement>) => {
    const it = getFileDrag();
    if (!it) return;
    e.preventDefault();
    const r = resolve(e.target);
    // 先收尾：移动会让源行消失，源行的 dragend 就不会再触发
    endFileDrag();
    setMark(null);
    if (!r) return;
    if ("reject" in r) {
      toast(r.reject, { tone: "warn" });
      return;
    }
    const v = judge(it, r.t);
    if (!v.ok) {
      toast(v.reason, { tone: "warn" });
      return;
    }
    if (v.same) void move(it, r.t);
    else void startTransfer(it, r.t);
  };

  const move = async (it: FileDragItem, t: DropTarget) => {
    const r = await moveEntries(it.env, eligible(it, t), t.dir);
    // 已打开的预览标签跟着新路径走
    for (const m of r.moves) retargetPreviews(store, it.host, m.from, m.to);
    emitFsChange(it.env);
    if (r.error !== null) {
      toast(
        r.moves.length > 0
          ? `已移动 ${r.moves.length} 项，之后出错：${r.error}`
          : r.error,
        { tone: "danger" },
      );
      return;
    }
    const [only] = r.moves;
    toast(
      `已移动 ${only && r.moves.length === 1 ? `${baseName(only.to)} → ${only.to}` : `${r.moves.length} 项 → ${t.dir}`}${r.renamed ? ` · ${r.renamed} 项重名已改名` : ""}`,
      { tone: "ok" },
    );
  };

  /** 行的拖拽属性 */
  const rowDrag = (entry: FileEntry): FileRowProps["drag"] => {
    const path = joinPath(here, entry.name);
    return {
      draggable: true,
      dragging:
        item?.tabId === tabId && item.entries.some((x) => x.path === path),
      onDragStart: (e) => {
        // 拖的是选中项之一时，带整批（多选一起移动 / 传输 / 引用）；否则只带这一行
        const batch = selected?.some((x) => x.name === entry.name)
          ? selected.filter((x) => x.type !== "other")
          : [entry];
        beginFileDrag(e, {
          host,
          env,
          hostName,
          entries: batch.map((x) => ({
            path: joinPath(here, x.name),
            name: x.name,
            isDir: x.type === "dir",
            size: x.size,
          })),
          sessionId,
          tabId,
        });
      },
      onDragEnd: () => {
        endFileDrag();
        setMark(null);
      },
      mark:
        mark?.at === "row" && mark.name === entry.name
          ? { label: mark.label }
          : undefined,
    };
  };

  return {
    item,
    mark,
    /** 外部文件拖入（dropExternal）也往这一个落点标记里写，两套拖拽共用一套高亮 */
    setMark,
    rowDrag,
    handlers: { onDragOver, onDragLeave, onDrop },
  };
}
