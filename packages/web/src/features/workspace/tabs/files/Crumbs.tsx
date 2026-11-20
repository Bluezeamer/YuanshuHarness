// 面包屑：每一段都是按钮，点击回到该级目录，也是拖放的落点；
// 路径放不下时只露出末尾（切换路径后滚到最右，左端淡出），当前目录始终看得到。
import { Fragment, useEffect, useRef } from "react";
import { Button } from "../../../../ui";
import { crumbsOf } from "./paths";

export interface CrumbsProps {
  path: string;
  onGo(path: string): void;
  /** 拖拽落点标记：哪一段、移动还是传输 */
  mark?: { path: string; label: string } | null;
}

export function Crumbs({ path, onGo, mark }: CrumbsProps) {
  const box = useRef<HTMLElement>(null);
  const crumbs = crumbsOf(path);
  // 路径变化或容器缩放后：滚到最右，并按是否溢出决定左端要不要淡出
  // biome-ignore lint/correctness/useExhaustiveDependencies: path 变化也要重新量
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      el.scrollLeft = el.scrollWidth;
      if (el.scrollWidth > el.clientWidth + 1) el.dataset.cut = "";
      else delete el.dataset.cut;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [path]);

  return (
    <nav className="ws-fm-crumb" aria-label="当前路径" ref={box}>
      {crumbs.map((c, i) => (
        <Fragment key={c.path}>
          {i > 1 && <span className="ws-fm-sep t-aux">/</span>}
          <Button
            variant="ghost"
            size="sm"
            data-path={c.path}
            data-dz={mark?.path === c.path ? mark.label : undefined}
            aria-current={i === crumbs.length - 1 ? "location" : undefined}
            onClick={() => onGo(c.path)}
          >
            {c.name}
          </Button>
        </Fragment>
      ))}
    </nav>
  );
}
