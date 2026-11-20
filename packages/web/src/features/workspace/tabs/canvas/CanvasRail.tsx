// canvas 标签左边的窄栏：永久驻留（树栏固定还是悬浮都在）。树栏悬浮时鼠标一移上去就展开悬浮树栏，
// 触发区就是整条窄栏；上面还有快捷按钮。以后的入口（比如关系图谱）也加在这里。
import { IconButton } from "../../../../ui";
import { CanvasAddIcon, NoteAddIcon, SidebarIcon } from "../../../../ui/icons";
import type { NewKind } from "./NewItemDialog";

export interface CanvasRailProps {
  /** 树栏现在是否展开（固定着的树栏、或悬浮树栏展开着） */
  treeOpen: boolean;
  /** 点树按钮是收起（固定着的树栏、或手动展开的悬浮树栏）还是展开 */
  treeCloses: boolean;
  onToggleTree(): void;
  /** 快捷新建：位置由标签按树里的选中 / 打开的东西定，弹出确认框 */
  onNew(kind: Exclude<NewKind, "folder">): void;
  /** 鼠标进出：触发悬浮树栏的展开与收回 */
  onPointerEnter(): void;
  onPointerLeave(): void;
}

export function CanvasRail(p: CanvasRailProps) {
  return (
    <nav
      className="cv-rail"
      aria-label="画布快捷栏"
      onPointerEnter={p.onPointerEnter}
      onPointerLeave={p.onPointerLeave}
    >
      <div className="cv-rail-group">
        <IconButton
          label={p.treeCloses ? "收起树栏" : "展开树栏"}
          icon={<SidebarIcon />}
          pressed={p.treeOpen}
          data-float-toggle=""
          onClick={p.onToggleTree}
        />
      </div>
      <div className="cv-rail-group">
        <IconButton
          label="新建笔记"
          icon={<NoteAddIcon />}
          onClick={() => p.onNew("note")}
        />
        <IconButton
          label="新建画布"
          icon={<CanvasAddIcon />}
          onClick={() => p.onNew("board")}
        />
      </div>
    </nav>
  );
}
