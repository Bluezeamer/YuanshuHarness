// canvas 标签左侧的树：画布、笔记与文件夹混排（Obsidian 式导航）。新建、改名、挪动（拖拽）、删除都从这里发起，
// 因为只有经过这个入口，画布节点与笔记里的 [[链接]] 才会被机械地一起改掉。组件只管交互，真正的改动由标签去做。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BoardList } from "../../../../api/canvas";
import {
  Button,
  Dot,
  IconButton,
  Menu,
  type MenuItem,
  parentOf,
  SearchBox,
  Tree,
  type TreeNode,
} from "../../../../ui";
import {
  CanvasIcon,
  ChevronDownIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  FileIcon,
  FolderIcon,
  PinIcon,
  PlusIcon,
} from "../../../../ui/icons";
import type { NewKind } from "./NewItemDialog";
import type { View } from "./nav";
import {
  boardId,
  clashes,
  NOTE_DRAG_TYPE,
  nodesOf,
  type Ref,
  refOf,
} from "./navTree";
import { toggleAll } from "./treeView";

export interface CanvasTreeProps {
  list: BoardList | null;
  /** 主区现在显示的画布或笔记 */
  view: View | null;
  /** 有没保存的改动的画布名（树里它的行上标一个点） */
  dirtyBoard: string | null;
  onOpen(ref: Ref): void;
  /** 头上「新建」菜单的默认位置（"" 是根）：树里选中的优先，其次打开的东西所在的文件夹 */
  newFolder: string;
  /** 树被收起又展开时带回上次选中的行；选中的行变了报告出去（树收起后由标签记着） */
  initialFocus: string | null;
  onFocusChange(id: string | null): void;
  /** 展开的文件夹与列表滚动位置：由标签持有（树栏收起时这个组件会被卸载），这里只用 */
  open: Set<string>;
  onOpenChange(open: Set<string>): void;
  initialScroll: number;
  onScroll(top: number): void;
  /** 在 folder 里新建（"" 是根） */
  onNew(kind: NewKind, folder: string): void;
  /** 行内改名确认：返回字符串 = 错误提示 */
  onRename(node: TreeNode, newName: string): Promise<string | null>;
  onDelete(nodes: TreeNode[]): void;
  /** 固定在侧边（true）还是悬浮（false）；forced 表示窗格太窄、只能悬浮 */
  pinned: boolean;
  forcedFloat: boolean;
  onTogglePin(): void;
  /** 树栏里在做事（改名、菜单、拖拽、搜索框有焦点）：悬浮时据此决定要不要收起 */
  onBusyChange(busy: boolean): void;
  /** 拖拽挪动：moves 的 id / to 都是树 id */
  onMove(
    moves: Array<{ id: string; to: string }>,
    folder: string,
  ): void | Promise<void>;
}

const viewId = (v: View | null): string | null =>
  v === null ? null : v.kind === "board" ? boardId(v.name) : v.path;

const ancestors = (id: string): string[] => {
  const out: string[] = [];
  for (let i = id.indexOf("/"); i >= 0; i = id.indexOf("/", i + 1))
    out.push(id.slice(0, i));
  return out;
};

