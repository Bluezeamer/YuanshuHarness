// JSON Canvas 1.0 的读写与摆放计算（canvas.md §1 CV1）：纯函数，不碰 IO。
// 只认自己关心的字段，其余原样保留，Obsidian 或扩展写进去的 color / label / subpath / group 不会被吃掉。
import { randomBytes } from "node:crypto";

export interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  file?: string;
  [k: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  [k: string]: unknown;
}

export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [k: string]: unknown;
}

export class CanvasFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasFormatError";
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const validNode = (v: unknown): v is CanvasNode =>
  isObj(v) &&
  isStr(v.id) &&
  isStr(v.type) &&
  isNum(v.x) &&
  isNum(v.y) &&
  isNum(v.width) &&
  isNum(v.height);

const validEdge = (v: unknown): v is CanvasEdge =>
  isObj(v) && isStr(v.id) && isStr(v.fromNode) && isStr(v.toNode);

/** 容错解析：空的当没有内容，坏节点丢掉，整体不是 JSON 才报错。 */
export function parseCanvas(text: string): CanvasDoc {
  const trimmed = text.trim();
  if (trimmed === "") return { nodes: [], edges: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new CanvasFormatError("画布文件不是合法的 JSON");
  }
  if (!isObj(raw)) throw new CanvasFormatError("画布文件的根必须是一个对象");
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter(validNode) : [];
  const edges = Array.isArray(raw.edges) ? raw.edges.filter(validEdge) : [];
  return { ...raw, nodes, edges };
}

/** 与 Obsidian 一致：制表符缩进 + 末尾换行。 */
export function serializeCanvas(doc: CanvasDoc): string {
  return `${JSON.stringify(doc, null, "\t")}\n`;
}

const GRID_COLUMNS = 5;
const GAP = 40;
const DEFAULT_SIZE = { w: 260, h: 160 };

/** 确定性网格摆放：取第一个与现有节点包围盒都不相交的格。 */
export function placeNew(
  doc: CanvasDoc,
  size: { w: number; h: number } = DEFAULT_SIZE,
): { x: number; y: number } {
  const cw = size.w + GAP;
  const ch = size.h + GAP;
  const boxes = doc.nodes.map((n) => ({
    x: n.x,
    y: n.y,
    w: n.width,
    h: n.height,
  }));
  for (let i = 0; ; i++) {
    const x = (i % GRID_COLUMNS) * cw;
    const y = Math.floor(i / GRID_COLUMNS) * ch;
    const hit = boxes.some(
      (b) =>
        x < b.x + b.w && b.x < x + size.w && y < b.y + b.h && b.y < y + size.h,
    );
    if (!hit) return { x, y };
  }
}

/** 生成 16 位十六进制 id。 */
const newId = (): string => randomBytes(8).toString("hex");

/**
 * 别的主机（或目录之外）的文件引用：`file` 是那台主机上的绝对路径，`host` 是环境 id。
 * 目录之内的文件仍用 `../相对路径`、没有 host。
 */
export const hostOf = (n: Record<string, unknown>): string =>
  isStr(n.host) ? n.host : "";

/** 一个文件节点在「文件信息」表里的键：远端引用带上主机，免得不同主机上同一路径的文件互相覆盖 */
export const refKey = (n: Record<string, unknown>): string =>
  hostOf(n) === "" ? String(n.file) : `${hostOf(n)}:${String(n.file)}`;

export function addFileNode(
  doc: CanvasDoc,
  file: string,
  pos?: { x: number; y: number },
  size: { w: number; h: number } = DEFAULT_SIZE,
  host?: string,
): CanvasNode {
  const at = pos ?? placeNew(doc, size);
  const node: CanvasNode = {
    id: newId(),
    type: "file",
    file,
    ...(host ? { host } : {}),
    x: at.x,
    y: at.y,
    width: size.w,
    height: size.h,
  };
  doc.nodes.push(node);
  return node;
}

/** 删掉引用这些路径的节点（连同连到它们的边），返回删掉的节点数。 */
export function removeNodesByFile(
  doc: CanvasDoc,
  file: string,
  host = "",
): number {
  const gone = new Set(
    doc.nodes
      .filter((n) => n.type === "file" && n.file === file && hostOf(n) === host)
      .map((n) => n.id),
  );
  if (gone.size === 0) return 0;
  doc.nodes = doc.nodes.filter((n) => !gone.has(n.id));
  doc.edges = doc.edges.filter(
    (e) => !gone.has(e.fromNode) && !gone.has(e.toNode),
  );
  return gone.size;
}

export function renameFileRefs(
  doc: CanvasDoc,
  from: string,
  to: string,
): number {
  let n = 0;
  for (const node of doc.nodes)
    if (node.type === "file" && node.file === from) {
      node.file = to;
      n++;
    }
  return n;
}

/** 前缀替换：画布改名时连带改它资源文件夹里的卡片路径。 */
export function renameFileRefsUnder(
  doc: CanvasDoc,
  fromDir: string,
  toDir: string,
): number {
  const prefix = `${fromDir}/`;
  let n = 0;
  for (const node of doc.nodes)
    if (
      node.type === "file" &&
      isStr(node.file) &&
      node.file.startsWith(prefix)
    ) {
      node.file = toDir + node.file.slice(fromDir.length);
      n++;
    }
  return n;
}

export function fileNodes(doc: CanvasDoc): CanvasNode[] {
  return doc.nodes.filter((n) => n.type === "file" && isStr(n.file));
}
