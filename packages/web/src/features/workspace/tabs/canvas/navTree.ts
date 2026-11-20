// canvas 标签左侧树与服务端清单之间的换算：清单 → 树节点、节点 → 画布 / 笔记 / 文件夹、改名与挪动要做什么、
// `[[链接]]` 指向哪里。纯函数。树节点的 id 是相对 `.canvas/` 的路径：文件夹不带后缀，笔记带 `.md`，画布带 `.canvas`。
import type { BoardList } from "../../../../api/canvas";
import { leafOf, parentOf, type TreeNode } from "../../../../ui";

export type Ref =
  | { kind: "folder"; path: string }
  | { kind: "board"; name: string }
  | { kind: "note"; path: string };

export const BOARD_EXT = ".canvas";
export const boardId = (name: string): string => `${name}${BOARD_EXT}`;

const stripExt = (s: string, ext: string): string =>
  s.toLowerCase().endsWith(ext) ? s.slice(0, -ext.length) : s;

/**
 * 快捷新建的默认位置（"" 是根）：树里选中的优先——选中文件夹就在它里面，选中画布 / 笔记就在它所在的文件夹；
 * 其次是主区打开的东西所在的文件夹；什么都没有就是根。选中的行已经不在清单里（被删、被挪走）当没选。
 */
export function newFolderOf(
  nodes: readonly TreeNode[],
  picked: string | null,
  viewId: string | null,
): string {
  const hit = picked === null ? undefined : nodes.find((n) => n.id === picked);
  if (hit) return hit.kind === "folder" ? hit.id : parentOf(hit.id);
  return viewId === null ? "" : parentOf(viewId);
}

/** 清单 → 树节点；画布与笔记的显示名去掉后缀 */
export function nodesOf(list: BoardList | null): TreeNode[] {
  if (!list) return [];
  return [
    ...list.folders.map((f): TreeNode => ({ id: f, kind: "folder" })),
    ...list.boards.map(
      (b): TreeNode => ({
        id: boardId(b.name),
        kind: "item",
        label: leafOf(b.name),
      }),
    ),
    ...list.notes.map(
      (n): TreeNode => ({
        id: n,
        kind: "item",
        label: stripExt(leafOf(n), ".md"),
      }),
    ),
  ];
}

export function refOf(node: TreeNode): Ref {
  if (node.kind === "folder") return { kind: "folder", path: node.id };
  return node.id.endsWith(BOARD_EXT)
    ? { kind: "board", name: node.id.slice(0, -BOARD_EXT.length) }
    : { kind: "note", path: node.id };
}

export const idOfRef = (r: Ref): string =>
  r.kind === "board" ? boardId(r.name) : r.kind === "note" ? r.path : r.path;

// ── 改名 ──

