// 画布标签的纯逻辑：文档（JSON Canvas）⇄ 画布组件的节点与连线、三方合并、拖入文件的路径换算。
// 文档里界面不认识的字段与节点类型都要原样往返：Obsidian 或 agent 存过的内容不能被吃掉。
import type { Edge, Node } from "@xyflow/react";
import type {
  CanvasDocJson,
  CanvasEdgeJson,
  CanvasNodeJson,
  FileInfo,
} from "../../../../api/canvas";
import { isUnder } from "../files/paths";

// ── 节点种类 ──

/** 画布上节点的呈现种类：灵感卡 / 笔记 / 项目文件引用 / 网页链接 / 分组 / 其余（别处建的文字节点等，只读展示） */
export type NodeKind = "card" | "note" | "ref" | "link" | "group" | "other";

/** 文件节点的路径落在 `../` 之外就是这块画布自己的灵感卡，否则是项目文件引用 */
export const isRefPath = (file: string): boolean => file.startsWith("../");

/** 粘贴 / 拖进画布的资源：放在这块画布自己的资源文件夹里（`<画布>.assets/…`），当引用那样显示 */
export const isAssetPath = (file: string): boolean =>
  /^(?!\.\.\/).+\.assets\/./.test(file);

/**
 * 笔记：`.canvas/` 树里不在卡片文件夹与资源文件夹里的 .md，路径相对 `.canvas/`（不以 `../` 开头）。
 * 笔记不属于任何一块画布，画布上的节点只是引用，可以原地编辑。
 */
export const isNotePath = (file: string): boolean =>
  /\.md$/i.test(file) &&
  !isRefPath(file) &&
  !isAssetPath(file) &&
  !/\.cards\//.test(file);

/** 笔记节点标注用的名字：相对 `.canvas/` 的路径，去掉 `.md` */
export const noteTitle = (file: string): string => file.replace(/\.md$/i, "");

/** 资源放在 `_large/` 里的没进画布的 git 历史（太大），删了找不回 */
export const isLargeAsset = (file: string): boolean =>
  isAssetPath(file) && file.includes("/_large/");

/**
 * 别的主机（或画布所在目录之外）的文件引用：`file` 是那台主机上的绝对路径，`host` 是它的环境 id；
 * 画布目录之内的引用没有 host，`file` 是 `../相对路径`。
 */
export const hostOfNode = (n: Record<string, unknown>): string =>
  typeof n.host === "string" ? n.host : "";

/** 一个文件节点在「文件信息」表里的键（与服务端 canvas/format.ts 的 refKey 一致） */
export const refKeyOf = (n: Record<string, unknown>): string =>
  hostOfNode(n) === "" ? String(n.file) : `${hostOfNode(n)}:${String(n.file)}`;

export function kindOfNode(n: CanvasNodeJson): NodeKind {
  if (n.type === "group") return "group";
  if (n.type === "link" && typeof n.url === "string") return "link";
  if (n.type === "file" && typeof n.file === "string")
    return hostOfNode(n) !== "" || isRefPath(n.file) || isAssetPath(n.file)
      ? "ref"
      : isNotePath(n.file)
        ? "note"
        : "card";
  return "other";
}

const stem = (name: string) => name.replace(/\.[^./]+$/, "");
// 别的主机可能是 Windows：路径分隔符两种都认
const last = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** 灵感卡的显示名 = 文件名（去扩展名）；引用显示带扩展名的文件名 */
export const cardTitle = (file: string): string => stem(last(file));
export const refTitle = (file: string): string => last(file);

/** 引用节点显示的路径：去掉开头的 `../`，就是相对目录的路径 */
export const refPath = (file: string): string => file.replace(/^(\.\.\/)+/, "");

/** 自动生成的时间名（`YYYYMMDD-HHmmss`，重名带 ` (2)`）：随手记的默认名，界面不显示，用户改过名才显示 */
export const isAutoTitle = (title: string): boolean =>
  /^\d{8}-\d{6}( \(\d+\))?$/.test(title);

/** 项目文件引用的呈现：图片 / 视频 / 音频 / markdown / 其余（只显示图标与文件名） */
export type RefKind = "image" | "video" | "audio" | "markdown" | "file";