export function CanvasTree({
  list,
  view,
  dirtyBoard,
  onOpen,
  newFolder,
  initialFocus,
  onFocusChange,
  open,
  onOpenChange,
  initialScroll,
  onScroll,
  onNew,
  onRename,
  onDelete,
  pinned,
  forcedFloat,
  onTogglePin,
  onBusyChange,
  onMove,
}: CanvasTreeProps) {
  const nodes = useMemo(() => nodesOf(list), [list]);
  const folders = useMemo(
    () => nodes.filter((n) => n.kind === "folder").map((n) => n.id),
    [nodes],
  );
  const anyOpen = folders.some((f) => open.has(f));
  const [query, setQuery] = useState("");
  const current = viewId(view);
  const [treeBusy, setTreeBusy] = useState(false);
  const [headMenu, setHeadMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const busy = treeBusy || headMenu || searching;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  // 打开的东西在收起的文件夹里（点 [[链接]]、返回、新建）：把它的上级展开，别让它藏起来
  const openNow = useRef(open);
  openNow.current = open;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开的东西换了时展开（用户随后手动折叠上级不该被它抢回去）
  useEffect(() => {
    if (current === null) return;
    const up = ancestors(current);
    if (up.some((a) => !openNow.current.has(a)))
      onOpenChange(new Set([...openNow.current, ...up]));
  }, [current]);

  // 树栏再展开时回到上次滚到的位置；清单还没读到（刚打开标签）就等读到再还原，只还原一次
  const body = useRef<HTMLDivElement>(null);
  const scrollRestored = useRef(false);
  useLayoutEffect(() => {
    if (scrollRestored.current || nodes.length === 0 || !body.current) return;
    scrollRestored.current = true;
    body.current.scrollTop = initialScroll;
  }, [nodes.length, initialScroll]);

  const newItems = (folder: string): MenuItem[] => [
    {
      id: "new-note",
      label: "新建笔记",
      onSelect: () => onNew("note", folder),
    },
    {
      id: "new-board",
      label: "新建画布",
      onSelect: () => onNew("board", folder),
    },
    {
      id: "new-folder",
      label: "新建文件夹",
      onSelect: () => onNew("folder", folder),
    },
  ];

  return (
    <div className="cv-tree">
      <div className="cv-tree-head">
        <Menu
          label="新建"
          placement="bottom-start"
          items={newItems(newFolder)}
          open={headMenu}
          onOpenChange={setHeadMenu}
          trigger={(t) => (
            <Button {...t} size="sm" variant="ghost" icon={<PlusIcon />}>
              新建
              <ChevronDownIcon />
            </Button>
          )}
        />
        <span className="cv-gap" />
        <IconButton
          label={anyOpen ? "全部折叠" : "全部展开"}
          icon={anyOpen ? <CollapseAllIcon /> : <ExpandAllIcon />}
          disabled={folders.length === 0}
          onClick={() => onOpenChange(toggleAll(open, folders).open)}
        />
        <IconButton
          label={
            forcedFloat
              ? "窗格太窄，暂时只能悬浮"
              : pinned
                ? "改为悬浮（鼠标移开自动收起）"
                : "固定在侧边"
          }
          icon={<PinIcon />}
          aria-pressed={pinned && !forcedFloat}
          disabled={forcedFloat}
          onClick={onTogglePin}
        />
      </div>
      <div className="cv-tree-search">
        <SearchBox
          aria-label="搜索画布与笔记"
          placeholder="搜索"
          value={query}
          onChange={setQuery}
          onFocus={() => setSearching(true)}
          onBlur={() => setSearching(false)}
        />
      </div>
      <div
        className="cv-tree-body"
        ref={body}
        onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
      >
        <Tree
          label="画布与笔记"
          className="cv-tree-list"
          nodes={nodes}
          current={current}
          open={open}
          onOpenChange={onOpenChange}
          query={query}
          lead={(row) =>
            row.node.kind === "folder" ? (
              <FolderIcon size={14} />
            ) : refOf(row.node).kind === "board" ? (
              <CanvasIcon size={14} />
            ) : (
              <FileIcon size={14} />
            )
          }
          trail={(row) =>
            dirtyBoard !== null && row.node.id === boardId(dirtyBoard) ? (
              <Dot tone="warn" size="sm" />
            ) : null
          }
          onOpen={(node) => onOpen(refOf(node))}
          onRename={onRename}
          onDelete={onDelete}
          onMove={onMove}
          onBusyChange={setTreeBusy}
          initialFocus={initialFocus}
          onFocusChange={onFocusChange}
          canDrop={(dragged, folder) => !clashes(nodes, dragged, folder)}
          onDragStartNodes={(e, dragged) => {
            const notes = dragged
              .filter((n) => refOf(n).kind === "note")
              .map((n) => n.id);
            if (notes.length > 0)
              e.dataTransfer.setData(NOTE_DRAG_TYPE, JSON.stringify(notes));
          }}
          menu={(node, actions) => {
            if (node === null) return newItems("");
            // 条目上右键：新建建在它所在的文件夹里
            const rename: MenuItem = {
              id: "rename",
              label: "重命名",
              onSelect: actions.rename,
            };
            const del: MenuItem = {
              id: "delete",
              label: "删除",
              tone: "danger",
              separatorBefore: true,
              onSelect: () => onDelete([node]),
            };
            return node.kind === "folder"
              ? [
                  ...newItems(node.id),
                  { ...rename, separatorBefore: true },
                  del,
                ]
              : [
                  ...newItems(parentOf(node.id)),
                  { ...rename, separatorBefore: true },
                  del,
                ];
          }}
        />
        {nodes.length === 0 && (
          <p className="cv-tree-empty t-aux">
            还没有画布和笔记。点上面的「新建」开始。
          </p>
        )}
      </div>
    </div>
  );
}
