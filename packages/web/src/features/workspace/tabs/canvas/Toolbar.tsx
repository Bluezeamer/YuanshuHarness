// 画布标签的工具条：永远只有一行。左边是侧栏开关、返回 / 前进、当前画布或笔记的名字；
// 右边画布有 新建卡片 ……（未保存 / 还原 / 保存）缩放，笔记的控件由 NoteView 放进 tailRef 这个槽位。
import { useViewport } from "@xyflow/react";
import { Button, Dot, IconButton } from "../../../../ui";
import {
  BackIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  SpinnerIcon,
} from "../../../../ui/icons";
import type { View } from "./nav";
import type { SyncBadge } from "./remoteSync";
import { type CanvasState, isDirty } from "./store";

export interface CanvasBarProps {
  state: CanvasState;
  /** 主区现在显示的 */
  view: View | null;
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  /** 笔记视图的控件放在这里（portal） */
  tailRef(el: HTMLElement | null): void;
  onNewCard(): void;
  onSave(): void;
  onDiscard(): void;
  zoom: { in(): void; out(): void; fit(): void };
  /** 远端同步的提示；没有就不显示 */
  sync: SyncBadge | null;
  /** 版本历史面板开着没有；开关 */
  versionsOpen: boolean;
  onToggleVersions(): void;
}

const titleOf = (v: View | null): string =>
  v === null ? "" : v.kind === "board" ? v.name : v.path.replace(/\.md$/i, "");

export function CanvasBar(p: CanvasBarProps) {
  const { zoom } = useViewport();
  const { state, view } = p;
  const dirty = isDirty(state);
  const onBoard = view?.kind === "board" && state.board !== null;

  return (
    <div className="cv-bar">
      <IconButton
        label="后退"
        icon={<BackIcon />}
        disabled={!p.canBack}
        onClick={p.onBack}
      />
      <IconButton
        label="前进"
        icon={
          <span className="cv-flip">
            <BackIcon />
          </span>
        }
        disabled={!p.canForward}
        onClick={p.onForward}
      />
      <span className="cv-viewname t-entry" title={titleOf(view)}>
        {titleOf(view)}
      </span>
      {view?.kind === "note" && <div className="cv-tail" ref={p.tailRef} />}
      {onBoard && (
        <Button
          size="sm"
          variant="ghost"
          icon={<PlusIcon />}
          aria-label="新建卡片"
          title="新建卡片"
          onClick={p.onNewCard}
        >
          <span className="cv-newtxt">新建卡片</span>
        </Button>
      )}
      <span className="cv-gap" />
      {view !== null && (
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcwIcon />}
          aria-label="历史"
          aria-pressed={p.versionsOpen}
          title="历史：看每一次改动，恢复旧版本"
          onClick={p.onToggleVersions}
        >
          <span className="cv-histtxt">历史</span>
        </Button>
      )}
      {p.sync && (
        <span className="cv-save t-aux" aria-live="polite" title={p.sync.tip}>
          {p.sync.busy ? (
            <SpinnerIcon className="u-spin" />
          ) : (
            <Dot tone="warn" size="sm" />
          )}
          <span className="cv-save-text">{p.sync.text}</span>
        </span>
      )}
      {onBoard && (
        <>
          {state.uploading > 0 && (
            <span
              className="cv-save t-aux"
              aria-live="polite"
              title={`上传中 ${state.uploading}`}
            >
              <SpinnerIcon className="u-spin" />
              <span className="cv-save-text">上传中 {state.uploading}</span>
            </span>
          )}
          {state.save === "error" ? (
            <span className="cv-save t-aux" role="alert" data-tone="danger">
              保存失败
            </span>
          ) : (
            dirty && (
              <span className="cv-save t-aux" aria-live="polite" title="未保存">
                <Dot tone="warn" size="sm" />
                <span className="cv-save-text">未保存</span>
              </span>
            )
          )}
          {dirty && (
            <Button size="sm" variant="ghost" onClick={p.onDiscard}>
              还原
            </Button>
          )}
          <Button
            size="sm"
            variant={dirty ? "primary" : "ghost"}
            loading={state.save === "saving"}
            disabled={!dirty}
            title="Ctrl+S"
            onClick={p.onSave}
          >
            保存
          </Button>
          <IconButton
            className="cv-zoombtn"
            label="缩小"
            icon={<MinusIcon />}
            onClick={p.zoom.out}
          />
          <span className="cv-zoom t-mono">{Math.round(zoom * 100)}%</span>
          <IconButton
            className="cv-zoombtn"
            label="放大"
            icon={<PlusIcon />}
            onClick={p.zoom.in}
          />
          <Button
            className="cv-fitbtn"
            size="sm"
            variant="ghost"
            onClick={p.zoom.fit}
          >
            适应
          </Button>
        </>
      )}
    </div>
  );
}
