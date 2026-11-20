import type { ReactNode } from "react";
import { Button } from "./Button";
import { InlineNotice } from "./InlineNotice";
import { Modal } from "./Modal";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  /** 写明影响范围：会清理什么、什么保留 */
  children: ReactNode;
  confirmLabel: string;
  /** 危险（默认，删除 / 吊销 / 卸载）或普通 */
  tone?: "danger" | "primary";
  busy?: boolean;
  /** 失败文案留在弹窗里；成功由使用方关闭弹窗 */
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
};

// 要说明连带影响的二次确认（删工作区、删 Agent、吊销值）；轻量的「点两下」用 ConfirmButton。
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "danger",
  busy,
  error,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant={tone} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="u-confirm t-plain">{children}</div>
      {error && (
        <InlineNotice tone="danger" className="u-confirm-err">
          {error}
        </InlineNotice>
      )}
    </Modal>
  );
}
