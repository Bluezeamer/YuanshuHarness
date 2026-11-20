// 文件管理器标签的视图状态：版本视图 / 显示隐藏文件是整个标签的；选中与滚动属于某个目录（at），目录对得上才恢复。
export interface FilesView {
  view: "files" | "git";
  hidden: boolean;
  /** 选中与滚动是在哪个目录里记的 */
  at: string;
  sel: string[];
  picked: boolean;
  scroll: number;
}

export const parseFilesView = (v: unknown): FilesView | null => {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Partial<FilesView>;
  if (typeof o.at !== "string") return null;
  return {
    view: o.view === "git" ? "git" : "files",
    hidden: o.hidden === true,
    at: o.at,
    sel: Array.isArray(o.sel)
      ? o.sel.filter((x): x is string => typeof x === "string")
      : [],
    picked: o.picked === true,
    scroll:
      typeof o.scroll === "number" && Number.isFinite(o.scroll)
        ? Math.max(0, o.scroll)
        : 0,
  };
};
