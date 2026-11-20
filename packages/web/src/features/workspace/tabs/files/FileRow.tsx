// 目录里的一行：标准 ListRow（外层 div 可拖动，主体按钮负责点击 / 空格，Enter 在外层键盘处理里 = 固定），
// 右侧是 git 状态字母、大小、时间；「…」菜单悬停才出现，右键给同一份菜单。

import type { DragEventHandler, KeyboardEvent } from "react";
import { useState } from "react";
import type { FileEntry } from "../../../../api/files";
import type { GitFileStatus } from "../../../../api/git";
import { FileTypeIcon, ListRow, Menu, type MenuItem } from "../../../../ui";
import { sizeText, timeText } from "./paths";

export interface FileRowProps {
  entry: FileEntry;
  /** 条目的绝对路径，作为 title 与拖拽标识 */
  path: string;
  /** git 状态（未跟踪/已修改/已删除…），决定文件名颜色；不在仓库里就是 undefined */
  git?: GitFileStatus | undefined;
  /** 带原始事件：外层据此判断 ctrl/⌘、shift 的多选语义 */
  onOpen(ev: React.MouseEvent | React.KeyboardEvent): void;
  /** 双击行（文件：把预览固定下来） */
  onPin?(): void;
  onDownload(): void;
  onRename(): void;
  onDelete(): void;
  onCopyPath(): void;
  /** 当前预览着的那一行（单击选中的）：灰底 */
  current?: boolean;
  /** 在多选集合里：浅蓝底 */
  selected?: boolean;
  /** 拖拽相关的 DOM 事件（阶段 B 的 dnd 接入） */
  drag?: {
    draggable: boolean;
    dragging: boolean;
    onDragStart: DragEventHandler<HTMLElement>;
    onDragEnd: DragEventHandler<HTMLElement>;
    onDragOver?: DragEventHandler<HTMLElement>;
    onDragLeave?: DragEventHandler<HTMLElement>;
    onDrop?: DragEventHandler<HTMLElement>;
    /** 落点标记：行尾标签（移动 / 传输 / 上传） */
    mark?: { label: string };
  };
}

// 行内键盘：上下键在行主体之间移动焦点；Enter 固定预览（同双击），空格走按钮自己的点击 = 临时预览
function onRowKey(e: KeyboardEvent<HTMLElement>, pin: () => void) {
  // 行尾「…」菜单的按钮也在这一行里，它自己的回车不归这里管
  if (!(e.target as HTMLElement).closest(".u-lrow-main")) return;
  if (e.key === "Enter") {
    e.preventDefault();
    pin();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const mains = Array.from(
    e.currentTarget
      .closest(".ws-fm-list")
      ?.querySelectorAll<HTMLElement>(
        ".ws-fm-row:not([data-kind='other']) .u-lrow-main",
      ) ?? [],
  );
  const to =
    mains[
      mains.indexOf(e.target as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1)
    ];
  if (to) {
    e.preventDefault();
    to.focus();
  }
}

/** git 状态的单字母标记：文件列表与版本视图共用 */
export const GIT_MARK: Record<GitFileStatus, string> = {
  untracked: "U",
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  conflict: "C",
};

/** git 状态的中文说法：行 title 与版本视图共用 */
export const GIT_TEXT: Record<GitFileStatus, string> = {
  untracked: "未跟踪",
  added: "新增",
  modified: "已修改",
  deleted: "已删除",
  renamed: "已重命名",
  conflict: "冲突",
};

export function FileRow({
  entry,
  path,
  git,
  current = false,
  selected = false,
  onOpen,
  onPin,
  onDownload,
  onRename,
  onDelete,
  onCopyPath,
  drag,
}: FileRowProps) {
  // 右键菜单按指针坐标定位（Popover 支持 point，不再需要锚点元素）
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const isDir = entry.type === "dir";
  const usable = entry.type !== "other";
  const items: MenuItem[] = [
    ...(usable
      ? [{ id: "download", label: "下载", onSelect: onDownload }]
      : []),
    { id: "rename", label: "重命名", onSelect: onRename },
    { id: "copy", label: "复制路径", onSelect: onCopyPath },
    { id: "delete", label: "删除", tone: "danger", onSelect: onDelete },
  ];
  const mark = drag?.mark;
  const label = `${entry.name} 的操作`;
  const tip = [
    entry.symlink ? `${path} → ${entry.symlink}` : path,
    entry.broken ? "失效链接" : null,
    git ? GIT_TEXT[git] : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <ListRow
      size="compact"
      className="ws-fm-row"
      data-kind={entry.type}
      data-name={entry.name}
      data-git={git}
      data-broken={entry.broken || undefined}
      data-dragging={drag?.dragging || undefined}
      data-dz={mark?.label}
      current={current}
      selected={selected}
      disabled={!usable}
      lead={
        <span className="ws-fm-ic" data-dir={isDir || undefined}>
          <FileTypeIcon name={entry.name} dir={isDir} />
        </span>
      }
      label={entry.name}
      title={tip}
      trail={
        <span className="ws-fm-meta t-mono">
          <span className="ws-fm-mark">{git ? GIT_MARK[git] : ""}</span>
          <span className="ws-fm-size">
            {entry.type === "file" ? sizeText(entry.size) : ""}
          </span>
          <span className="ws-fm-time">{timeText(entry.mtimeMs)}</span>
        </span>
      }
      actions={
        <>
          <Menu items={items} label={label} />
          {ctx && (
            <Menu
              items={items}
              label={label}
              placement="bottom-start"
              point={ctx}
              open
              onOpenChange={(next) => {
                if (!next) setCtx(null);
              }}
              trigger={() => null}
            />
          )}
        </>
      }
      onClick={usable ? (e) => onOpen(e) : undefined}
      onDoubleClick={usable ? onPin : undefined}
      onKeyDown={usable ? (e) => onRowKey(e, () => onOpen(e)) : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      draggable={drag?.draggable && usable}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
    />
  );
}
