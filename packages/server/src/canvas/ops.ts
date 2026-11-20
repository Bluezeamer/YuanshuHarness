// `canvas_edit` 一批操作的语义（canvas.md §4）：先在内存快照上整批试算，全部合法才落盘。
// 计划部分不碰 IO：画布文档、卡片文本与「项目文件是否存在」都由调用方取好传进来。
import {
  addFileNode,
  type CanvasDoc,
  hostOf,
  removeNodesByFile,
  renameFileRefs,
  renameFileRefsUnder,
} from "./format.js";
import {
  boardFile,
  cardFile,
  cardsDir,
  classify,
  insideCanvas,
  notePathOf,
  sanitizeName,
  sanitizePath,
  splitLeaf,
  timeName,
  uniqueName,
} from "./layout.js";
import { CanvasError, type CanvasRepo } from "./repo.js";
import { rewriteForMoves } from "./wikilink.js";

export type CanvasOp =
  | { op: "create_canvas"; name: string }
  | { op: "create_card"; canvas: string; name?: string; text: string }
  | { op: "update"; path: string; text?: string; old?: string; new?: string }
  | { op: "rename"; path: string; name: string }
  | { op: "delete"; path: string }
  | { op: "create_note"; path: string; text: string; canvas?: string }
  | { op: "promote"; path: string; to?: string }
  | { op: "place"; canvas: string; file: string; host?: string }
  | { op: "unplace"; canvas: string; file: string; host?: string };

export const OP_NAMES = [
  "create_canvas",
  "create_card",
  "update",
  "rename",
  "delete",
  "create_note",
  "promote",
  "place",
  "unplace",
] as const;

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** 一条操作的形状校验；语义（文件在不在、路径对不对）由 planOps 判。 */
export function isCanvasOp(v: unknown): v is CanvasOp {
  if (!isRec(v)) return false;
  switch (v.op) {
    case "create_canvas":
      return isStr(v.name);
    case "create_card":
      return (
        isStr(v.canvas) &&
        isStr(v.text) &&
        (v.name === undefined || isStr(v.name))
      );
    case "update":
      return (
        isStr(v.path) &&
        (v.text === undefined || isStr(v.text)) &&
        (v.old === undefined || isStr(v.old)) &&
        (v.new === undefined || isStr(v.new))
      );
    case "rename":
      return isStr(v.path) && isStr(v.name);
    case "delete":
      return isStr(v.path);
    case "create_note":
      return (
        isStr(v.path) &&
        isStr(v.text) &&
        (v.canvas === undefined || isStr(v.canvas))
      );
    case "promote":
      return isStr(v.path) && (v.to === undefined || isStr(v.to));
    case "place":
    case "unplace":
      return isStr(v.canvas) && isStr(v.file);
    default:
      return false;
  }
}

/** 试算用的世界：画布文档与卡片文本都是可改的内存副本。 */
export interface OpsWorld {
  /** 画布名 → 文档 */
  boards: Map<string, CanvasDoc>;
  /** 卡片相对路径 → 文本 */
  cards: Map<string, string>;
  /** 笔记相对路径（相对 .canvas/）→ 文本 */
  notes: Map<string, string>;
  /** 画布名 → 资源文件夹里现有卡片名（不含 .md），用来避让重名 */
  cardNames: Map<string, Set<string>>;
  /** 项目文件（相对项目目录）是否存在 */
  projectFile: (rel: string) => boolean;
  /** 别的主机上的文件（环境 id + 绝对路径）：是文件 / 不存在 / 那台主机现在连不上 */
  remoteFile: (host: string, abs: string) => "file" | "missing" | "unreachable";
}

/** 试算得出的落盘步骤。 */
export type OpsStep =
  | { kind: "create_canvas"; name: string }
  | { kind: "create_card"; canvas: string; name: string; text: string }
  | { kind: "write_card"; path: string; text: string }
  | { kind: "rename_card"; path: string; name: string }
  | { kind: "rename_canvas"; from: string; name: string }
  | { kind: "delete_card"; path: string }
  | { kind: "delete_canvas"; name: string }
  | { kind: "create_note"; path: string; text: string }
  | { kind: "write_note"; path: string; text: string }
  | { kind: "rename_note"; path: string; to: string }
  | { kind: "delete_note"; path: string }
  | { kind: "promote"; path: string; to: string }
  | { kind: "place"; canvas: string; file: string; host?: string }
  | { kind: "unplace"; canvas: string; file: string; host?: string };

