// 各种节点共用的零件：连接点、缩放柄、卡片上方的标注行、卡片里的 markdown。
import { Handle, NodeResizer, Position } from "@xyflow/react";
import {
  type ComponentProps,
  memo,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { Dot } from "../../../../ui";
import { cx } from "../../../../ui/cx";
import { MarkdownView } from "../preview/MarkdownView";
import { useNodeCtx } from "./nodeCtx";

const SIDES: ReadonlyArray<readonly [string, Position]> = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
];

// 四个方向的点既能出线也能收线；id 就是 JSON Canvas 里的 fromSide / toSide。
// 点本体 2px、贴在卡片边上（线就接在边上）；32px 的感应区、悬停圈与小圆点都画在样式里。
// 线拖到卡片中间松手也算连上：由画布在松手时按落点判断（CanvasFlow 的 onConnectEnd）。
export function Handles() {
  return (
    <>
      {SIDES.map(([id, position]) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={position}
          className="cv-handle"
        />
      ))}
    </>
  );
}

/** 缩放的最小尺寸；缩放时的吸附（CanvasFlow）也要知道，吸完不能比它还小 */
export const MIN_NODE = { w: 160, h: 72 };

/** keepAspectRatio：图片等多媒体只能等比例缩放，否则会出现空白 */
export function Resizer({
  selected,
  keepAspectRatio = false,
}: {
  selected: boolean | undefined;
  keepAspectRatio?: boolean;
}) {
  const { commitLayout } = useNodeCtx();
  return (
    <NodeResizer
      isVisible={!!selected}
      minWidth={MIN_NODE.w}
      minHeight={MIN_NODE.h}
      keepAspectRatio={keepAspectRatio}
      autoScale={false}
      onResizeEnd={(e) => {
        commitLayout();
        // 编辑中拖缩放柄会把键盘焦点带走（Esc 就收不起编辑了）：缩放完把焦点还给这张卡片里的编辑器
        const node = (e.sourceEvent.target as Element | null)?.closest(
          ".cv-node",
        );
        node?.querySelector<HTMLElement>(".cm-content")?.focus();
      }}
    />
  );
}

/**
 * 节点里放内容的那块（卡片、笔记、引用）：内容比它高时直接显示滚动条（不用先选中），让人一眼看出显示的不全。
 * - 没选中也没在编辑时滚动条只是提示，不能交互（样式里 pointer-events: none，鼠标落在下面的卡片上：拖的是卡片、
 *   中键拖的是画布），选中或编辑之后才能拖；
 * - 选中后按在滚动条上是拖滚动条，不是拖卡片：库在节点外层听 mousedown，这里在它冒泡上去之前拦住
 *   （滚动条的宽度由 offsetWidth 与 clientWidth 之差得到，换成屏幕像素再比）；
 * - 中键按下一律 preventDefault：不然 Chrome 会在可滚动的东西上显示自动滚动的标识，一边拖画布一边滚内容；
 * - 内容溢出时给所在节点打 data-scroll，样式据此把右边的缩放感应带挪到边的外侧，免得压在滚动条上。
 */
export function NodeBody({
  className,
  children,
  ...rest
}: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const grab = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
      const bar = el.offsetWidth - el.clientWidth;
      if (bar <= 0) return;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.right - bar * (r.width / el.offsetWidth))
        e.stopPropagation();
    };
    el.addEventListener("mousedown", grab);
    const node = el.closest(".cv-node");
    const mark = () =>
      node?.toggleAttribute(
        "data-scroll",
        el.scrollHeight > el.clientHeight + 1,
      );
    mark();
    // 内容长高（编辑、预览换了）或卡片被缩放都要重新判断
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("mousedown", grab);
      ro?.disconnect();
      node?.removeAttribute("data-scroll");
    };
  }, []);
  return (
    <div ref={ref} className={cx("cv-nbody cv-scroll", className)} {...rest}>
      {children}
    </div>
  );
}

/** 卡片上方的一行灰字；dirty 时右端标「未保存」（这张卡片的正文改过还没保存） */
export function NodeLabel({
  children,
  dirty,
}: {
  children?: ReactNode;
  dirty?: boolean | undefined;
}) {
  return (
    <div className="cv-label t-aux">
      {children}
      {dirty && (
        <span className="cv-labtail">
          <Dot tone="warn" size="sm" />
          未保存
        </span>
      )}
    </div>
  );
}

/** 卡片里的 markdown：轻量模式（mermaid 只显示源码）；文本不变就不重新解析 */
export const CardMarkdown = memo(function CardMarkdown({
  text,
}: {
  text: string;
}) {
  return <MarkdownView text={text} light className="cv-md" />;
});