// 与服务端 api/canvas.ts 的 MEDIA_TYPES、canvas/thumb.ts 的图片类型对应
export function refKindOf(file: string): RefKind {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file)) return "image";
  if (/\.(mp4|m4v|webm|ogv|mov|mkv)$/i.test(file)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i.test(file)) return "audio";
  if (/\.(md|markdown)$/i.test(file)) return "markdown";
  return "file";
}

/**
 * 引用卡上方的标注 `主机:绝对路径`，拆成「目录部分」与「文件名」两段：
 * 放不下时目录部分在末尾省略，文件名始终完整。
 */
export function refLabel(
  hostLabel: string,
  dir: string,
  file: string,
  /** 别的主机上的引用：file 本身就是绝对路径，hostLabel 是那台主机的名字 */
  remote = false,
): { head: string; name: string } {
  // 画布自己的资源不是「别处的文件」：只标文件名，不标主机与路径
  if (isAssetPath(file)) return { head: "", name: last(file) };
  const abs = remote ? file : `${dir.replace(/\/+$/, "")}/${refPath(file)}`;
  const name = last(abs);
  return {
    head: `${hostLabel}:${abs.slice(0, abs.length - name.length)}`,
    name,
  };
}

/** 目录里的一个绝对路径 → 画布文档里的引用路径（项目文件 `../相对路径`，画布文件夹里的笔记 `相对 .canvas/ 的路径`）；不在目录之内（或就是目录本身）返回 null */
export function refFileOf(dir: string, abs: string): string | null {
  if (abs === dir || !isUnder(abs, dir)) return null;
  const rel = abs.slice(dir.length).replace(/^\/+/, "");
  if (rel === "") return null;
  // 画布文件夹里的笔记：存成相对 `.canvas/` 的笔记路径（不是 ../ 开头的项目文件引用）
  const note = /^\.canvas\/(.+)$/.exec(rel)?.[1];
  if (
    note !== undefined &&
    note !== "index.md" &&
    isNotePath(note) &&
    !note.split("/").some((seg) => seg.startsWith("."))
  )
    return note;
  return `../${rel}`;
}

/** 目录里的项目文件：`../docs/a.md` → 目录内的绝对路径（点开引用时用）；资源与笔记在 `.canvas/` 里。画布自己的灵感卡返回 null */
export function absOfRef(dir: string, file: string): string | null {
  const root = dir.replace(/\/+$/, "");
  if (isAssetPath(file) || isNotePath(file)) return `${root}/.canvas/${file}`;
  if (!isRefPath(file)) return null;
  return `${root}/${refPath(file)}`;
}

/** 节点的最小高度（与缩放控件的下限一致） */
export const MIN_NODE_H = 72;

/**
 * 按内容的宽高比定节点大小：宽度不变、高度跟着变；比最小高度更扁的，高度取最小、宽度跟着放大（比例不变）。
 * 图片载入后的校正与上传前预先定尺寸都用它。
 */