const HINT = "Read .canvas/index.md for the current paths.";

/** 一条操作不合法：带序号与操作名，外层拼成 `Operation <n> (<op>): …`。 */
export class CanvasOpError extends Error {
  constructor(
    readonly index: number,
    readonly op: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(index: number, op: CanvasOp, message: string): never {
  throw new CanvasOpError(index, op.op, message);
}

const cardPrefix = (board: string): string => `${cardsDir(board)}/`;
const cardBase = (rel: string): string =>
  rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/, "");

/** 文本里 needle 出现的次数（空串不算出现）。 */
const countOf = (text: string, needle: string): number => {
  if (needle === "") return 0;
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1))
    n++;
  return n;
};

/** `update / rename / delete / promote` 的路径校验：只能作用于卡片、笔记与画布文件。 */
function pathKind(
  raw: string,
  index: number,
  op: CanvasOp,
): { kind: "card" | "board" | "note"; board: string } {
  const c = classify(raw);
  if (c.kind === "ref")
    fail(
      index,
      op,
      `"${raw}" is a project file reference; it belongs to the project, change it with the usual file tools.`,
    );
  if (!insideCanvas(raw))
    fail(
      index,
      op,
      `"${raw}" is not a path inside .canvas/ (paths are relative to .canvas/, no "..").`,
    );
  if (c.kind === "index")
    fail(
      index,
      op,
      "index.md is generated and read-only; canvas_edit cannot change it.",
    );
  if (c.kind === "asset" || c.kind === "noteAsset")
    fail(
      index,
      op,
      `"${raw}" is a media file the user pasted into the canvas; canvas_edit cannot change it.`,
    );
  if (c.kind === "other")
    fail(
      index,
      op,
      `"${raw}" is not a canvas, a card or a note (expected <canvas>.canvas, <canvas>.cards/<card>.md or a .md note).`,
    );
  return { kind: c.kind as "card" | "board" | "note", board: c.board ?? "" };
}

const boardOf = (
  world: OpsWorld,
  name: string,
  index: number,
  op: CanvasOp,
): CanvasDoc => {
  const clean = sanitizePath(name);
  const doc = world.boards.get(clean);
  if (doc === undefined)
    fail(
      index,
      op,
      `canvas "${name}" does not exist. Existing canvases: ${
        [...world.boards.keys()].join(", ") || "(none)"
      }.`,
    );
  return doc;
};

/** 画布 / 笔记改名时，世界里每篇笔记正文里的 [[…]] 跟着改（与 repo 落盘时做的一样）；要在世界里的名字改掉之前调。 */
function rewriteWorldLinks(
  world: OpsWorld,
  moves: ReadonlyMap<string, string>,
): void {
  const known = new Set([
    ...[...world.boards.keys()].map(boardFile),
    ...world.notes.keys(),
  ]);
  for (const [path, text] of world.notes) {
    const next = rewriteForMoves(text, moves, known);
    if (next !== text) world.notes.set(path, next);
  }
}

/** 笔记路径：相对 .canvas/，逐段清洗、缺 .md 补上；不能是 index.md，也不能落在卡片或资源文件夹里。 */
function notePath(raw: string, index: number, op: CanvasOp): string {
  const r = notePathOf(raw);
  if ("path" in r) return r.path;
  if (r.error === "empty")
    fail(
      index,
      op,
      `"${raw}" gives an empty note path; use a path like 设计原则 or 产品/用户研究.`,
    );
  if (r.error === "index")
    fail(
      index,
      op,
      "index.md is generated and read-only; choose another name.",
    );
  fail(
    index,
    op,
    `"${raw}" would sit inside a card or asset folder; put the note elsewhere under .canvas/.`,
  );
}

