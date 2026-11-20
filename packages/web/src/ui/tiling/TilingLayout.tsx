// 容器内的平铺式布局：一棵分割树（tree.ts）渲染成并排 / 叠放的格子，格子之间是可拖动的分隔条。
// 叶子由调用方渲染（renderLeaf），这里不认识叶子是什么。拖动期间只改本地尺寸，松手才 onSizes 提交。
// 容器窄于 780px 时左右分栏改成上下堆叠、每格保底 260px，整体纵向滚动。

import {
  Fragment,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "../cx";
import { SplitHandle } from "../SplitHandle";
import { type Branch, isBranch, type Tree } from "./tree";

/** 一侧被拖到 px（占 pairPx 的一部分）后，相邻两格的新权重；其余格不变 */
export function resizePair(
  sizes: readonly number[],
  i: number,
  px: number,
  pairPx: number,
): number[] {
  const a = sizes[i];
  const b = sizes[i + 1];
  if (a === undefined || b === undefined || pairPx <= 0) return [...sizes];
  const pair = a + b;
  const na = Math.min(Math.max((pair * px) / pairPx, pair * 0.02), pair * 0.98);
  const next = [...sizes];
  next[i] = na;
  next[i + 1] = pair - na;
  return next;
}

export interface TilingLayoutProps<L extends object> {
  node: Tree<L>;
  renderLeaf(leaf: L): ReactNode;
  /** 某个分支的权重变了（松手后）；path 是从根起的 children 下标序列 */
  onSizes(path: number[], sizes: number[]): void;
  /** 分隔条的可访问名 */
  handleLabel: string;
  /** 单格最小像素，默认 120 */
  minPx?: number;
  className?: string;
}

export function TilingLayout<L extends object>({
  className,
  ...rest
}: TilingLayoutProps<L>) {
  return (
    <div className={cx("u-tile", className)}>
      <div className="u-tile-scroll">
        <TileNode {...rest} path={[]} />
      </div>
    </div>
  );
}

type NodeProps<L extends object> = Omit<TilingLayoutProps<L>, "className"> & {
  path: number[];
};

function TileNode<L extends object>(props: NodeProps<L>) {
  const { node, renderLeaf, path } = props;
  if (!isBranch(node)) return <>{renderLeaf(node)}</>;
  return <BranchView {...props} branch={node} path={path} />;
}

function BranchView<L extends object>({
  branch,
  renderLeaf,
  onSizes,
  handleLabel,
  minPx = 120,
  path,
}: NodeProps<L> & { branch: Branch<Tree<L>> }) {
  const row = branch.dir === "row";
  const box = useRef<HTMLDivElement>(null);
  const [total, setTotal] = useState(0);
  const [live, setLive] = useState<number[] | null>(null);
  const dragging = useRef(false);
  const latest = useRef<number[]>(branch.sizes);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setTotal(row ? el.clientWidth : el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [row]);

  const sizes = live ?? branch.sizes;
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;

  const commit = (next: number[]) => {
    latest.current = next;
    if (dragging.current) setLive(next);
    else onSizes(path, next);
  };

  return (
    <div
      ref={box}
      className="u-tile-node"
      data-dir={branch.dir}
      data-path={path.join(".")}
    >
      {branch.children.map((child, i) => {
        const pairPx = (((sizes[i] ?? 0) + (sizes[i + 1] ?? 0)) / sum) * total;
        const min = Math.min(minPx, pairPx / 2);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 树节点没有稳定 id，位置即身份
          <Fragment key={i}>
            <div
              className="u-tile-cell"
              data-leaf={!isBranch(child) || undefined}
              style={{ ["--grow" as string]: sizes[i] }}
            >
              <TileNode
                node={child}
                renderLeaf={renderLeaf}
                onSizes={onSizes}
                handleLabel={handleLabel}
                minPx={minPx}
                path={[...path, i]}
              />
            </div>
            {i < branch.children.length - 1 && (
              <SplitHandle
                className="u-tile-gutter"
                aria-label={handleLabel}
                orientation={row ? "vertical" : "horizontal"}
                value={((sizes[i] ?? 0) / sum) * total}
                min={min}
                max={Math.max(min, pairPx - min)}
                defaultValue={pairPx / 2}
                onDragStart={() => {
                  dragging.current = true;
                  latest.current = sizes;
                }}
                onChange={(px) => commit(resizePair(sizes, i, px, pairPx))}
                onDragEnd={() => {
                  dragging.current = false;
                  setLive(null);
                  if (latest.current !== branch.sizes)
                    onSizes(path, latest.current);
                }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
