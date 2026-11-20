import type { ReactNode } from "react";
import { useId } from "react";
import { Button } from "./Button";
import { InlineNotice } from "./InlineNotice";
import { Modal, type ModalProps } from "./Modal";

export type FormDialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: ModalProps["size"];
  /** 主按钮文案，缺省「确定」 */
  confirmLabel?: string;
  /** 取消按钮文案，缺省「取消」 */
  cancelLabel?: string;
  /** 表单没填完时为 false，主按钮置灰 */
  canSubmit?: boolean;
  busy?: boolean;
  /** 失败文案留在弹窗里；成功由使用方关闭弹窗 */
  error?: string | null;
  onSubmit: () => void;
  /** 页脚左侧的次要操作，如「恢复默认」「复制一份」 */
  aside?: ReactNode;
  /** 只读：不画主按钮，取消按钮改叫「关闭」 */
  readOnly?: boolean;
  children: ReactNode;
};

// 表单弹窗：页脚统一为「[左侧次要操作] …… 取消 · 确定」，回车提交，有输入时不点遮罩关闭。
// 纯确认（删除、放弃）用 ConfirmDialog。
export function FormDialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  confirmLabel = "确定",
  cancelLabel,
  canSubmit = true,
  busy,
  error,
  onSubmit,
  aside,
  readOnly,
  children,
}: FormDialogProps) {
  const formId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      size={size}
      title={title}
      dismissOnScrim={false}
      {...(description ? { description } : {})}
      footer={
        <>
          {aside && <div className="u-form-aside">{aside}</div>}
          <Button variant="ghost" size="lg" onClick={onClose}>
            {cancelLabel ?? (readOnly ? "关闭" : "取消")}
          </Button>
          {!readOnly && (
            <Button
              variant="primary"
              size="lg"
              type="submit"
              form={formId}
              loading={busy ?? false}
              disabled={!canSubmit}
            >
              {confirmLabel}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="u-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit && !busy && !readOnly) onSubmit();
        }}
      >
        {children}
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </form>
    </Modal>
  );
}