/**
 * place / unplace 的 file 相对项目目录，所以树里的笔记写成 `.canvas/<相对路径>`；
 * 不是 `.canvas/` 开头返回 null，是但不是笔记就报错（灵感卡属于它自己的画布，用 delete 删）。
 */
function noteRefOf(
  world: OpsWorld,
  raw: string,
  index: number,
  op: CanvasOp,
): string | null {
  const file = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!file.startsWith(".canvas/")) return null;
  const rel = file.slice(".canvas/".length);
  if (!world.notes.has(rel))
    fail(
      index,
      op,
      `"${raw}" is not a note. Only notes (.md files in the .canvas/ tree, outside card folders) can be placed on a board; idea cards belong to their own board (delete removes one). ${HINT}`,
    );
  return rel;
}

/** 项目文件（相对项目目录）→ 画布里的引用路径。 */
function refPath(
  raw: string,
  index: number,
  op: CanvasOp,
): { file: string; rel: string } {
  const file = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    file === "" ||
    file.startsWith("/") ||
    /^[A-Za-z]:/.test(file) ||
    file.split("/").includes("..") ||
    file === ".canvas" ||
    file.startsWith(".canvas/")
  )
    fail(
      index,
      op,
      `"${raw}" must be a file path inside the project, for example docs/design.md.`,
    );
  return { file, rel: `../${file}` };
}

/**
 * 别的主机上的文件写成「主机名:绝对路径」（与 index.md 里印的一样）。
 * 主机名不含斜杠与冒号；路径是 POSIX 绝对路径或 Windows 盘符路径。不是这个形状返回 null。
 */
export function parseHostPath(
  raw: string,
): { host: string; abs: string } | null {
  const m = /^([^/\\:]+):(\/.*|[A-Za-z]:[\\/].*)$/.exec(raw.trim());
  return m ? { host: m[1] as string, abs: m[2] as string } : null;
}

