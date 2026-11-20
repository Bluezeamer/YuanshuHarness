import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "./cx";
import { ChevronRightIcon } from "./icons";
import { Menu, type MenuItem } from "./Menu";
import {
  dropAllowed,
  flatten,
  movesFor,
  stepIndex,
  type TreeNode,
  type TreeRow,
  topLevel,
} from "./treeModel";

export type { TreeNode } from "./treeModel";

export interface TreeProps {
  /** 全部节点（文件夹与条目）；组件按路径分层、同层文件夹在前按名字排 */
  nodes: readonly TreeNode[];
  /** 当前打开的条目 */
  current?: string | null;
  /** 展开的文件夹（受控）；不给就自己管，初始全部收起 */
  open?: ReadonlySet<string>;
  onOpenChange?: (open: Set<string>) => void;
  /** 过滤：按显示名，匹配的连同祖先文件夹都显示 */
  query?: string;
  /** 名字左边的图标 / 状态点；文件夹的展开箭头组件自己画 */
  lead?: (row: TreeRow) => ReactNode;
  /** 名字右边的辅助文字 */
  trail?: (row: TreeRow) => ReactNode;
  /** 点条目（单击）；点文件夹只展开收起 */
  onOpen?: (node: TreeNode) => void;
  /** 行内改名确认：newName 是新的最后一段（已去首尾空白、非空、与原来不同）。返回字符串 = 错误提示，行内编辑保持打开 */
  onRename?: (
    node: TreeNode,
    newName: string,
  ) => string | null | Promise<string | null>;
  /** 右键菜单；空白处右键 node 是 null。actions.rename() 让这一行进入行内改名（菜单里的「重命名」调它） */
  menu?: (node: TreeNode | null, actions: { rename(): void }) => MenuItem[];
  /** Delete 键：删除选中的节点 */
  onDelete?: (nodes: TreeNode[]) => void;
  /** 拖拽移动：把 moves 里的节点挪到 folder（"" 是根）里。不给就不能拖 */
  onMove?: (
    moves: Array<{ id: string; to: string }>,
    folder: string,
  ) => void | Promise<void>;
  /** 业务补充的落点判定（如重名）：返回 false 这个文件夹就不接。已排除「落进自己的子孙」「没有变化」 */
  canDrop?: (dragged: TreeNode[], folder: string) => boolean;
  /** dragstart：业务往 dataTransfer 里补载荷（如把笔记拖到画布上放置）；组件自己的载荷已经设好 */
  onDragStartNodes?: (e: DragEvent<HTMLElement>, nodes: TreeNode[]) => void;
  /** 树里在做事（行内改名、菜单打开、正在拖）时为 true：浮层之类的外壳据此决定要不要收起 */
  onBusyChange?: (busy: boolean) => void;
  /** 挂载时选中并聚焦的行（树被收起又展开时，外壳把上次的焦点行带回来） */
  initialFocus?: string | null;
  /** 焦点行变了（点、方向键、右键）；行没了或 current 换了之后随之变；null = 没有焦点行 */
  onFocusChange?: (id: string | null) => void;
  /** 容器上的类名（定高与滚动由使用方的布局决定） */
  className?: string;
  /** 无障碍名 */
  label: string;
}

const DRAG_TYPE = "application/x-yuanshu-tree";
/** 悬停在收起的文件夹上这么久就自动展开 */
const HOVER_OPEN_MS = 600;

/**
 * 目录树（Obsidian 式导航）：嵌套行、展开收起、方向键与 F2 / Delete、行内改名、右键菜单、拖拽移动。
 * 不认识「文件」：节点是路径，改名、移动、删除都交给业务回调去做并刷新 nodes；组件只管交互。
 * 同层文件夹在前、按名字排，没有手动排序，所以拖拽只有「挪进某个文件夹 / 拖到空白挪到根」一种。
 */
