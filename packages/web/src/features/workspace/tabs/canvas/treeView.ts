// 画布标签树栏的浏览状态：哪些文件夹是展开的、列表滚到哪。按（环境 + 目录）记在浏览器里，下次打开、
// 悬浮树栏收起又展开（树组件会被卸载）都能还原。读写走 app/localState，换算是纯函数，单测见 treeView.test.ts。
import {
  localKey,
  readLocal,
  writeLocalSoon,
} from "../../../../app/localState";

export interface TreeView {
  /** 展开的文件夹（树 id） */
  open: string[];
  scroll: number;
}

export const treeViewKey = (env: string, dir: string): string =>
  localKey("canvas.treeview", env, dir);

const parse = (v: unknown): TreeView | null => {
  if (typeof v !== "object" || v === null) return null;
  const { open, scroll } = v as Partial<TreeView>;
  return {
    open: Array.isArray(open)
      ? open.filter((x): x is string => typeof x === "string")
      : [],
    scroll:
      typeof scroll === "number" && Number.isFinite(scroll)
        ? Math.max(0, scroll)
        : 0,
  };
};

export const readTreeView = (key: string): TreeView =>
  readLocal(key, parse) ?? { open: [], scroll: 0 };

/** 防抖写：展开 / 滚动都频繁，落最后一次；关页面前会先落下 */
export const writeTreeView = (key: string, v: TreeView): void =>
  writeLocalSoon(key, v);

/** 「全部展开 / 全部折叠」一个按钮：有展开着的文件夹就全部折叠，一个都没展开就全部展开 */
export function toggleAll(
  open: ReadonlySet<string>,
  folders: readonly string[],
): { open: Set<string>; anyOpen: boolean } {
  const anyOpen = folders.some((f) => open.has(f));
  return { anyOpen, open: anyOpen ? new Set() : new Set(folders) };
}
