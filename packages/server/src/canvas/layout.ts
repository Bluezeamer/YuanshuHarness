// 画布文件夹的逻辑路径与命名（canvas.md §2）：纯函数，路径一律相对 `.canvas/`、用 `/`。
// 画布名是相对 `.canvas/` 的路径、不带 `.canvas` 后缀（`想法`、`产品/时间线`、旧的 `boards/想法`）；
// 卡片文件夹与资源文件夹跟在画布文件旁边；笔记是同一棵树里的 `.md` 文件。

export const CANVAS_DIR = ".canvas";
export const INDEX = "index.md";

export const boardFile = (name: string): string => `${name}.canvas`;
export const cardsDir = (name: string): string => `${name}.cards`;
export const cardFile = (board: string, name: string): string =>
  `${board}.cards/${name}.md`;
/** 粘贴 / 拖进画布的资源（图片、视频……）放在这块画布自己的资源文件夹里，随画布改名与删除 */
export const assetsDir = (name: string): string => `${name}.assets`;
/**
 * 笔记自己的图片资源夹：放在笔记所在文件夹的隐藏文件夹 `.assets/` 里、再按笔记名分一层，
 * `产品/访谈.md` → `产品/.assets/访谈`（笔记一多也不会把文件夹淹没）。
 */
export const noteAssetsDir = (note: string): string => {
  const slash = note.lastIndexOf("/");
  const stem = note.slice(slash + 1).replace(/\.md$/, "");
  return `${slash < 0 ? "" : note.slice(0, slash + 1)}${NOTE_ASSETS}/${stem}`;
};
/** 资源文件夹里放大文件的子文件夹：整个子文件夹不进画布的 git 历史（见 git.ts 的 ensure） */
export const LARGE_DIR = "_large";
/** 笔记图片资源夹的隐藏文件夹名（见 noteAssetsDir） */
export const NOTE_ASSETS = ".assets";

const ILLEGAL = /[/\\:*?"<>|]/g;
const NAME_MAX = 80;
// 控制字符单独过滤：写成正则的字符区间会触发 noControlCharactersInRegex。
const isControl = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return n < 0x20 || n === 0x7f;
};

/** 文件名清洗：去掉非法字符、首尾空白与点，空白折叠，限 80 字符；空结果交给调用方换默认名。 */
export function sanitizeName(raw: string): string {
  const cleaned = [...raw]
    .filter((c) => !isControl(c))
    .join("")
    .replace(ILLEGAL, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  return cleaned.slice(0, NAME_MAX).trim();
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** 随手记的默认名：本地时间 `YYYYMMDD-HHmmss`。 */
export function timeName(now: Date): string {
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** 重名加 ` (2)`、` (3)`…，比较不区分大小写。 */
export function uniqueName(taken: ReadonlySet<string>, base: string): string {
  const used = new Set([...taken].map((s) => s.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const next = `${base} (${n})`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

export type CanvasPathKind =
  | "board"
  | "card"
  | "asset"
  | "noteAsset"
  | "note"
  | "index"
  | "ref"
  | "other";

const BOARD_RE = /^(.+)\.canvas$/;
const CARD_RE = /^(.+)\.cards\/([^/]+\.md)$/;
const ASSET_RE = /^(.+)\.assets\/[^/]+(?:\/[^/]+)*$/;
/** 笔记的图片：`<文件夹>/.assets/<笔记名>/<文件>`（要先于 ASSET_RE 判：`产品/.assets/…` 也会被它匹配成画布「产品/」的资源） */
const NOTE_ASSET_RE = /^(?:.+\/)?\.assets\/[^/]+\/[^/]+(?:\/[^/]+)*$/;
const NOTE_RE = /\.md$/;

/** 路径相对 `.canvas/` 时属于哪一类；卡片带所属画布名。 */
export function classify(rel: string): {
  kind: CanvasPathKind;
  board?: string;
} {
  const board = BOARD_RE.exec(rel);
  if (board) return { kind: "board", board: board[1] };
  const card = CARD_RE.exec(rel);
  if (card) return { kind: "card", board: card[1] };
  if (NOTE_ASSET_RE.test(rel)) return { kind: "noteAsset" };
  const asset = ASSET_RE.exec(rel);
  if (asset) return { kind: "asset", board: asset[1] };
  if (rel === INDEX) return { kind: "index" };
  if (rel.startsWith("../")) return { kind: "ref" };
  // 笔记：树里任意位置的 .md；点开头的目录（.git）里的不算
  if (NOTE_RE.test(rel) && !rel.split("/").some((s) => s.startsWith(".")))
    return { kind: "note" };
  return { kind: "other" };
}

/** 一个相对路径形式的名字（`产品/时间线`）每一段都已是清洗过的文件名（不含 `..`、空段）。 */
export const isCleanPath = (raw: string): boolean =>
  raw !== "" &&
  raw.split("/").every((seg) => seg !== "" && sanitizeName(seg) === seg);

/**
 * 用户建的文件夹路径：每段都是清洗过的名字，且不以 `.cards` / `.assets`（画布自己的文件夹，树里不显示）
 * 或 `.md` / `.canvas`（会和笔记、画布在树里撞 id）结尾。
 */
export const isFolderPath = (raw: string): boolean =>
  isCleanPath(raw) &&
  raw.split("/").every((seg) => !/\.(?:cards|assets|md|canvas)$/i.test(seg));

/** 把画布名 / 笔记名清洗成路径：每一段各自清洗，空段丢掉；全空返回空串。 */
export function sanitizePath(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .split("/")
    .map(sanitizeName)
    .filter((s) => s !== "")
    .join("/");
}

/**
 * 把人或 agent 写的名字变成笔记路径（相对 `.canvas/`）：去掉开头的 `.canvas/` 与结尾的 `.md`，逐段清洗，补上 `.md`。
 * 不能做笔记路径时给出原因：empty 清洗后什么都不剩；index 是生成的索引；folder 落在卡片或资源文件夹里。
 */
export function notePathOf(
  raw: string,
): { path: string } | { error: "empty" | "index" | "folder" } {
  const clean = sanitizePath(
    raw
      .trim()
      .replace(/^(?:\.?\/)?\.canvas\//, "")
      .replace(/\.md$/i, ""),
  );
  if (clean === "") return { error: "empty" };
  const path = `${clean}.md`;
  if (path === INDEX) return { error: "index" };
  if (classify(path).kind !== "note") return { error: "folder" };
  return { path };
}

/** 路径的目录部分（带结尾斜杠，没有目录是空串）与最后一段。 */
export const splitLeaf = (p: string): { dir: string; leaf: string } => {
  const i = p.lastIndexOf("/");
  return { dir: p.slice(0, i + 1), leaf: p.slice(i + 1) };
};

/** 接口的 path 参数：规范化后不含 `..`、不是绝对路径、不为空（拒绝逃出 `.canvas/`）。 */
export function insideCanvas(rel: string): boolean {
  if (rel === "" || rel.includes("\0")) return false;
  if (rel.startsWith("/") || rel.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  const segs = rel.split("/");
  if (segs.includes("..")) return false;
  return segs.some((s) => s !== "" && s !== ".");
}
