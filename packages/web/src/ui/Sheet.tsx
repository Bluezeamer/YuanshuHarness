import { type ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { CloseIcon } from "./icons";
import { LayerDepth, useDismissLayer, useFocusScope } from "./overlay";

export type SheetProps = {
  title: ReactNode;
  /** 点遮罩、点关闭键、按 Esc 都走它 */
  onClose: () => void;
  closeLabel?: string;
  /** 追加到抽屉上的类，给特定抽屉改样式。 */
  className?: string;
  children: ReactNode;
};

// 底部抽屉：从下面升起，盖住页面的下半部分，头部不动、内容区自己滚。手机端用（弹层占一条历史，onClose 接返回）。
export function Sheet({
  title,
  onClose,
  closeLabel = "关闭",
  className,
  children,
}: SheetProps) {
  const card = useRef<HTMLElement>(null);
  const depth = useDismissLayer(true, onClose);
  useFocusScope(true, card);
  return createPortal(
    <LayerDepth.Provider value={depth}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 点遮罩关闭只是指针便利，键盘路径是 Esc 与关闭按钮 */}
      <div
        className="u-sheet-wrap"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <section
          ref={card}
          className={cx("u-sheet", className)}
          role="dialog"
          aria-label={String(title)}
          tabIndex={-1}
        >
          <header className="u-sheet-head">
            <h2 className="u-sheet-title t-block">{title}</h2>
            <IconButton
              label={closeLabel}
              icon={<CloseIcon />}
              onClick={onClose}
            />
          </header>
          <div className="u-sheet-body">{children}</div>
        </section>
      </div>
    </LayerDepth.Provider>,
    document.body,
  );
}
