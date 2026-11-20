// 富输入：发给 agent 的文字框的统一形态——文字 + 附件（选文件、粘贴、拖入，上传进度与重试都在里面）。
// 凡是「用户写点什么交给 agent」的地方（提问回答、目标、排队编辑、子代理补充要求……）都用它，
// 不要直接用 Textarea：直接用就只有文字，附件会再丢一次（input.guard.test.ts 守着）。
// 主输入框有斜杠菜单与引用，自己持有文字框，但附件部分同样用 AttachmentBar / useFilePicker。
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton, Textarea } from "../../../ui";
import { droppedFiles, isFileDrag } from "../tab/dropFiles";
import { ClipGlyph } from "../tab/glyphs";
import { AttachmentBar } from "./AttachmentBar";
import { type AttachmentSink, useLocalAttachments } from "./attachments";
import { useFilePicker } from "./useFilePicker";
import { useUploads } from "./useUploads";

export interface RichInputProps {
  sessionId: string;
  /** 文字框的无障碍名 */
  label: string;
  placeholder?: string;
  value: string;
  onChange(value: string): void;
  /** 附件存放处：会话草稿，或调用方自己的本地存放；不给就是纯文字（对方收不了附件时用） */
  sink?: AttachmentSink;
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** 按 Enter（不带 Shift、不在输入法组词中）时调用；不给则 Enter 换行 */
  onSubmit?(): void;
  /** 其余按键（如 Esc 取消、Ctrl+Enter 保存）由调用方处理 */
  onKeyDown?(e: KeyboardEvent<HTMLTextAreaElement>): void;
  /** 工具行右侧：提交按钮等 */
  end?: ReactNode;
}

export function RichInput({
  sessionId,
  label,
  placeholder,
  value,
  onChange,
  sink,
  rows = 2,
  disabled,
  autoFocus,
  onSubmit,
  onKeyDown,
  end,
}: RichInputProps) {
  // 纯文字时也要有一个存放处好让钩子照常调用，它不会被用到
  const spare = useLocalAttachments();
  const files = sink ?? spare;
  const uploads = useUploads(sessionId, files);
  const picker = useFilePicker(uploads);
  const [dragging, setDragging] = useState(false);
  // 点「编辑 / 拒绝并说明」后立刻要输入：自己聚焦并且不让浏览器滚动。原生 autoFocus 会把输入框滚进视口，
  // 对话流里的卡片（审批的拒绝理由）因此被判成「用户上翻」，之后卡片长高就不再贴底了。
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (autoFocus) ta.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // 只接管文件拖入，并拦住冒泡：不然外层对话标签的拖入区会把文件也加进主输入框。
  const own =
    (f: (e: DragEvent<HTMLDivElement>) => void) =>
    (e: DragEvent<HTMLDivElement>) => {
      if (disabled || !sink || !isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      f(e);
    };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖入区只接收文件拖放，键盘操作走回形针按钮选文件
    <div
      className="ch-rin"
      data-rich-input=""
      data-drop={dragging ? "" : undefined}
      onDragEnter={own(() => setDragging(true))}
      onDragOver={own((e) => {
        e.dataTransfer.dropEffect = "copy";
      })}
      onDragLeave={own((e) => {
        // 进出子元素也会触发 leave：只在真的离开整块时取消高亮
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDragging(false);
      })}
      onDrop={own((e) => {
        setDragging(false);
        void droppedFiles(e.dataTransfer).then((files) => {
          if (files.length > 0) uploads.add(files);
        });
      })}
    >
      {sink && (
        <AttachmentBar sessionId={sessionId} sink={sink} uploads={uploads} />
      )}
      <Textarea
        ref={ta}
        className="ch-rin-ta"
        aria-label={label}
        placeholder={placeholder}
        rows={rows}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onPaste={sink ? picker.onPaste : undefined}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || !onSubmit) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="ch-rin-bar">
        {sink && (
          <IconButton
            size="sm"
            label="上传文件"
            icon={<ClipGlyph size={14} />}
            disabled={disabled}
            onClick={() => picker.pick()}
          />
        )}
        <span className="ch-rin-end">{end}</span>
      </div>
      {sink && picker.input}
    </div>
  );
}