/** 整批试算：后一条能看到前一条的结果；任何一条不合法就整批拒绝。 */
export function planOps(
  world: OpsWorld,
  ops: CanvasOp[],
): { steps: OpsStep[]; summaries: string[] } {
  const steps: OpsStep[] = [];
  const summaries: string[] = [];
  ops.forEach((op, i) => {
    switch (op.op) {
      case "create_canvas": {
        const name = sanitizePath(op.name);
        if (name === "")
          fail(
            i,
            op,
            "name is empty after removing characters not allowed in file names; give a name.",
          );
        if (world.boards.has(name))
          fail(
            i,
            op,
            `a canvas named "${name}" already exists; choose another name.`,
          );
        world.boards.set(name, { nodes: [], edges: [] });
        world.cardNames.set(name, new Set());
        steps.push({ kind: "create_canvas", name });
        summaries.push(`create canvas ${name}`);
        return;
      }
      case "create_card": {
        const canvas = sanitizePath(op.canvas);
        const doc = boardOf(world, canvas, i, op);
        const taken = world.cardNames.get(canvas) ?? new Set<string>();
        const name = uniqueName(
          taken,
          sanitizeName(op.name ?? "") || timeName(new Date()),
        );
        taken.add(name);
        world.cardNames.set(canvas, taken);
        const path = cardFile(canvas, name);
        world.cards.set(path, op.text);
        addFileNode(doc, path);
        steps.push({ kind: "create_card", canvas, name, text: op.text });
        summaries.push(`create card ${path}`);
        return;
      }
      case "update": {
        const { kind } = pathKind(op.path, i, op);
        if (kind === "board")
          fail(
            i,
            op,
            "update works on cards and notes only; the canvas structure (nodes, edges, groups) is changed in the UI.",
          );
        const store = kind === "note" ? world.notes : world.cards;
        const cur = store.get(op.path);
        if (cur === undefined)
          fail(i, op, `${kind} "${op.path}" does not exist. ${HINT}`);
        let next: string;
        if (op.text !== undefined) {
          if (op.old !== undefined || op.new !== undefined)
            fail(i, op, "give either text or old and new, not both.");
          next = op.text;
        } else {
          if (op.old === undefined || op.new === undefined)
            fail(
              i,
              op,
              "give text (whole replacement) or both old and new (exact replacement).",
            );
          const n = countOf(cur, op.old);
          if (n === 0)
            fail(
              i,
              op,
              `old appears 0 times in the ${kind}; nothing to replace.`,
            );
          if (n > 1)
            fail(
              i,
              op,
              `old appears ${n} times in the ${kind}; it must appear exactly once. Include more surrounding text.`,
            );
          next = cur.replace(op.old, op.new);
        }
        store.set(op.path, next);
        steps.push({
          kind: kind === "note" ? "write_note" : "write_card",
          path: op.path,
          text: next,
        });
        summaries.push(`update ${op.path}`);
        return;
      }
      case "rename": {
        const { kind, board } = pathKind(op.path, i, op);
        const name = sanitizeName(op.name);
        if (name === "")
          fail(
            i,
            op,
            "name is empty after removing characters not allowed in file names; give a name.",
          );
        if (kind === "board") {
          const doc = boardOf(world, board, i, op);
          const next = splitLeaf(board).dir + name;
          if (next !== board && world.boards.has(next))
            fail(
              i,
              op,
              `a canvas named "${next}" already exists; choose another name.`,
            );
          rewriteWorldLinks(
            world,
            new Map([[boardFile(board), boardFile(next)]]),
          );
          const from = cardPrefix(board);
          const to = cardPrefix(next);
          for (const node of doc.nodes)
            if (typeof node.file === "string" && node.file.startsWith(from))
              node.file = to + node.file.slice(from.length);
          renameFileRefsUnder(doc, cardsDir(board), cardsDir(next));
          for (const key of [...world.cards.keys()])
            if (key.startsWith(from)) {
              const text = world.cards.get(key) as string;
              world.cards.delete(key);
              world.cards.set(to + key.slice(from.length), text);
            }
          const taken = world.cardNames.get(board) ?? new Set<string>();
          world.cardNames.delete(board);
          world.cardNames.set(next, taken);
          world.boards.delete(board);
          world.boards.set(next, doc);
          steps.push({ kind: "rename_canvas", from: board, name });
          summaries.push(`rename canvas ${board} to ${next}`);
          return;
        }
        if (kind === "note") {
          const to = `${splitLeaf(op.path).dir}${sanitizeName(name.replace(/\.md$/i, ""))}.md`;
          const text = world.notes.get(op.path);
          if (text === undefined)
            fail(i, op, `note "${op.path}" does not exist. ${HINT}`);
          if (to === op.path) {
            summaries.push(`rename note ${op.path} (unchanged)`);
            return;
          }
          if (world.notes.has(to))
            fail(
              i,
              op,
              `a note at "${to}" already exists; choose another name.`,
            );
          rewriteWorldLinks(world, new Map([[op.path, to]]));
          const moved = world.notes.get(op.path) as string;
          world.notes.delete(op.path);
          world.notes.set(to, moved);
          for (const doc of world.boards.values())
            renameFileRefs(doc, op.path, to);
          steps.push({ kind: "rename_note", path: op.path, to });
          summaries.push(`rename note ${op.path} to ${to}`);
          return;
        }
        if (world.cards.get(op.path) === undefined)
          fail(i, op, `card "${op.path}" does not exist. ${HINT}`);
        if (name === cardBase(op.path)) {
          summaries.push(`rename card ${op.path} (unchanged)`);
          return;
        }
        const taken = world.cardNames.get(board) ?? new Set<string>();
        taken.delete(cardBase(op.path));
        const final = uniqueName(taken, name);
        taken.add(final);
        world.cardNames.set(board, taken);
        const next = cardFile(board, final);
        const text = world.cards.get(op.path) as string;
        world.cards.delete(op.path);
        world.cards.set(next, text);
        renameFileRefs(world.boards.get(board) as CanvasDoc, op.path, next);
        steps.push({ kind: "rename_card", path: op.path, name: final });
        summaries.push(`rename card ${op.path} to ${next}`);
        return;
      }
      case "delete": {
        const { kind, board } = pathKind(op.path, i, op);
        if (kind === "board") {
          boardOf(world, board, i, op);
          world.boards.delete(board);
          world.cardNames.delete(board);
          const prefix = cardPrefix(board);
          for (const key of [...world.cards.keys()])
            if (key.startsWith(prefix)) world.cards.delete(key);
          steps.push({ kind: "delete_canvas", name: board });
          summaries.push(`delete canvas ${board}`);
          return;
        }
        if (kind === "note") {
          if (!world.notes.has(op.path))
            fail(i, op, `note "${op.path}" does not exist. ${HINT}`);
          world.notes.delete(op.path);
          for (const doc of world.boards.values())
            removeNodesByFile(doc, op.path);
          steps.push({ kind: "delete_note", path: op.path });
          summaries.push(`delete note ${op.path}`);
          return;
        }
        if (world.cards.get(op.path) === undefined)
          fail(i, op, `card "${op.path}" does not exist. ${HINT}`);
        world.cards.delete(op.path);
        world.cardNames.get(board)?.delete(cardBase(op.path));
        removeNodesByFile(world.boards.get(board) as CanvasDoc, op.path);
        steps.push({ kind: "delete_card", path: op.path });
        summaries.push(`delete card ${op.path}`);
        return;
      }
      case "create_note": {
        const path = notePath(op.path, i, op);
        if (world.notes.has(path))
          fail(
            i,
            op,
            `a note at "${path}" already exists; use update, or choose another path.`,
          );
        world.notes.set(path, op.text);
        steps.push({ kind: "create_note", path, text: op.text });
        summaries.push(`create note ${path}`);
        if (op.canvas !== undefined) {
          const canvas = sanitizePath(op.canvas);
          addFileNode(boardOf(world, canvas, i, op), path);
          steps.push({ kind: "place", canvas, file: path });
          summaries.push(`place ${path} on ${canvas}`);
        }
        return;
      }
      case "promote": {
        const { kind, board } = pathKind(op.path, i, op);
        if (kind !== "card")
          fail(
            i,
            op,
            "promote works on idea cards only (<canvas>.cards/<card>.md).",
          );
        const text = world.cards.get(op.path);
        if (text === undefined)
          fail(i, op, `card "${op.path}" does not exist. ${HINT}`);
        const to = notePath(op.to ?? cardBase(op.path), i, op);
        if (world.notes.has(to))
          fail(i, op, `a note at "${to}" already exists; choose another "to".`);
        world.cards.delete(op.path);
        world.cardNames.get(board)?.delete(cardBase(op.path));
        world.notes.set(to, text);
        for (const doc of world.boards.values())
          renameFileRefs(doc, op.path, to);
        steps.push({ kind: "promote", path: op.path, to });
        summaries.push(`promote ${op.path} to ${to}`);
        return;
      }
      case "place": {
        const canvas = sanitizePath(op.canvas);
        const doc = boardOf(world, canvas, i, op);
        if (op.host) {
          const found = world.remoteFile(op.host, op.file);
          if (found === "unreachable")
            fail(i, op, `host "${op.host}" is not reachable right now.`);
          if (found === "missing")
            fail(i, op, `file not found on host "${op.host}": ${op.file}`);
          if (
            doc.nodes.some((n) => n.file === op.file && hostOf(n) === op.host)
          )
            fail(
              i,
              op,
              `${op.host}:${op.file} is already on canvas "${canvas}".`,
            );
          addFileNode(doc, op.file, undefined, undefined, op.host);
          steps.push({ kind: "place", canvas, file: op.file, host: op.host });
          summaries.push(`place ${op.host}:${op.file} on ${canvas}`);
          return;
        }
        const noteRel = noteRefOf(world, op.file, i, op);
        if (noteRel !== null) {
          if (doc.nodes.some((n) => n.file === noteRel && hostOf(n) === ""))
            fail(i, op, `${noteRel} is already on canvas "${canvas}".`);
          addFileNode(doc, noteRel);
          steps.push({ kind: "place", canvas, file: noteRel });
          summaries.push(`place ${noteRel} on ${canvas}`);
          return;
        }
        const { file, rel } = refPath(op.file, i, op);
        if (!world.projectFile(file))
          fail(i, op, `file not found in the project: ${file}`);
        if (doc.nodes.some((n) => n.file === rel && hostOf(n) === ""))
          fail(i, op, `${file} is already on canvas "${canvas}".`);
        addFileNode(doc, rel);
        steps.push({ kind: "place", canvas, file: rel });
        summaries.push(`place ${file} on ${canvas}`);
        return;
      }
      case "unplace": {
        if (op.host) {
          const canvas = sanitizePath(op.canvas);
          const doc = boardOf(world, canvas, i, op);
          if (
            !doc.nodes.some((n) => n.file === op.file && hostOf(n) === op.host)
          )
            fail(i, op, `${op.host}:${op.file} is not on canvas "${canvas}".`);
          removeNodesByFile(doc, op.file, op.host);
          steps.push({ kind: "unplace", canvas, file: op.file, host: op.host });
          summaries.push(`unplace ${op.host}:${op.file} from ${canvas}`);
          return;
        }
        // 灵感卡不是引用：去掉它的节点等于删卡，让人用 delete
        if (classify(op.file).kind === "card")
          fail(
            i,
            op,
            `"${op.file}" is an idea card, not a project file reference; use delete to remove it (a card is a file of this canvas).`,
          );
        const canvas = sanitizePath(op.canvas);
        const doc = boardOf(world, canvas, i, op);
        const noteRel = noteRefOf(world, op.file, i, op);
        if (noteRel !== null) {
          if (!doc.nodes.some((n) => n.file === noteRel && hostOf(n) === ""))
            fail(i, op, `${noteRel} is not on canvas "${canvas}".`);
          removeNodesByFile(doc, noteRel);
          steps.push({ kind: "unplace", canvas, file: noteRel });
          summaries.push(`unplace ${noteRel} from ${canvas}`);
          return;
        }
        const { file, rel } = refPath(op.file, i, op);
        if (!doc.nodes.some((n) => n.file === rel && hostOf(n) === ""))
          fail(i, op, `${file} is not on canvas "${canvas}".`);
        removeNodesByFile(doc, rel);
        steps.push({ kind: "unplace", canvas, file: rel });
        summaries.push(`unplace ${file} from ${canvas}`);
        return;
      }
    }
  });
  return { steps, summaries };
}