const BAD_CHARS = /[\\/:*?"<>|]/;
const BAD_FOLDER_END = /\.(?:cards|assets|md|canvas)$/i;

/** 行内改名：新的完整路径（树节点 id 的形式），或给用户看的错误。newName 是输入框里的最后一段。 */
export function renameTarget(
  node: TreeNode,
  newName: string,
  taken: ReadonlySet<string>,
): { to: string } | { error: string } {
  const name = newName.trim();
  if (name === "") return { error: "名字不能为空" };
  if (BAD_CHARS.test(name)) return { error: '名字里不能有 \\ / : * ? " < > |' };
  if (name.startsWith(".")) return { error: "名字不能以点开头" };
  const dir = parentOf(node.id);
  const prefix = dir === "" ? "" : `${dir}/`;
  let leaf: string;
  const ref = refOf(node);
  if (ref.kind === "folder") {
    if (BAD_FOLDER_END.test(name))
      return { error: "文件夹名不能以 .md .canvas .cards .assets 结尾" };
    leaf = name;
  } else if (ref.kind === "board") {
    leaf = `${stripExt(name, BOARD_EXT)}${BOARD_EXT}`;
  } else {
    leaf = `${stripExt(name, ".md")}.md`;
  }
  const to = `${prefix}${leaf}`;
  if (to !== node.id && taken.has(to)) return { error: "已有同名的" };
  return { to };
}

// ── 挪动 ──

/** 一次挪动：folder / note 的 from、to 是树 id（路径）；board 的是画布名（没有 `.canvas` 后缀） */
export interface MoveOp {
  kind: Ref["kind"];
  from: string;
  to: string;
}

/** 树里拖拽（或改名）产生的 { id, to }（都是树 id）→ 要调的接口 */
export function opsForMoves(
  nodes: readonly TreeNode[],
  moves: ReadonlyArray<{ id: string; to: string }>,
): MoveOp[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: MoveOp[] = [];
  for (const m of moves) {
    const node = byId.get(m.id);
    if (!node) continue;
    const ref = refOf(node);
    out.push(
      ref.kind === "board"
        ? { kind: "board", from: ref.name, to: stripExt(m.to, BOARD_EXT) }
        : { kind: ref.kind, from: m.id, to: m.to },
    );
  }
  return out;
}

const fromId = (op: MoveOp): string =>
  op.kind === "board" ? boardId(op.from) : op.from;
const toId = (op: MoveOp): string =>
  op.kind === "board" ? boardId(op.to) : op.to;

/** 一个树 id 经过这批挪动之后在哪里（文件夹被挪时里面的一起走；没被挪到的原样返回） */
export function movedId(id: string, ops: readonly MoveOp[]): string {
  for (const op of ops) {
    if (op.kind === "folder") {
      if (id === op.from || id.startsWith(`${op.from}/`))
        return op.to + id.slice(op.from.length);
    } else if (id === fromId(op)) return toId(op);
  }
  return id;
}

/** 这个树 id 是否在被删除 / 挪动的这些树 id 里（或在其中某个文件夹之下） */
export const isWithin = (id: string, roots: readonly string[]): boolean =>
  roots.some((r) => id === r || id.startsWith(`${r}/`));

/** 拖到 folder 里会不会撞名：目标位置已经有同 id 的东西 */
export function clashes(
  nodes: readonly TreeNode[],
  dragged: readonly TreeNode[],
  folder: string,
): boolean {
  const ids = new Set(nodes.map((n) => n.id));
  return dragged.some((d) => {
    const to = folder === "" ? leafOf(d.id) : `${folder}/${leafOf(d.id)}`;
    return to !== d.id && ids.has(to);
  });
}

// ── 删除 ──

/** 要删的这些节点（含文件夹里的）一共涉及多少文件夹、画布、笔记 */
export function countWithin(
  nodes: readonly TreeNode[],
  roots: readonly string[],
): { folders: number; boards: number; notes: number } {
  const c = { folders: 0, boards: 0, notes: 0 };
  for (const n of nodes) {
    if (!isWithin(n.id, roots)) continue;
    const k = refOf(n).kind;
    if (k === "folder") c.folders += 1;
    else if (k === "board") c.boards += 1;
    else c.notes += 1;
  }
  return c;
}

// ── [[链接]] ──

/** 与服务端 canvas/wikilink.ts 的规范化一致：反斜杠换成 `/`，去掉开头的 `./`、`/` 与 `.canvas/` */
const normalize = (raw: string): string =>
  raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.?\/)+/, "")
    .replace(/^\.canvas\//, "");

export type LinkTarget =
  | { kind: "note"; path: string }
  | { kind: "board"; name: string };

/** `[[目标]]` 指向清单里的哪一个：先原样、再补 `.md`、再补 `.canvas`；都没有返回 null（调用方可以提示新建） */
export function resolveTarget(
  raw: string,
  list: BoardList | null,
): LinkTarget | null {
  const t = normalize(raw);
  if (t === "" || !list) return null;
  const notes = new Set(list.notes);
  const boards = new Set(list.boards.map((b) => boardId(b.name)));
  for (const c of [t, `${t}.md`, `${t}${BOARD_EXT}`]) {
    if (notes.has(c)) return { kind: "note", path: c };
    if (boards.has(c))
      return { kind: "board", name: c.slice(0, -BOARD_EXT.length) };
  }
  return null;
}

/** 链接指不到时新建笔记用的路径（相对 `.canvas/`，去掉 `.md`） */
export const newNotePathFor = (raw: string): string =>
  stripExt(normalize(raw), ".md");

/** 从树里拖笔记到画布上放置：dataTransfer 里放被拖的笔记路径（JSON 数组，相对 `.canvas/`） */
export const NOTE_DRAG_TYPE = "application/x-yuanshu-canvas-notes";

// ── 新建：位置（文件夹）+ 名字 ──

/** 位置与名字拼成路径；名字是空就以斜杠结尾（只有画布允许，服务端会在那个文件夹里用时间命名） */
export const joinLocation = (folder: string, name: string): string =>
  folder === "" ? name : `${folder}/${name}`;

/** 「位置」下拉的选项：根与所有文件夹；默认位置是个还不存在的文件夹（链接指到的新路径）时也列出来，标「新建」 */
export function locationOptions(
  folders: readonly string[],
  initial: string,
): Array<{ value: string; label: string }> {
  const out = [
    { value: "", label: "根目录" },
    ...folders.map((f) => ({ value: f, label: f })),
  ];
  if (initial !== "" && !folders.includes(initial))
    out.push({ value: initial, label: `${initial}（新建）` });
  return out;
}

// ── 乐观更新：在界面上先预演服务端会做的改变（成功了用服务端回来的清单替换，失败了丢掉预演）──

/**
 * 一个树 id（文件夹不带后缀、笔记带 `.md`、画布带 `.canvas`）经过一次挪动后在哪；
 * 文件夹整体挪走时里面的一起走，前缀要整段匹配。op 的 from / to 对画布是画布名（没有后缀），换成树 id 再比。
 */
const moveId = (id: string, op: MoveOp): string => {
  const from = op.kind === "board" ? boardId(op.from) : op.from;
  const to = op.kind === "board" ? boardId(op.to) : op.to;
  if (op.kind === "folder")
    return id === from || id.startsWith(`${from}/`)
      ? to + id.slice(from.length)
      : id;
  return id === from ? to : id;
};

/** 清单上预演这批挪动 / 改名：画布、笔记、文件夹都按服务端的规则换路径（笔记里 `[[…]]` 的改写不在清单里，不用管） */
export function previewMoves(
  list: BoardList,
  ops: readonly MoveOp[],
): BoardList {
  // 画布名没有后缀、树 id 有：算的时候补上 `.canvas`，算完去掉；文件夹与笔记的清单项本身就是树 id
  const through = (id: string) => ops.reduce((cur, op) => moveId(cur, op), id);
  return {
    ...list,
    folders: list.folders.map(through).sort(),
    boards: list.boards
      .map((b) => ({
        ...b,
        name: through(boardId(b.name)).slice(0, -BOARD_EXT.length),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    notes: list.notes.map(through).sort(),
  };
}

/** 清单上预演删除（树 id；文件夹里的一起去掉） */
export function previewRemove(
  list: BoardList,
  ids: readonly string[],
): BoardList {
  const gone = (id: string) => isWithin(id, ids);
  return {
    ...list,
    folders: list.folders.filter((f) => !gone(f)),
    boards: list.boards.filter((b) => !gone(boardId(b.name))),
    notes: list.notes.filter((n) => !gone(n)),
  };
}

/** 清单上预演新建（树 id：笔记带 .md、画布带 .canvas、文件夹不带后缀）；已存在的不重复加；缺的上级文件夹一并补上 */
export function previewCreate(
  list: BoardList,
  made: { kind: "note" | "board" | "folder"; path: string },
): BoardList {
  const parents = (p: string): string[] => {
    const out: string[] = [];
    for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1))
      out.push(p.slice(0, i));
    return out;
  };
  const folders = new Set(list.folders);
  for (const f of parents(made.path)) folders.add(f);
  if (made.kind === "folder") folders.add(made.path);
  return {
    ...list,
    folders: [...folders].sort(),
    boards:
      made.kind === "board" && !list.boards.some((b) => b.name === made.path)
        ? [...list.boards, { name: made.path, cards: 0, mtimeMs: 0 }].sort(
            (a, b) => (a.name < b.name ? -1 : 1),
          )
        : list.boards,
    notes:
      made.kind === "note" && !list.notes.includes(made.path)
        ? [...list.notes, made.path].sort()
        : list.notes,
  };
}
