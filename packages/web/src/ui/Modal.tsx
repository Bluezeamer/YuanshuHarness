import type { ReactNode, RefObject } from "react";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { CloseIcon } from "./icons";
import { LayerDepth, trapTab, useDismissLayer, useFocusScope } from "./overlay";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  // 标题下一行小字，说明这个弹窗要做什么
  description?: ReactNode;
  // 页脚按钮区；唯一主按钮放最右
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  // 打开时优先聚焦的元素，缺省为内容里第一个可聚焦元素
  initialFocus?: RefObject<HTMLElement | null>;
  // 点击遮罩是否关闭；有未保存输入的表单应设为 false
  dismissOnScrim?: boolean;
  closeLabel?: string;
  /** 追加到卡片上的类，给特定弹窗调宽高。 */
  className?: string;
  children: ReactNode;
};

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = "md",
  initialFocus,
  dismissOnScrim = true,
  closeLabel = "关闭",
  className,
  children,
}: ModalProps) {
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const uid = useId();
  const depth = useDismissLayer(open, onClose);
  useFocusScope(open, card, initialFocus, body);
  if (!open) return null;
  return createPortal(
    <LayerDepth.Provider value={depth}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 点遮罩关闭只是指针便利，键盘路径是 Esc 与右上角关闭按钮 */}
      <div
        className="u-modal"
        data-full={size === "full" || undefined}
        role="presentation"
        onMouseDown={(e) => {
          // 只认直接按在遮罩上的点击，从卡片内拖出来松手不算
          if (dismissOnScrim && e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={card}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${uid}-title`}
          aria-describedby={description ? `${uid}-desc` : undefined}
          tabIndex={-1}
          data-size={size}
          className={cx("u-mcard", className)}
          onKeyDown={(e) => trapTab(e, card.current)}
        >
          <header className="u-mhead">
            <div className="u-mhead-mid">
              <h2 className="u-mtitle t-block" id={`${uid}-title`}>
                {title}
              </h2>
              {description && (
                <p className="u-msub t-aux" id={`${uid}-desc`}>
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              className="u-icon-btn"
              aria-label={closeLabel}
              title={closeLabel}
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </header>
          <div ref={body} className="u-mbody">
            {children}
          </div>
          {footer && <footer className="u-mfoot">{footer}</footer>}
        </div>
      </div>
    </LayerDepth.Provider>,
    document.body,
  );
}