/** 从仓库读一份快照（纯读，不建任何东西）；项目文件的存在性由一个 Set 回答。 */
export async function loadWorld(
  repo: CanvasRepo,
  projectFiles: ReadonlySet<string>,
  remote: ReadonlyMap<string, "file" | "missing" | "unreachable"> = new Map(),
): Promise<OpsWorld> {
  const boards = new Map<string, CanvasDoc>();
  const cards = new Map<string, string>();
  const cardNames = new Map<string, Set<string>>();
  const notes = new Map<string, string>();
  for (const rel of await repo.listNotes())
    notes.set(rel, (await repo.readNote(rel)).text);
  for (const b of await repo.listBoards()) {
    const { doc } = await repo.readBoard(b.name);
    boards.set(b.name, doc);
    const names = new Set<string>();
    for (const rel of await repo.listCardFiles(b.name)) {
      names.add(cardBase(rel));
      const read = await repo.readCard(rel);
      cards.set(rel, read.text);
    }
    cardNames.set(b.name, names);
  }
  return {
    boards,
    cards,
    notes,
    cardNames,
    projectFile: (rel: string) => projectFiles.has(rel),
    remoteFile: (host, abs) => remote.get(`${host}:${abs}`) ?? "missing",
  };
}

/** 落盘：按计划逐步执行；任何一步失败都先回滚再抛错。 */
async function land(repo: CanvasRepo, steps: OpsStep[]): Promise<void> {
  for (const step of steps) {
    switch (step.kind) {
      case "create_canvas":
        await repo.createBoard(step.name);
        break;
      case "create_card":
        await repo.createCard(step.canvas, {
          name: step.name,
          text: step.text,
        });
        break;
      case "write_card":
        await repo.saveCard(step.path, step.text);
        break;
      case "rename_card":
        await repo.renameCard(step.path, step.name);
        break;
      case "rename_canvas":
        await repo.renameBoard(step.from, step.name);
        break;
      case "delete_card":
        await repo.deleteCard(step.path);
        break;
      case "delete_canvas":
        await repo.deleteBoard(step.name);
        break;
      case "create_note":
        await repo.createNote(step.path, step.text);
        break;
      case "write_note":
        await repo.saveNote(step.path, step.text);
        break;
      case "rename_note":
        await repo.moveNote(step.path, step.to);
        break;
      case "delete_note":
        await repo.deleteNote(step.path);
        break;
      case "promote":
        await repo.promoteCard(step.path, step.to);
        break;
      case "place":
      case "unplace": {
        const { doc, baseline } = await repo.readBoard(step.canvas);
        if (step.kind === "place")
          addFileNode(doc, step.file, undefined, undefined, step.host);
        else removeNodesByFile(doc, step.file, step.host);
        await repo.saveBoard(step.canvas, doc, baseline);
        break;
      }
    }
  }
}

