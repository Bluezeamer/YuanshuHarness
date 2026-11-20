import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const OPEN_DELAY = 450;
// 刚有卡片收起后的这段时间内，邻近行不再等延迟：扫过一排行时卡片是连贯的。
const WARM_MS = 300;
const GAP = 8;
const EDGE = 8;
let warmUntil = 0;

const cool = () => {
  warmUntil = performance.now() + WARM_MS;
};

/**
 * 列表行的悬停详情卡片：只读、不接鼠标。悬停停留一会儿或键盘聚焦时出现，
 * Esc、按下（点行、点「⋯」）、滚动、指针离开都会收起；按下后到指针离开前不再弹，免得盖住刚打开的菜单。
 * 约定见 ys-ui-design 的 X05。
 */
export function HoverCard({
  card,
  children,
  width,
}: {
  card: ReactNode;
  children: ReactNode;
  /** 卡片内容很少时收窄；缺省 296 */
  width?: number;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const muted = useRef(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const id = useId();

  const arm = () => {
    if (muted.current) return;
    window.clearTimeout(timer.current);
    const wait = performance.now() < warmUntil ? 0 : OPEN_DELAY;
    timer.current = window.setTimeout(() => setOpen(true), wait);
  };
  const disarm = () => {
    window.clearTimeout(timer.current);
    setOpen((was) => {
      if (was) cool();
      return false;
    });
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 卡片出现在行的右侧、与行顶对齐；右侧放不下就翻到左侧，纵向夹在视口内
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const p = panel.current;
    if (!open || !a || !p) return;
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    const right = a.right + GAP;
    const left =
      right + w + EDGE <= window.innerWidth
        ? right
        : Math.max(EDGE, a.left - GAP - w);
    const top = Math.min(
      Math.max(EDGE, a.top - GAP),
      window.innerHeight - h - EDGE,
    );
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      cool();
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [open]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 悬停与聚焦只是触发详情卡片，行里的按钮本身可聚焦，键盘路径不依赖这个容器
    <div
      ref={anchor}
      className="u-hc"
      onPointerEnter={arm}
      onPointerLeave={() => {
        muted.current = false;
        disarm();
      }}
      onPointerDown={() => {
        muted.current = true;
        disarm();
      }}
      onFocus={arm}
      onBlur={disarm}
      onKeyDown={(e) => {
        if (e.key === "Escape") disarm();
      }}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="tooltip"
            className="u-hc-card"
            style={{
              top: pos.top,
              left: pos.left,
              ...(width ? { width } : {}),
            }}
          >
            {card}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 卡片内容的版式：标题、正文、键值对。只放行里没有的信息。 */
export function PeekCard({
  title,
  text,
  facts,
}: {
  title: string;
  text?: string;
  facts?: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <>
      <div className="t-entry u-hc-title">{title}</div>
      {text && <p className="t-plain u-hc-text">{text}</p>}
      {facts && facts.length > 0 && (
        <dl className="u-hc-facts">
          {facts.map(([k, v]) => (
            <div key={k} className="u-hc-fact">
              <dt className="t-aux">{k}</dt>
              <dd className="t-aux">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}