export function sizeForRatio(
  w: number,
  ratio: number,
): { w: number; h: number } {
  const h = Math.round(w / ratio);
  return h < MIN_NODE_H
    ? { w: Math.round(MIN_NODE_H * ratio), h: MIN_NODE_H }
    : { w, h };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 粘贴进来的文件起名：浏览器给剪贴板图片的名字都是 `image.png`（或没有名字），
 * 换成 `粘贴-年月日-时分秒.扩展名`，免得堆一串「image (2).png」；有自己名字的（拖进来的文件）保持原样。
 */
export function pastedName(
  file: { name: string; type: string },
  now: Date,
): string {
  if (file.name !== "" && !/^image\.[a-z0-9]+$/i.test(file.name))
    return file.name;
  const ext =
    /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ??
    /^[a-z]+\/([a-z0-9]+)/i.exec(file.type)?.[1] ??
    "bin";
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `粘贴-${stamp}.${ext.toLowerCase()}`;
}

// ── 文档 ⇄ 画布组件 ──

/**
 * 还没存成文件的新卡片：它在画布文档里已经是一个普通节点（有 id、位置、连线），
 * 只是 file 是个占位名 `::new:<节点 id>`；第一次保存时服务端建出文件，把 file 换成真路径。
 */
export const NEW_PREFIX = "::new:";
export const isNewFile = (file: string): boolean => file.startsWith(NEW_PREFIX);
export const newFile = (id: string): string => `${NEW_PREFIX}${id}`;
export const DRAFT_SIZE = { w: 260, h: 160 };
export const LINK_SIZE = { w: 320, h: 220 };

/** 粘贴的文字若每一行都是 http(s) 地址（至多 20 行），返回这些地址；否则 null（不是链接，照旧处理） */
export function urlsIn(text: string): string[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > 20) return null;
  return lines.every((l) => {
    if (/\s/.test(l)) return false;
    try {
      const u = new URL(l);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  })
    ? lines
    : null;
}

export const isHttpUrl = (u: string): boolean => /^https?:\/\//i.test(u);

/** 链接的主机名（标注用）；解析不了就原样 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 网页链接节点（JSON Canvas 标准的 link 节点，Obsidian 也认得）；at 是左上角 */
export const linkNode = (
  url: string,
  at: { x: number; y: number },
): CanvasNodeJson => ({
  id: newId(),
  type: "link",
  url,
  x: Math.round(at.x),
  y: Math.round(at.y),
  width: LINK_SIZE.w,
  height: LINK_SIZE.h,
});

/** 在 at 附近找一个不压着现有节点的位置：先试 at，被占就往右挪一格，一行三格，再换下一行（连着新建几张时排开） */
export function freeSpot(
  at: { x: number; y: number },
  nodes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  size: { w: number; h: number } = DRAFT_SIZE,
): { x: number; y: number } {
  const GAP = 40;
  const COLS = 3;
  for (let i = 0; ; i++) {
    const x = at.x + (i % COLS) * (size.w + GAP);
    const y = at.y + Math.floor(i / COLS) * (size.h + GAP);
    const hit = nodes.some(
      (n) =>
        x < n.x + n.width &&
        n.x < x + size.w &&
        y < n.y + n.height &&
        n.y < y + size.h,
    );
    if (!hit) return { x, y };
  }
}

export interface FlowNodeData extends Record<string, unknown> {
  kind: NodeKind;
  /** 引用卡的呈现种类；灵感卡与其余节点为 null */
  refKind: RefKind | null;
  /** 别的主机上的引用：那台主机的环境 id；没有就是画布所在目录之内的 */
  host?: string;
  /** 文件信息表里的键：远端引用带主机（refKeyOf） */
  key: string;
  /** 还没建出文件的新卡片 */
  draft?: boolean;
  /** 文件节点的路径（灵感卡与笔记相对 `.canvas/`，项目文件引用以 `../` 开头） */
  file: string;
  title: string;
  info: FileInfo | null;
  /** 这张卡片没保存：新卡片，或正文改过 */
  dirty?: boolean;
  /** 网页链接节点的地址 */
  url?: string;
  /** 分组 / 其余节点的显示文字 */
  label: string;
}

export type FlowNode = Node<FlowNodeData>;

/** 只能等比例缩放的节点（图片、视频：否则会出现空白） */
export const keepsAspect = (data: FlowNodeData): boolean =>
  data.refKind === "image" || data.refKind === "video";

export const newId = (): string => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

const SIDES = new Set(["top", "right", "bottom", "left"]);
const side = (v: unknown): string | undefined =>
  typeof v === "string" && SIDES.has(v) ? v : undefined;

/** 服务端给卡片的预览取开头多少字：界面里攒着的正文按同样的长度截，才能和存完之后的显示一致 */
export const PREVIEW_CHARS = 4000;

export const previewInfo = (text: string, base?: FileInfo): FileInfo => ({
  ...(base ?? { kind: "card" }),
  exists: true,
  kind: base?.kind ?? "card",
  preview: text.slice(0, PREVIEW_CHARS),
  truncated: text.length > PREVIEW_CHARS,
});

/** 节点上显示的文件信息：改过还没保存的正文盖在服务端给的信息上；新卡片没有服务端信息，只有攒着的正文（可以是空） */
export function infoOf(
  file: string,
  files: Record<string, FileInfo>,
  edits: Readonly<Record<string, string>>,
): FileInfo | null {
  const text = edits[file];
  if (isNewFile(file)) return previewInfo(text ?? "");
  return text === undefined
    ? (files[file] ?? null)
    : previewInfo(text, files[file]);
}

/** 这张卡片有没有没保存的东西：新卡片本身就没存过，已有的卡片看正文有没有改 */
export const isUnsaved = (
  file: string,
  edits: Readonly<Record<string, string>>,
): boolean => isNewFile(file) || file in edits;

/** 文件信息有没有实质变化：没变就别换节点上的 data（换了会让节点白白重渲染） */
export const sameInfo = (
  a: FileInfo | null | undefined,
  b: FileInfo | null | undefined,
): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.exists === b.exists &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.preview === b.preview &&
    a.truncated === b.truncated);