export function Tree({
  nodes,
  current = null,
  open: controlledOpen,
  onOpenChange,
  query = "",
  lead,
  trail,
  onOpen,
  onRename,
  menu,
  onDelete,
  onMove,
  canDrop,
  onDragStartNodes,
  onBusyChange,
  initialFocus = null,
  onFocusChange,
  className,
  label,
}: TreeProps) {
  const [innerOpen, setInnerOpen] = useState<Set<string>>(new Set());
  const openSet = controlledOpen ?? innerOpen;
  const setOpen = (next: Set<string>) => {
    if (controlledOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  const rows = useMemo(
    () => flatten(nodes, openSet, query),
    [nodes, openSet, query],
  );
  const kindOf = useMemo(() => {
    const m = new Map(nodes.map((n) => [n.id, n.kind]));
    return (id: string) => m.get(id);
  }, [nodes]);
  const nodeOf = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // 选中（多选）与焦点行
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialFocus === null ? [] : [initialFocus]),
  );
  const [anchor, setAnchor] = useState<string | null>(initialFocus);
  const [focusId, setFocusId] = useState<string | null>(initialFocus);
  const reportFocus = useRef(onFocusChange);
  reportFocus.current = onFocusChange;
  useEffect(() => {
    reportFocus.current?.(focusId);
  }, [focusId]);
  // 打开的东西换了（点 [[链接]]、返回、新建）：选中与焦点跟过去，别留在旧的行上
  const lastCurrent = useRef(current);
  useEffect(() => {
    if (lastCurrent.current === current) return;
    lastCurrent.current = current;
    if (current === null) return;
    setSelected(new Set([current]));
    setAnchor(current);
    setFocusId(current);
  }, [current]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [menuAt, setMenuAt] = useState<{
    x: number;
    y: number;
    node: TreeNode | null;
  } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // 节点没了（被删、被挪走）就从选中里去掉
  useEffect(() => {
    setSelected((s) => {
      const next = new Set([...s].filter((id) => nodeOf.has(id)));
      return next.size === s.size ? s : next;
    });
    setFocusId((f) => (f !== null && !nodeOf.has(f) ? null : f));
    setRenaming((r) => (r !== null && !nodeOf.has(r) ? null : r));
  }, [nodeOf]);

  const toggle = (id: string) => {
    const next = new Set(openSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  const pick = (row: TreeRow, e: MouseEvent | KeyboardEvent) => {
    const id = row.node.id;
    setFocusId(id);
    if (e.shiftKey && anchor !== null) {
      const a = rows.findIndex((r) => r.node.id === anchor);
      const b = rows.findIndex((r) => r.node.id === id);
      if (a >= 0 && b >= 0)
        setSelected(
          new Set(
            rows
              .slice(Math.min(a, b), Math.max(a, b) + 1)
              .map((r) => r.node.id),
          ),
        );
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setAnchor(id);
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setAnchor(id);
    setSelected(new Set([id]));
    if (row.node.kind === "folder") toggle(id);
    else onOpen?.(row.node);
  };

  // ── 键盘 ──
  const focusRow = (id: string) => {
    setFocusId(id);
    root.current
      ?.querySelector<HTMLElement>(
        `[data-tree-id="${CSS.escape(id)}"] .u-lrow-main`,
      )
      ?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (renaming !== null) return;
    const row = rows.find((r) => r.node.id === focusId) ?? null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const to = rows[stepIndex(rows, focusId, e.key === "ArrowDown" ? 1 : -1)];
      if (to) {
        focusRow(to.node.id);
        if (e.shiftKey) pick(to, e);
        else {
          setSelected(new Set([to.node.id]));
          setAnchor(to.node.id);
        }
      }
    } else if (e.key === "ArrowRight" && row?.node.kind === "folder") {
      e.preventDefault();
      if (!row.open) toggle(row.node.id);
      else {
        const child = rows[rows.indexOf(row) + 1];
        if (child && child.depth > row.depth) focusRow(child.node.id);
      }
    } else if (e.key === "ArrowLeft" && row) {
      e.preventDefault();
      if (row.node.kind === "folder" && row.open) toggle(row.node.id);
      else {
        const parent = rows
          .slice(0, rows.indexOf(row))
          .reverse()
          .find((r) => r.depth < row.depth);
        if (parent) focusRow(parent.node.id);
      }
    } else if (e.key === "F2" && row && onRename) {
      e.preventDefault();
      startRename(row.node.id);
    } else if ((e.key === "Delete" || e.key === "Backspace") && onDelete) {
      const chosen = [...selected]
        .map((id) => nodeOf.get(id))
        .filter(Boolean) as TreeNode[];
      if (chosen.length > 0) {
        e.preventDefault();
        onDelete(chosen);
      }
    } else if (e.key === "Enter" && row) {
      e.preventDefault();
      if (row.node.kind === "folder") toggle(row.node.id);
      else onOpen?.(row.node);
    }
  };

  // ── 行内改名 ──
  const startRename = (id: string) => {
    setRenameError(null);
    setRenaming(id);
  };
  const finishRename = async (
    node: TreeNode,
    value: string,
    commit: boolean,
  ) => {
    const name = value.trim();
    if (
      !commit ||
      name === "" ||
      name === node.id.slice(node.id.lastIndexOf("/") + 1)
    ) {
      setRenaming(null);
      focusRow(node.id);
      return;
    }
    const err = (await onRename?.(node, name)) ?? null;
    if (err) setRenameError(err);
    else {
      setRenaming(null);
      setRenameError(null);
    }
  };

  // ── 拖拽 ──
  const dragging = useRef<TreeNode[] | null>(null);
  const [dragIds, setDragIds] = useState<ReadonlySet<string> | null>(null);
  const [dropMark, setDropMark] = useState<string | null>(null); // 文件夹 id；"" = 根
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHover = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  // 原生拖拽按 Esc 自己就会取消（照样触发 dragend），不用另外监听
  const endDrag = () => {
    dragging.current = null;
    setDragIds(null);
    setDropMark(null);
    clearHover();
  };
  // 组件卸载时清掉自动展开的计时器
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const onDragStart = (e: DragEvent<HTMLElement>, row: TreeRow) => {
    if (!onMove && !onDragStartNodes) return;
    const ids = selected.has(row.node.id) ? [...selected] : [row.node.id];
    const dragged = topLevel(ids)
      .map((id) => nodeOf.get(id))
      .filter(Boolean) as TreeNode[];
    dragging.current = dragged;
    setDragIds(new Set(dragged.map((n) => n.id)));
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragged.map((n) => n.id)));
    e.dataTransfer.setData("text/plain", dragged.map((n) => n.id).join("\n"));
    onDragStartNodes?.(e, dragged);
  };

  const acceptsHere = (folder: string): boolean => {
    const d = dragging.current;
    if (!d || !onMove) return false;
    const ids = d.map((n) => n.id);
    return dropAllowed(ids, folder, kindOf) && (canDrop?.(d, folder) ?? true);
  };

  /** 悬停的行 → 它作为落点是哪个文件夹：文件夹行是自己，条目行是它所在的文件夹 */
  const folderOfRow = (row: TreeRow): string =>
    row.node.kind === "folder"
      ? row.node.id
      : row.node.id.includes("/")
        ? row.node.id.slice(0, row.node.id.lastIndexOf("/"))
        : "";

  const onRowDragOver = (e: DragEvent<HTMLElement>, row: TreeRow) => {
    if (!dragging.current) return;
    const folder = folderOfRow(row);
    // 不接的行也要拦住冒泡：否则「悬停在自己这一行」会冒到根，被当成「挪到根」
    e.stopPropagation();
    if (!acceptsHere(folder)) {
      if (dropMark !== null) setDropMark(null);
      clearHover();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropMark !== folder) {
      setDropMark(folder);
      clearHover();
      if (row.node.kind === "folder" && !row.open && row.hasChildren)
        hoverTimer.current = setTimeout(() => {
          const next = new Set(openSet);
          next.add(row.node.id);
          setOpen(next);
        }, HOVER_OPEN_MS);
    }
  };
  const onRowDrop = (e: DragEvent<HTMLElement>, row: TreeRow) => {
    if (!dragging.current) return;
    const folder = folderOfRow(row);
    e.stopPropagation();
    if (!acceptsHere(folder)) return;
    e.preventDefault();
    const moves = movesFor(
      dragging.current.map((n) => n.id),
      folder,
    ).filter((m, i) => m.to !== (dragging.current as TreeNode[])[i]?.id);
    endDrag();
    if (moves.length > 0) {
      void onMove?.(moves, folder);
      if (folder !== "") {
        const next = new Set(openSet);
        next.add(folder);
        setOpen(next);
      }
    }
  };
  // 拖到空白处 = 挪到根
  const onRootDragOver = (e: DragEvent<HTMLElement>) => {
    if (!dragging.current || !acceptsHere("")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropMark !== "") setDropMark("");
  };
  const onRootDrop = (e: DragEvent<HTMLElement>) => {
    if (!dragging.current || !acceptsHere("")) return;
    e.preventDefault();
    const d = dragging.current;
    const moves = movesFor(
      d.map((n) => n.id),
      "",
    ).filter((m, i) => m.to !== d[i]?.id);
    endDrag();
    if (moves.length > 0) void onMove?.(moves, "");
  };

  const busy = renaming !== null || menuAt !== null || dragIds !== null;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  // 卸载时不能把「忙」留在外面
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const rowMenu = (node: TreeNode | null) =>
    menu?.(node, {
      rename: () => {
        if (node && onRename) startRename(node.id);
      },
    }) ?? [];

  return (
    <div
      ref={root}
      role="tree"
      aria-label={label}
      aria-multiselectable
      className={cx("u-tree", className)}
      data-drop-root={dropMark === "" ? true : undefined}
      onKeyDown={onKeyDown}
      onDragOver={onRootDragOver}
      onDrop={onRootDrop}
      onDragLeave={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null))
          setDropMark(null);
      }}
      onContextMenu={(e) => {
        if (!menu || e.defaultPrevented) return;
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY, node: null });
      }}
    >
      {rows.map((row) => {
        const id = row.node.id;
        const isFolder = row.node.kind === "folder";
        const mark =
          dropMark !== null &&
          (isFolder ? dropMark === id : false) &&
          dropMark !== "";
        return (
          <div
            key={id}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={isFolder ? row.open : undefined}
            aria-selected={selected.has(id) || current === id}
            tabIndex={-1}
            data-tree-id={id}
            data-kind={row.node.kind}
            data-drop={mark || undefined}
            data-dragging={dragIds?.has(id) || undefined}
            className="u-tree-row"
            style={{ ["--tree-depth" as string]: row.depth }}
            draggable={(!!onMove || !!onDragStartNodes) && renaming !== id}
            onDragStart={(e) => onDragStart(e, row)}
            onDragEnd={endDrag}
            onDragOver={(e) => onRowDragOver(e, row)}
            onDrop={(e) => onRowDrop(e, row)}
            onContextMenu={(e) => {
              if (!menu) return;
              e.preventDefault();
              e.stopPropagation();
              if (!selected.has(id)) {
                setSelected(new Set([id]));
                setAnchor(id);
              }
              setFocusId(id);
              setMenuAt({ x: e.clientX, y: e.clientY, node: row.node });
            }}
          >
            <div
              className="u-lrow"
              data-size="compact"
              data-current={current === id || undefined}
              data-selected={(selected.has(id) && current !== id) || undefined}
            >
              {renaming === id ? (
                <RenameInput
                  row={row}
                  error={renameError}
                  lead={lead?.(row)}
                  onDone={(value, commit) =>
                    void finishRename(row.node, value, commit)
                  }
                />
              ) : (
                <button
                  type="button"
                  tabIndex={
                    focusId === id || (focusId === null && row === rows[0])
                      ? 0
                      : -1
                  }
                  className="u-lrow-main"
                  style={{ paddingLeft: 8 + row.depth * 16 }}
                  title={row.node.label ?? id}
                  onClick={(e) => pick(row, e)}
                  onFocus={() => setFocusId(id)}
                >
                  <span
                    className="u-tree-caret"
                    data-open={row.open || undefined}
                    data-empty={!isFolder || undefined}
                  >
                    {isFolder && <ChevronRightIcon size={12} />}
                  </span>
                  {lead?.(row)}
                  <span className="u-lrow-text">
                    <span className="u-lrow-label t-entry">
                      {row.node.label ?? row.name}
                    </span>
                  </span>
                  {trail?.(row) && (
                    <span className="u-lrow-trail t-aux">{trail(row)}</span>
                  )}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {menuAt && (
        <Menu
          label={
            menuAt.node
              ? `${menuAt.node.label ?? menuAt.node.id} 的菜单`
              : "树的菜单"
          }
          items={rowMenu(menuAt.node)}
          point={{ x: menuAt.x, y: menuAt.y }}
          open
          onOpenChange={(o) => {
            if (!o) setMenuAt(null);
          }}
          trigger={() => null}
        />
      )}
    </div>
  );
}

/** 行内改名：Enter 确认、Esc / 失焦放弃（失焦不确认，免得点别处时悄悄改名） */
function RenameInput({
  row,
  error,
  lead,
  onDone,
}: {
  row: TreeRow;
  error: string | null;
  lead: ReactNode;
  onDone: (value: string, commit: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(row.name);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // 只选名字、不选扩展名
    const dot = row.node.kind === "item" ? row.name.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : row.name.length);
  }, [row.name, row.node.kind]);
  return (
    <div className="u-tree-rename" style={{ paddingLeft: 8 + row.depth * 16 }}>
      <span className="u-tree-caret" data-empty />
      {lead}
      <input
        ref={ref}
        className="u-tree-input t-entry"
        value={value}
        aria-label="新名字"
        aria-invalid={error ? true : undefined}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onDone(value, true);
          else if (e.key === "Escape") onDone(value, false);
        }}
        onBlur={() => onDone(value, false)}
      />
      {error && (
        <span className="u-tree-err t-aux" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
