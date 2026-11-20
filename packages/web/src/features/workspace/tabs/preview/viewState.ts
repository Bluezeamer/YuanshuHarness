// 预览标签的视图状态：预览 / 编辑模式，编辑器的光标与滚动位置。属于某个文件（at），路径对得上才恢复。
export interface PreviewView {
  at: string;
  mode: "preview" | "edit";
  caret: number;
  top: number;
}

const nonNeg = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;

export const parsePreviewView = (v: unknown): PreviewView | null => {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Partial<PreviewView>;
  if (typeof o.at !== "string") return null;
  return {
    at: o.at,
    mode: o.mode === "preview" ? "preview" : "edit",
    caret: nonNeg(o.caret),
    top: nonNeg(o.top),
  };
};