/** 文档 → 节点与连线；分组排在最前（画在最底下） */
export function toFlow(
  doc: CanvasDocJson,
  files: Record<string, FileInfo>,
  edits: Readonly<Record<string, string>> = {},
): { nodes: FlowNode[]; edges: Edge[] } {
  const nodes: FlowNode[] = doc.nodes.map((n) => {
    const kind = kindOfNode(n);
    const file = typeof n.file === "string" ? n.file : "";
    const fresh = kind === "card" && isNewFile(file);
    return {
      id: n.id,
      type: kind,
      position: { x: n.x, y: n.y },
      width: n.width,
      height: n.height,
      ...(kind === "group" ? { zIndex: -1 } : {}),
      data: {
        kind,
        refKind: kind === "ref" ? refKindOf(file) : null,
        ...(hostOfNode(n) !== "" ? { host: hostOfNode(n) } : {}),
        key: refKeyOf(n),
        file,
        title:
          kind === "ref"
            ? refTitle(file)
            : kind === "note"
              ? noteTitle(file)
              : cardTitle(file),
        info:
          kind === "card" || kind === "note"
            ? infoOf(file, files, edits)
            : (files[refKeyOf(n)] ?? null),
        ...(kind === "link" ? { url: n.url as string } : {}),
        ...(fresh ? { draft: true } : {}),
        ...((kind === "card" || kind === "note") && isUnsaved(file, edits)
          ? { dirty: true }
          : {}),
        label:
          typeof n.label === "string"
            ? n.label
            : typeof n.text === "string"
              ? n.text
              : typeof n.url === "string"
                ? n.url
                : "",
      },
    };
  });
  nodes.sort(
    (a, b) => (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1),
  );
  const edges: Edge[] = doc.edges.map((e) => {
    const sh = side(e.fromSide);
    const th = side(e.toSide);
    return {
      id: e.id,
      source: e.fromNode,
      target: e.toNode,
      ...(sh ? { sourceHandle: sh } : {}),
      ...(th ? { targetHandle: th } : {}),
      ...(typeof e.label === "string" ? { label: e.label } : {}),
    };
  });
  return { nodes, edges };
}

const int = (v: number | undefined, fallback: number) =>
  Math.round(Number.isFinite(v) ? (v as number) : fallback);

/**
 * 节点与连线 → 文档：只覆盖界面会改的字段（位置、大小、连线的端点与方向），
 * 其余字段与界面没见过的节点 / 连线一律沿用 prev 里的。
 */
export function fromFlow(
  prev: CanvasDocJson,
  nodes: readonly FlowNode[],
  edges: readonly Edge[],
): CanvasDocJson {
  const origN = new Map(prev.nodes.map((n) => [n.id, n]));
  const outNodes: CanvasNodeJson[] = [];
  for (const f of nodes) {
    const o = origN.get(f.id);
    if (!o) continue;
    outNodes.push({
      ...o,
      x: int(f.position.x, o.x),
      y: int(f.position.y, o.y),
      width: int(f.width ?? f.measured?.width, o.width),
      height: int(f.height ?? f.measured?.height, o.height),
    });
  }
  const origE = new Map(prev.edges.map((e) => [e.id, e]));
  const outEdges: CanvasEdgeJson[] = edges.map((f) => {
    const o = origE.get(f.id);
    const next: CanvasEdgeJson = {
      ...(o ?? {}),
      id: f.id,
      fromNode: f.source,
      toNode: f.target,
    };
    if (f.sourceHandle) next.fromSide = f.sourceHandle;
    else delete next.fromSide;
    if (f.targetHandle) next.toSide = f.targetHandle;
    else delete next.toSide;
    return next;
  });
  return { ...prev, nodes: outNodes, edges: outEdges };
}