/**
 * 一批操作：先 settle 并确认工作区干净，再整批试算（不合法整批拒绝），
 * 通过后落盘并立即提交一次；落盘中途失败则回滚，整批全成或全不成。
 */
export async function applyOps(
  repo: CanvasRepo,
  ops: CanvasOp[],
  source: { kind: "agent"; session: string },
  /** 主机名或 id → 环境 id；place / unplace 里写「主机名:绝对路径」时用 */
  resolveHost: (target: string) => string | null = () => null,
): Promise<string[]> {
  await repo.settle();
  if (!(await repo.isClean()))
    throw new CanvasError(
      "conflict",
      "the canvas folder has uncommitted changes that are not ours; try again",
    );

  // 「主机名:绝对路径」换成「环境 id + 绝对路径」；主机名不认识整批拒绝
  const resolved: CanvasOp[] = [];
  for (const [i, op] of ops.entries()) {
    const hp =
      (op.op === "place" || op.op === "unplace") && parseHostPath(op.file);
    if (!hp) {
      resolved.push(op);
      continue;
    }
    const host = resolveHost(hp.host);
    if (host === null)
      throw new CanvasError(
        "invalid",
        `Operation ${i + 1} (${op.op}): host "${hp.host}" not found; use a host name from list_directories (local is the host of the canvas's own directory) or index.md.`,
      );
    resolved.push({ ...op, file: hp.abs, host } as CanvasOp);
  }

  const files = new Set<string>();
  const remote = new Map<string, "file" | "missing" | "unreachable">();
  for (const op of resolved)
    if (op.op === "place") {
      if (op.host) {
        remote.set(
          `${op.host}:${op.file}`,
          await repo.probeRemote(op.host, op.file),
        );
        continue;
      }
      const file = op.file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      if (await repo.fileExists(`../${file}`)) files.add(file);
    }

  let plan: { steps: OpsStep[]; summaries: string[] };
  try {
    plan = planOps(await loadWorld(repo, files, remote), resolved);
  } catch (err) {
    if (err instanceof CanvasOpError)
      throw new CanvasError(
        "invalid",
        `Operation ${err.index + 1} (${err.op}): ${err.message}`,
      );
    throw err;
  }

  repo.beginBatch();
  try {
    await land(repo, plan.steps);
  } catch (err) {
    repo.endBatch();
    await repo.rollback().catch(() => {});
    throw err;
  }
  repo.endBatch();

  await repo.commitAs(
    { kind: "agent", session: source.session },
    summarize(plan.summaries),
  );
  return plan.summaries;
}

/** 一批操作的提交标题：一句话，≤72 字符。 */
function summarize(lines: string[]): string {
  const first = lines[0] ?? "canvas_edit";
  const all = lines.length <= 1 ? first : `${first} (+${lines.length - 1})`;
  return all.length > 72 ? `${all.slice(0, 69)}...` : all;
}
