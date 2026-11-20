// index.md 的渲染（canvas.md §5、§10）：全部从文件内容推导，纯函数，同输入同输出。
// 两层拓扑：`## tree`（目录树）→ `## boards`（每块画布的节点与连线）→ `## notes`（每篇笔记在哪些画布上、链到谁）。
// 骨架一律 ASCII（`->` 表示指向、整数 B / kB、节点 id 取原 id 的前 8 位），文件名与标题照原样写。
import { type CanvasDoc, type CanvasNode, hostOf } from "./format.js";
import { boardFile, classify, splitLeaf } from "./layout.js";
import { resolveLink, scanWikilinks } from "./wikilink.js";

/** 标题（引号里那段）最多取的字符数。 */
const TITLE_CHARS = 40;
const ID_CHARS = 8;

export interface IndexFile {
  exists: boolean;
  /** 只有灵感卡要正文（取标题）；别的文件不读 */
  text: string | null;
  size?: number;
}

/** 笔记：路径相对 `.canvas/`；text 为 null 表示二进制或过大，不扫链接。 */
export interface IndexNote {
  path: string;
  size: number | null;
  text: string | null;
}

export interface IndexInput {
  boards: { name: string; doc: CanvasDoc; files: Map<string, IndexFile> }[];
  notes: IndexNote[];
  /** 环境 id → 主机名：别的主机上的引用写成「主机名:绝对路径」；缺省原样写 id */
  hostLabel?: (id: string) => string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 开头 frontmatter 的结尾（字符偏移）；没有就返回 0。 */
const frontmatterEnd = (text: string): number => {
  if (!text.startsWith("---")) return 0;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return 0;
  const after = text.indexOf("\n", end + 4);
  return after < 0 ? text.length : after + 1;
};

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const sizeLabel = (n: number): string =>
  n < 1000 ? `${n} B` : `${Math.round(n / 1000)} kB`;

const clip = (s: string): string => {
  const chars = [...s];
  return chars.length > TITLE_CHARS
    ? `${chars.slice(0, TITLE_CHARS).join("")}...`
    : s;
};

/** 标题放进双引号：折成一行、截短，里面的双引号换成单引号。 */
const quoted = (s: string): string =>
  `"${clip(oneLine(s)).replace(/"/g, "'")}"`;

const stem = (path: string): string => {
  const leaf = splitLeaf(path).leaf;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
};

/** 正文第一个非空行（去掉 `#` 标题记号）当标题；没有正文用文件名。 */
function titleOf(text: string | null, path: string): string {
  const first = text
    ?.slice(frontmatterEnd(text))
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  const t = (first ?? "").replace(/^#{1,6}[ \t]+/, "").replace(/[ \t]+#+$/, "");
  return quoted(t === "" ? stem(path) : t);
}

/** 目录树：同一层先文件、后子目录，各自按名字排；文件夹名带结尾 `/`。 */
function renderTree(paths: string[]): string[] {
  interface Dir {
    files: string[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const p of paths) {
    const segs = p.split("/");
    let dir = root;
    for (const seg of segs.slice(0, -1)) {
      let next = dir.dirs.get(seg);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(seg, next);
      }
      dir = next;
    }
    dir.files.push(segs[segs.length - 1] as string);
  }
  const out: string[] = [];
  const walk = (dir: Dir, depth: number): void => {
    const pad = "  ".repeat(depth);
    for (const f of dir.files.sort(cmp)) out.push(`${pad}${f}`);
    for (const name of [...dir.dirs.keys()].sort(cmp)) {
      out.push(`${pad}${name}/`);
      walk(dir.dirs.get(name) as Dir, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

const firstLine = (s: string): string =>
  s.split("\n").find((l) => l.trim() !== "") ?? "";

/** 一块画布里的一个节点：`<id> <kind> <path|url> "<title>" [<size>] [missing]`。 */
function renderNode(
  n: CanvasNode,
  files: Map<string, IndexFile>,
  noteByPath: Map<string, IndexNote>,
  hostLabel: (id: string) => string,
): string {
  const id = n.id.slice(0, ID_CHARS);
  if (n.type === "link")
    return `${id}  link  ${typeof n.url === "string" ? n.url : ""}`;
  if (n.type === "text")
    return `${id}  text  ${quoted(typeof n.text === "string" ? firstLine(n.text) : "")}`;
  if (n.type === "group")
    return `${id}  group  ${quoted(typeof n.label === "string" ? n.label : "")}`;
  if (n.type !== "file" || typeof n.file !== "string")
    return `${id}  ${n.type}`;

  const file = n.file;
  // 别的主机（或目录之外）的文件：只写主机与路径，不查存在（生成索引时不为它们多跑网络往返）
  if (hostOf(n) !== "")
    return `${id}  ref  ${hostLabel(hostOf(n))}:${file}  ${titleOf(null, file)}`;

  const kind = classify(file).kind;
  const label =
    kind === "card" || kind === "asset" || kind === "note" ? kind : "ref";
  const head = `${id}  ${label}  ${file}`;
  const note = kind === "note" ? noteByPath.get(file) : undefined;
  const info: IndexFile | undefined =
    kind === "note"
      ? note && { exists: true, text: note.text, ...sized(note.size) }
      : files.get(file);
  if (info === undefined || !info.exists) return `${head}  missing`;
  // 灵感卡与笔记取正文里的标题；项目文件与资源只写文件名
  const title = titleOf(
    label === "card" || label === "note" ? info.text : null,
    file,
  );
  const size =
    info.size ?? (info.text === null ? null : Buffer.byteLength(info.text));
  return `${head}  ${title}${size === null ? "" : `  ${sizeLabel(size)}`}`;
}

const sized = (size: number | null): { size?: number } =>
  size === null ? {} : { size };

export function renderIndex(input: IndexInput): string {
  const hostLabel = input.hostLabel ?? ((id: string) => id);
  const boards = [...input.boards].sort((a, b) => cmp(a.name, b.name));
  const notes = [...input.notes].sort((a, b) => cmp(a.path, b.path));
  const boardId = new Map(boards.map((b, i) => [b.name, `b${i + 1}`]));
  const noteId = new Map(notes.map((n, i) => [n.path, `no${i + 1}`]));
  const noteByPath = new Map(notes.map((n) => [n.path, n]));

  // 链接：笔记正文里的 [[…]] 解析到画布或笔记；反过来得到「谁链到我」
  const known = new Set([
    ...boards.map((b) => boardFile(b.name)),
    ...notes.map((n) => n.path),
  ]);
  const linksOf = new Map<string, { target: string; found: boolean }[]>();
  const linkedFrom = new Map<string, string[]>();
  for (const n of notes) {
    const out: { target: string; found: boolean }[] = [];
    for (const raw of n.text === null ? [] : scanWikilinks(n.text)) {
      const hit = resolveLink(raw, known);
      out.push({ target: hit ?? raw, found: hit !== null });
      if (hit !== null && hit !== n.path)
        linkedFrom.set(hit, [
          ...(linkedFrom.get(hit) ?? []),
          noteId.get(n.path) as string,
        ]);
    }
    linksOf.set(n.path, out);
  }
  const list = (items: string[]): string =>
    items.length === 0 ? "(none)" : items.join(" ");

  // 笔记摆在哪些画布上
  const appearsIn = new Map<string, string[]>();
  for (const b of boards)
    for (const n of b.doc.nodes)
      if (
        n.type === "file" &&
        typeof n.file === "string" &&
        hostOf(n) === "" &&
        noteByPath.has(n.file)
      ) {
        const ids = appearsIn.get(n.file) ?? [];
        if (!ids.includes(boardId.get(b.name) as string))
          ids.push(boardId.get(b.name) as string);
        appearsIn.set(n.file, ids);
      }

  const out = ["# index", "", "generated - do not edit", "", "## tree", ""];
  const tree = renderTree([
    ...boards.map((b) => boardFile(b.name)),
    ...notes.map((n) => n.path),
  ]);
  out.push(...(tree.length === 0 ? ["(none)"] : tree), "", "## boards", "");
  if (boards.length === 0) out.push("(none)", "");
  for (const b of boards) {
    out.push(
      `${boardId.get(b.name)}  ${boardFile(b.name)}  ${quoted(stem(b.name))}`,
      `  linked-from: ${list(linkedFrom.get(boardFile(b.name)) ?? [])}`,
      "  nodes",
    );
    const nodes = b.doc.nodes.map(
      (n) => `    ${renderNode(n, b.files, noteByPath, hostLabel)}`,
    );
    out.push(...(nodes.length === 0 ? ["    (none)"] : nodes), "  edges");
    const edges = b.doc.edges.map((e) => {
      const label =
        typeof e.label === "string" && e.label.trim() !== ""
          ? `  ${quoted(e.label)}`
          : "";
      return `    ${e.fromNode.slice(0, ID_CHARS)} -> ${e.toNode.slice(0, ID_CHARS)}${label}`;
    });
    out.push(...(edges.length === 0 ? ["    (none)"] : edges), "");
  }
  out.push("## notes", "");
  if (notes.length === 0) out.push("(none)");
  for (const n of notes) {
    const links = (linksOf.get(n.path) ?? []).map(
      (l) => `[[${l.target}]]${l.found ? "" : "(missing)"}`,
    );
    out.push(
      `${noteId.get(n.path)}  ${n.path}  ${titleOf(n.text, n.path)}${n.size === null ? "" : `  ${sizeLabel(n.size)}`}`,
      `  appears-in: ${list(appearsIn.get(n.path) ?? [])}`,
      `  links-to: ${list(links)}`,
      `  linked-from: ${list(linkedFrom.get(n.path) ?? [])}`,
      "",
    );
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
