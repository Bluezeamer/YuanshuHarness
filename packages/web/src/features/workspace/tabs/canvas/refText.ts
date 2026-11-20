// 把拖进笔记 / 卡片编辑器的东西变成 markdown 里的引用文本。纯函数。
//   · 树里的笔记与画布 → `[[路径]]`（相对 `.canvas/`，去掉笔记的 `.md`，画布保留 `.canvas`），多个文件一行一条
//   · 文件管理器里的项目文件 → 标准 markdown 链接 `[名字](相对当前文件的路径)`，图片用 `![名字](…)`
// 项目文件在画布所在的目录之内才写相对路径（项目整体挪位置也不失效）；别的主机、目录之外的写
// `[名字](file:主机:绝对路径)`（与聊天里的文件引用同一约定）——相对路径会一路 `../` 出去，换个位置就断。
import type { FileDragItem } from "../files/verdict";

const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|svg)$/i;

/** 树里拖来的笔记 / 画布（相对 `.canvas/` 的树 id：笔记带 `.md`，画布带 `.canvas`）→ wikilink */
export function wikiRefOf(id: string): string {
  return `[[${id.replace(/\.md$/i, "")}]]`;
}

export const wikiRefsOf = (ids: readonly string[]): string =>
  ids.map(wikiRefOf).join("\n");

const segs = (p: string): string[] => p.split("/").filter(Boolean);

/**
 * 从「当前文件所在的目录」到目标文件的相对路径（都是绝对路径、用 `/`）。
 * 例：from `/p/.canvas/产品`、to `/p/docs/a.md` → `../../docs/a.md`。
 */
export function relativePath(fromDir: string, to: string): string {
  const a = segs(fromDir);
  const b = segs(to);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return [...Array(up).fill(".."), ...b.slice(i)].join("/") || ".";
}

/** markdown 链接的地址部分：空格与括号会截断它，编码掉（中文保持原样，读起来直观） */
const encodeHref = (p: string): string =>
  p.replace(
    /[ ()<>]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** 链接文字里的方括号要转义，免得提前结束 */
const escapeText = (t: string): string => t.replace(/[[\]]/g, "\\$&");

export interface ProjectRefCtx {
  /** 当前编辑的文件所在的目录（绝对路径，在画布所在的主机上） */
  fileDir: string;
  /** 画布所在的环境 id；拖来的文件不在这个环境上就写成 file: 引用 */
  env: string;
  /** 画布所在的目录（绝对路径）：拖来的文件在它之内才写相对路径 */
  projectDir: string;
}

const isUnder = (p: string, dir: string): boolean => {
  const d = dir.replace(/\/+$/, "");
  return p === d || p.startsWith(`${d}/`);
};

/** 文件管理器里拖来的项目文件（多选一行一条）→ markdown 链接；文件夹也给链接（指向目录） */
export function projectRefsOf(item: FileDragItem, ctx: ProjectRefCtx): string {
  return item.entries
    .map(({ path: p }) => {
      const name = baseOf(p);
      const bang = IMAGE_RE.test(name) ? "!" : "";
      if (item.env !== ctx.env || !isUnder(p, ctx.projectDir))
        return `${bang}[${escapeText(name)}](file:${item.host}:${encodeHref(p)})`;
      return `${bang}[${escapeText(name)}](${encodeHref(relativePath(ctx.fileDir, p))})`;
    })
    .join("\n");
}

/** 树里拖笔记 / 画布的 dataTransfer 类型：Tree 组件放的通用载荷（节点路径的 JSON 数组） */
export const TREE_DRAG_TYPE = "application/x-yuanshu-tree";

/**
 * 编辑器的 onDropText 用：认得出拖来的是树里的东西（或文件管理器里的文件）才返回文本，认不出返回 null。
 * dragover 阶段浏览器不给读载荷内容，只能看类型；所以 dragover 时只要「是我们认的拖拽」就返回空串表示放行，
 * drop 时才真的读（树里的）或取（文件管理器的单例）。getFileDrag 由调用方传入，免得这个文件依赖界面状态。
 */
export function dropTextOf(
  e: Pick<DragEvent, "type" | "dataTransfer">,
  ctx: ProjectRefCtx & { getFileDrag(): FileDragItem | null },
): string | null {
  const dt = e.dataTransfer;
  const file = ctx.getFileDrag();
  const fromTree = !!dt && Array.from(dt.types).includes(TREE_DRAG_TYPE);
  if (!file && !fromTree) return null;
  if (e.type === "dragover") return "";
  if (file) return projectRefsOf(file, ctx);
  try {
    const ids = JSON.parse(dt?.getData(TREE_DRAG_TYPE) ?? "[]") as unknown;
    if (!Array.isArray(ids)) return null;
    const refs = ids.filter((x): x is string => typeof x === "string");
    return refs.length > 0 ? wikiRefsOf(refs) : null;
  } catch {
    return null;
  }
}

/**
 * 编辑中的文件所在目录的绝对路径：file 是相对 `.canvas/` 的路径（笔记 `产品/调研.md`、灵感卡 `想法.cards/风险.md`），
 * dir 是画布所在目录的绝对路径。新卡片（还没存成文件）没有路径，按它所属画布的根算（`.canvas/` 本身）。
 */
export function fileDirOf(dir: string, file: string): string {
  const root = `${dir.replace(/\/+$/, "")}/.canvas`;
  const i = file.lastIndexOf("/");
  return i < 0 || file.startsWith("::new:")
    ? root
    : `${root}/${file.slice(0, i)}`;
}
