// canvas 标签树栏的偏好：固定还是悬浮、宽度。记在浏览器里，所有画布标签共用。
// 读写走 app/localState，换算是纯函数，单测见 treePrefs.test.ts。
import { localKey, readLocal, writeLocal } from "../../../../app/localState";

export type TreeMode = "fixed" | "float";

export interface TreePrefs {
  mode: TreeMode;
  width: number;
}

export const TREE_MIN = 160;
export const TREE_MAX = 480;
export const TREE_DEFAULT = 240;
/** 主区至少要给画布 / 笔记留这么宽；固定的树栏放进去之后不够就自动悬浮 */
export const MAIN_MIN = 320;
/** 左边常驻的窄栏宽度（悬停它展开悬浮树栏，上面有快捷按钮） */
export const RAIL_W = 40;

const KEY = localKey("canvas.tree");

export const clampWidth = (n: number): number =>
  Math.min(TREE_MAX, Math.max(TREE_MIN, Math.round(n)));

const parse = (v: unknown): TreePrefs | null => {
  if (typeof v !== "object" || v === null) return null;
  const { mode, width } = v as Partial<TreePrefs>;
  return {
    mode: mode === "fixed" || mode === "float" ? mode : "fixed",
    width:
      typeof width === "number" && Number.isFinite(width)
        ? clampWidth(width)
        : TREE_DEFAULT,
  };
};

export const readPrefs = (): TreePrefs =>
  readLocal(KEY, parse) ?? { mode: "fixed", width: TREE_DEFAULT };

export const writePrefs = (p: TreePrefs): void => writeLocal(KEY, p);

/** 标签这么宽时，固定模式放不下（窄栏 + 树栏 + 主区会窄于 MAIN_MIN）：强制悬浮，不改用户的偏好 */
export const mustFloat = (tabWidth: number, width: number): boolean =>
  tabWidth > 0 && tabWidth < RAIL_W + width + MAIN_MIN;