// ── 落点换算 ──

export type Side = "top" | "right" | "bottom" | "left";

/** 落点（节点内的相对坐标）离哪条边最近；平局按 上、右、下、左 取先 */
export function nearestSide(
  at: { x: number; y: number },
  size: { width: number; height: number },
): Side {
  const d: [Side, number][] = [
    ["top", at.y],
    ["right", size.width - at.x],
    ["bottom", size.height - at.y],
    ["left", at.x],
  ];
  let best = d[0] as [Side, number];
  for (const c of d) if (c[1] < best[1]) best = c;
  return best[0];
}

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  group?: boolean;
}

/**
 * 画布坐标里的点落在哪个节点上（连线松手时用）：排除连线的起点节点；重叠时取画在最上面的（靠后的），
 * 分组只在点下没有别的节点时才算。
 */
export function nodeAt(
  p: { x: number; y: number },
  boxes: readonly Box[],
  exclude: string,
): string | null {
  let group: string | null = null;
  let hit: string | null = null;
  for (const b of boxes) {
    if (b.id === exclude) continue;
    if (p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height)
      continue;
    if (b.group) group = b.id;
    else hit = b.id;
  }
  return hit ?? group;
}

// ── 复制粘贴 ──

/** 复制下来的一个节点：灵感卡带着完整正文（粘贴时变成带正文的新卡片） */
export interface ClipNode {
  node: CanvasNodeJson;
  text?: string;
}

export interface Clip {
  env: string;
  dir: string;
  board: string;
  nodes: ClipNode[];
  /** 两端都在被复制的节点里的连线 */
  edges: CanvasEdgeJson[];
}

/** 选中的节点（与它们之间的连线）→ 剪贴内容；texts 是灵感卡的节点 id → 正文 */
export function buildClip(
  from: { env: string; dir: string; board: string },
  doc: CanvasDocJson,
  ids: ReadonlySet<string>,
  texts: Readonly<Record<string, string>>,
): Clip {
  const nodes = doc.nodes
    .filter((n) => ids.has(n.id))
    .map((n) => ({
      node: { ...n },
      ...(kindOfNode(n) === "card" ? { text: texts[n.id] ?? "" } : {}),
    }));
  return {
    ...from,
    nodes,
    edges: doc.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode)),
  };
}

export interface Pasted {
  nodes: CanvasNodeJson[];
  edges: CanvasEdgeJson[];
  /** 新卡片的占位名 → 正文（空的不记） */
  edits: Record<string, string>;
  /** 放不过来的节点数（目录之内的项目文件引用只能回到同一个目录，画布自己的资源只能回到同一块画布） */
  skipped: number;
}

const snap8 = (v: number) => Math.round(v / 8) * 8;

/**
 * 剪贴内容 → 要加进 to 这块画布的新节点：整体的中心落在 center；灵感卡变成带正文的新卡片，引用、笔记与资源指向同一个文件，
 * 其余节点（链接、文字、分组）照搬；全部换新 id，两端都在的连线跟着换。
 */
