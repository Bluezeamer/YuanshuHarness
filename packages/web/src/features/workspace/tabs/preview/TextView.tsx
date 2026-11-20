// 文本类内容的统一外壳：预览态（可渲染的格式才有）与编辑态。
// 编辑态用 CodeMirror，预览态与编辑态高亮完全一致。
// B45：默认直接进编辑；有渲染态时用「预览 / 编辑」两段切换，不再单列「源码」模式。
import { useEffect, useRef, useState } from "react";
import type { SaveBase } from "../../../../api/files";
import { Segmented } from "../../../../ui";
import { BarPortal } from "./BarSlots";
import { CodeEditor } from "./CodeEditor";
import type { EditorPos } from "./mountEditor";

export interface TextViewProps {
  env: string;
  path: string;
  text: string;
  base: SaveBase;
  /** 有渲染态时给 ReactNode（markdown / html / svg），没有就一直是编辑态 */
  rendered?: React.ReactNode;
  /** 渲染态那一段的字，默认「预览」 */
  previewLabel?: string;
  editable: boolean;
  /** 未保存改动变化：外层据此决定文件被外部改动时要不要自动重载（有改动就不能顶掉用户内容） */
  onDirtyChange?: (dirty: boolean) => void;
  /** 保存成功（外层据此分辨「这次改动是我自己写的」，并把内容灌回预览） */
  onSaved?: (next: { text: string; base: SaveBase }) => void;
  /** 上次的预览 / 编辑模式与编辑器光标、滚动位置（窗格切走会卸载，靠外层存浏览器本地后还原） */
  restore?: { mode: "preview" | "edit"; view: EditorPos } | null;
  /** 粘贴 / 拖入了文件：返回要插入的文本（md 里存图片用）；不给就不处理文件 */
  onFiles?: (files: File[], via: "paste" | "drop") => Promise<string | null>;
  /** 模式或光标、滚动位置变了 */
  onViewState?: (
    patch: { mode: "preview" | "edit" } | { view: EditorPos },
  ) => void;
}

export function TextView({
  env,
  path,
  text,
  base,
  rendered,
  previewLabel = "预览",
  editable,
  onDirtyChange,
  onSaved,
  restore,
  onViewState,
  onFiles,
}: TextViewProps) {
  // 默认直接编辑；换文件时回到编辑态，别把上一个文件的预览态带过来
  const [mode, setMode] = useState<"preview" | "edit">(restore?.mode ?? "edit");
  const lastPath = useRef(path);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换文件时复位（挂载时不复位：那是刚恢复出来的）
  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    setMode("edit");
  }, [path]);
  const changeMode = (m: "preview" | "edit") => {
    setMode(m);
    onViewState?.({ mode: m });
  };

  // 没有渲染态（纯代码/文本/JSON）或文件大到不可编辑时，只有编辑框一种形态
  const canPreview = rendered !== undefined && editable;
  const showEditor = !canPreview || mode === "edit";

  return (
    <div className="ws-pv-tv">
      {canPreview && (
        <BarPortal slot="lead">
          <Segmented
            size="sm"
            aria-label="显示方式"
            options={[
              { value: "preview", label: previewLabel },
              { value: "edit", label: "编辑" },
            ]}
            value={mode}
            onChange={changeMode}
          />
        </BarPortal>
      )}
      <div className="ws-pv-tv-body">
        {showEditor ? (
          <CodeEditor
            env={env}
            path={path}
            text={text}
            base={base}
            readOnly={!editable}
            onDirtyChange={onDirtyChange}
            onSaved={(next) => onSaved?.(next)}
            {...(restore ? { initialView: restore.view } : {})}
            {...(onFiles && editable ? { onFiles } : {})}
            {...(onViewState
              ? { onViewChange: (view: EditorPos) => onViewState({ view }) }
              : {})}
          />
        ) : (
          rendered
        )}
      </div>
    </div>
  );
}