export function pasteInto(
  clip: Clip,
  to: { env: string; dir: string; board: string },
  center: { x: number; y: number },
  mk: () => string = newId,
): Pasted {
  const sameDir = clip.env === to.env && clip.dir === to.dir;
  const kept = clip.nodes.filter(({ node }) => {
    const kind = kindOfNode(node);
    if (kind !== "ref" && kind !== "note") return true;
    const file = node.file as string;
    // 笔记在目录的 .canvas/ 里，只能回到同一个目录（哪块画布都行）
    if (kind === "note") return sameDir;
    // 别的主机上的引用不依赖当前目录，哪里都能放
    if (hostOfNode(node) !== "") return true;
    return isAssetPath(file) ? sameDir && clip.board === to.board : sameDir;
  });
  const out: Pasted = {
    nodes: [],
    edges: [],
    edits: {},
    skipped: clip.nodes.length - kept.length,
  };
  if (kept.length === 0) return out;
  const x0 = Math.min(...kept.map((k) => k.node.x));
  const y0 = Math.min(...kept.map((k) => k.node.y));
  const x1 = Math.max(...kept.map((k) => k.node.x + k.node.width));
  const y1 = Math.max(...kept.map((k) => k.node.y + k.node.height));
  const dx = snap8(center.x - (x0 + x1) / 2);
  const dy = snap8(center.y - (y0 + y1) / 2);
  const ids = new Map<string, string>();
  for (const { node, text } of kept) {
    const id = mk();
    ids.set(node.id, id);
    const next: CanvasNodeJson = {
      ...node,
      id,
      x: node.x + dx,
      y: node.y + dy,
    };
    if (kindOfNode(node) === "card") {
      next.file = newFile(id);
      if (text) out.edits[next.file] = text;
    }
    out.nodes.push(next);
  }
  for (const e of clip.edges) {
    const from = ids.get(e.fromNode);
    const dest = ids.get(e.toNode);
    if (from && dest)
      out.edges.push({ ...e, id: mk(), fromNode: from, toNode: dest });
  }
  return out;
}

// ── 三方合并 ──

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

type Rec = Record<string, unknown>;

/** 以 theirs 为底，把 mine 相对 base 改过的字段盖上去 */
function mergeFields<T extends Rec>(base: T, mine: T, theirs: T): T {
  const out: Rec = { ...theirs };
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    if (deepEqual(base[k], mine[k])) continue;
    if (k in mine) out[k] = mine[k];
    else delete out[k];
  }
  return out as T;
}

function mergeItems<T extends { id: string }>(
  base: readonly T[],
  mine: readonly T[],
  theirs: readonly T[],
): T[] {
  const B = new Map(base.map((x) => [x.id, x]));
  const M = new Map(mine.map((x) => [x.id, x]));
  const T_ = new Set(theirs.map((x) => x.id));
  const out: T[] = [];
  for (const t of theirs) {
    const b = B.get(t.id);
    const m = M.get(t.id);
    if (!b)
      out.push(t); // 对方新增
    else if (!m) {
      // 我删了：对方没动才算数，对方改过就保留对方的
      if (!deepEqual(b, t)) out.push(t);
    } else out.push(mergeFields(b as Rec, m as Rec, t as Rec) as T);
  }
  // 我新增的；对方删掉的（base 有、theirs 无）不会回来
  for (const m of mine) if (!B.has(m.id) && !T_.has(m.id)) out.push(m);
  return out;
}

/**
 * 用户拖动的同时 agent 加了卡片：以磁盘上的版本（theirs）为底，把用户相对上次已知版本（base）
 * 改过的位置、大小、连线盖上去；双方新增的都保留；任一方删掉的节点不再出现，连到它的线一并去掉。
 */
export function mergeDocs(
  base: CanvasDocJson,
  mine: CanvasDocJson,
  theirs: CanvasDocJson,
): CanvasDocJson {
  const nodes = mergeItems(base.nodes, mine.nodes, theirs.nodes);
  const alive = new Set(nodes.map((n) => n.id));
  const edges = mergeItems(base.edges, mine.edges, theirs.edges).filter(
    (e) => alive.has(e.fromNode) && alive.has(e.toNode),
  );
  const rest = mergeFields(
    { ...base, nodes: [], edges: [] } as Rec,
    { ...mine, nodes: [], edges: [] } as Rec,
    { ...theirs, nodes: [], edges: [] } as Rec,
  );
  return { ...(rest as CanvasDocJson), nodes, edges };
}

export const sameDoc = (a: CanvasDocJson, b: CanvasDocJson): boolean =>
  deepEqual(a, b);
