// 一个画布文件夹上的全部文件操作（canvas.md §2、§6）：逻辑路径相对 `.canvas/`、用 `/`，
// 落到环境时经 pathOf(env) 拼绝对路径。所有会改文件或 git 的方法都在同一条串行队列上。
import { createHash } from "node:crypto";
import type { ExecEnv } from "../env/types.js";
import { HttpError } from "../lib/http-error.js";
import { pathOf } from "../permission/paths.js";
import { rewriteAssetLinks } from "./assetLinks.js";
import {
  addFileNode,
  type CanvasDoc,
  CanvasFormatError,
  type CanvasNode,
  fileNodes,
  hostOf,
  parseCanvas,
  refKey,
  removeNodesByFile,
  renameFileRefs,
  renameFileRefsUnder,
  serializeCanvas,
} from "./format.js";
import {
  type CanvasCommit,
  CanvasGit,
  formatSubject,
  parseSubject,
  type Source,
} from "./git.js";
import {
  type IndexFile,
  type IndexInput,
  type IndexNote,
  renderIndex,
} from "./index-md.js";
import {
  assetsDir,
  boardFile,
  CANVAS_DIR,
  cardFile,
  cardsDir,
  classify,
  INDEX,
  insideCanvas,
  isCleanPath,
  isFolderPath,
  LARGE_DIR,
  noteAssetsDir,
  sanitizeName,
  sanitizePath,
  splitLeaf,
  timeName,
  uniqueName,
} from "./layout.js";
import { resolveLink, rewriteForMoves, scanWikilinks } from "./wikilink.js";

export type CanvasErrorCode =
  | "env_unavailable"
  | "invalid_path"
  | "invalid"
  | "not_found"
  | "conflict"
  | "exists"
  | "git_missing"
  | "format"
  | "too_large"
  | "unsupported"
  | "undo_failed";

const STATUS: Record<CanvasErrorCode, number> = {
  env_unavailable: 502,
  invalid_path: 400,
  invalid: 400,
  not_found: 404,
  conflict: 409,
  exists: 409,
  git_missing: 409,
  format: 422,
  too_large: 413,
  unsupported: 415,
  undo_failed: 409,
};

/** 画布业务的错误：带 HTTP 状态，接口层用 toHttp 翻译。 */
export class CanvasError extends HttpError {
  constructor(
    code: CanvasErrorCode,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(code, message, STATUS[code], extra);
  }
}

export interface Baseline {
  mtimeMs: number;
  sha256: string;
}

/** 基线不符：current 带磁盘上的当前基线，接口据此回 409。 */
export class CanvasConflict extends CanvasError {
  constructor(readonly current: Baseline) {
    super("conflict", "文件已被改动，请重新读取后再保存", {
      mtimeMs: current.mtimeMs,
      sha256: current.sha256,
    });
  }
}

export interface FileInfo {
  exists: boolean;
  kind: "card" | "ref";
  size?: number;
  mtimeMs?: number;
  preview?: string | null;
  /** 有 preview 且文件文本比 preview 长。 */
  truncated?: boolean;
  /** 别的主机上的引用，那台主机现在连不上：不是文件缺失，主机回来就好 */
  unreachable?: boolean;
}

export interface BoardSummary {
  name: string;
  cards: number;
  mtimeMs: number;
}

export interface BoardRead {
  doc: CanvasDoc;
  baseline: Baseline;
  files: Record<string, FileInfo>;
}

export interface CanvasHistoryEntry {
  sha: string;
  ts: number;
  source: "agent" | "user" | "external" | "restore" | "undo";
  session?: string;
  summary: string;
}

/** 卡片预览的字符数上限、二进制判定上限与索引生成的并发度。 */
const PREVIEW_CHARS = 4000;
const PREVIEW_MAX_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 8;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const SHA256 = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");
const mtime = (st: { mtimeMs: number }): number => Math.round(st.mtimeMs);

/** 资源的文件名：保留扩展名（小写、只留字母数字），名字部分清洗，重名在扩展名之前加 ` (2)`；名字清洗后是空就用时间。 */
export function uniqueFileName(
  taken: ReadonlySet<string>,
  raw: string,
): string {
  const dot = raw.lastIndexOf(".");
  const ext =
    dot > 0
      ? raw
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 10)
      : "";
  const stem =
    sanitizeName(dot > 0 ? raw.slice(0, dot) : raw) || timeName(new Date());
  const suffix = ext === "" ? "" : `.${ext}`;
  for (let n = 1; ; n++) {
    const name = `${stem}${n === 1 ? "" : ` (${n})`}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** 一次批量保存（界面上点「保存」）：画布文档、改过的卡片、新卡片一起落盘，只生成一次索引、提交一次。 */
export interface SaveBatchInput {
  /** 画布文档；没改布局时不带。新卡片的节点已经在里面，它们的 file 在落盘时换成建出来的文件 */
  doc?: CanvasDoc;
  /** 文档的基线 */
  expect?: { mtimeMs?: number; sha256?: string };
  edits: Array<{
    path: string;
    text: string;
    expect?: { mtimeMs?: number; sha256?: string };
  }>;
  /** 新卡片：doc 里 nodeId 这个文件节点，正文是 text（可以是空） */
  created: Array<{ nodeId: string; text: string }>;
}

export interface SaveBatchResult {
  /** 写了文档才有 */
  baseline: Baseline | null;
  edits: Array<{ path: string; baseline: Baseline }>;
  created: Array<{ nodeId: string; path: string; baseline: Baseline }>;
  /** 磁盘上被别处改过、没有写入的卡片 */
  conflicts: string[];
}

export interface CanvasRepoOptions {
  /** 用户改动合成一次提交前的停顿；默认 5000 */
  commitDelayMs?: number;
  /** 引用别的主机上的文件时，按环境 id 取那台主机；取不到（没连上）算 unreachable */
  envOf?: (id: string) => ExecEnv | null;
  /** 环境 id → 给 agent 看的主机名（index.md 里用） */
  hostLabel?: (id: string) => string;
  /** env 是副本环境（ReplicaEnv）：`.canvas/` 的读写都在本机，初始化时不去碰远端的项目仓库 */
  mirrored?: boolean;
}

export class CanvasRepo {
  readonly root: string;
  private readonly pm: ReturnType<typeof pathOf>;
  private readonly git: CanvasGit;
  private readonly commitDelayMs: number;
  private readonly envOf: (id: string) => ExecEnv | null;
  private readonly hostLabel: (id: string) => string;
  private readonly mirrored: boolean;
  /** 串行队列：同一个画布文件夹上的操作不交错。 */
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { source: Source; notes: string[] } | null = null;
  private ensured = false;
  /** 正在落盘的一批操作：期间不自动提交，批次自己提交一次。 */
  private batching = 0;

  constructor(
    private readonly env: ExecEnv,
    readonly projectDir: string,
    opts: CanvasRepoOptions = {},
  ) {
    this.pm = pathOf(env);
    this.root = this.pm.join(projectDir, CANVAS_DIR);
    this.git = new CanvasGit(env, this.root);
    this.commitDelayMs = opts.commitDelayMs ?? 5000;
    this.envOf = opts.envOf ?? (() => null);
    this.hostLabel = opts.hostLabel ?? ((id) => id);
    this.mirrored = opts.mirrored ?? false;
  }

  // ---- 读 ----

  async status(): Promise<{ ready: boolean; git: "ok" | "missing" }> {
    const ready = (await this.statOf(this.root))?.isDirectory === true;
    if (!ready) return { ready, git: "missing" };
    const ok = await this.gitReady();
    return { ready, git: ok ? "ok" : "missing" };
  }

  async listBoards(): Promise<BoardSummary[]> {
    return this.summaries(await this.boardNames());
  }

  /** 树里的全部东西：文件夹（含空的）、画布、笔记，路径都相对 `.canvas/`，已排序。 */
  async listTree(): Promise<{
    folders: string[];
    boards: BoardSummary[];
    notes: string[];
  }> {
    const tree = await this.scanTree();
    return {
      folders: tree.folders,
      boards: await this.summaries(tree.boards),
      notes: tree.notes.map((n) => n.path),
    };
  }

  private async summaries(names: string[]): Promise<BoardSummary[]> {
    const out: BoardSummary[] = [];
    for (const name of names) {
      const st = await this.statOf(this.abs(boardFile(name)));
      let cards = 0;
      try {
        cards = (await this.env.readdir(this.abs(cardsDir(name)))).filter(
          (e) => !e.isDirectory && e.name.endsWith(".md"),
        ).length;
      } catch {
        cards = 0;
      }
      out.push({ name, cards, mtimeMs: st ? mtime(st) : 0 });
    }
    return out;
  }

  /** 谁引用了这篇笔记 / 这块画布：哪些画布上放着它（只有笔记会被放上画布）、哪些笔记的 `[[…]]` 指向它。删除前的确认框用。 */
  async referrers(rel: string): Promise<{ boards: string[]; notes: string[] }> {
    const kind = classify(rel).kind;
    if (!insideCanvas(rel) || (kind !== "note" && kind !== "board"))
      throw new CanvasError("invalid_path", `不是笔记或画布路径：${rel}`);
    const tree = await this.scanTree();
    const known = new Set([
      ...tree.boards.map(boardFile),
      ...tree.notes.map((n) => n.path),
    ]);
    if (!known.has(rel)) throw new CanvasError("not_found", `不存在：${rel}`);
    const boards: string[] = [];
    if (kind === "note")
      for (const name of tree.boards) {
        const loaded = await this.loadBoard(name).catch(() => null);
        if (
          loaded?.doc.nodes.some(
            (n) => n.type === "file" && n.file === rel && hostOf(n) === "",
          )
        )
          boards.push(name);
      }
    const notes: string[] = [];
    for (const n of tree.notes) {
      if (n.path === rel) continue;
      const bytes = await this.readOf(n.path);
      if (
        bytes === null ||
        bytes.length > PREVIEW_MAX_BYTES ||
        bytes.includes(0)
      )
        continue;
      if (
        scanWikilinks(bytes.toString("utf8")).some(
          (t) => resolveLink(t, known) === rel,
        )
      )
        notes.push(n.path);
    }
    return { boards, notes };
  }

  async readBoard(name: string): Promise<BoardRead> {
    const { doc, baseline } = await this.loadBoard(name);
    const files: Record<string, FileInfo> = {};
    // 一个文件只查一次；远端引用按「主机:路径」分开（不同主机上的同一路径是两个文件）
    const byKey = new Map<string, CanvasNode>();
    for (const n of fileNodes(doc))
      if (!byKey.has(refKey(n))) byKey.set(refKey(n), n);
    const keys = [...byKey.keys()];
    for (let i = 0; i < keys.length; i += READ_CONCURRENCY) {
      const batch = keys.slice(i, i + READ_CONCURRENCY);
      const infos = await Promise.all(
        batch.map((k) => {
          const n = byKey.get(k) as CanvasNode;
          const rel = String(n.file);
          if (hostOf(n) !== "") return this.remoteInfo(hostOf(n), rel);
          return this.infoOf(rel);
        }),
      );
      batch.forEach((k, j) => {
        files[k] = infos[j] as FileInfo;
      });
    }
    return { doc, baseline, files };
  }

  /** 树里全部笔记的相对路径（已排序）。 */
  async listNotes(): Promise<string[]> {
    return (await this.scanTree()).notes.map((n) => n.path);
  }

  async readNote(rel: string): Promise<{ text: string; baseline: Baseline }> {
    this.assertIsNote(rel);
    const bytes = await this.readOf(rel);
    if (bytes === null)
      throw new CanvasError("not_found", `笔记不存在：${rel}`);
    return {
      text: bytes.toString("utf8"),
      baseline: await this.requireBaseline(rel, bytes),
    };
  }

  /** 灵感卡与笔记都是文本文件，界面按同一套读写（原地编辑）。 */
  async readCard(rel: string): Promise<{ text: string; baseline: Baseline }> {
    this.assertIsText(rel);
    const bytes = await this.readOf(rel);
    if (bytes === null)
      throw new CanvasError("not_found", `卡片不存在：${rel}`);
    return {
      text: bytes.toString("utf8"),
      baseline: await this.requireBaseline(rel, bytes),
    };
  }

  /** 逻辑路径指向的文件是否存在；ops 用它查项目文件。 */
  async fileExists(rel: string): Promise<boolean> {
    const st = await this.statOf(this.abs(rel));
    return st?.isFile === true;
  }

  /** 别的主机上的文件：是文件 / 不存在 / 那台主机现在连不上 */
  async probeRemote(
    host: string,
    abs: string,
  ): Promise<"file" | "missing" | "unreachable"> {
    const env = this.envOf(host);
    if (env === null) return "unreachable";
    try {
      return (await env.stat(abs))?.isFile === true ? "file" : "missing";
    } catch {
      return "unreachable";
    }
  }

  // ---- 写 ----

  /** 建 `.canvas/` 并初始化仓库；第一次写操作（含 createBoard）会自己调它。 */
  async ensure(): Promise<void> {
    await this.serial(() => this.begin());
  }

  async saveBoard(
    name: string,
    doc: CanvasDoc,
    expect?: { mtimeMs?: number; sha256?: string },
  ): Promise<Baseline> {
    return this.serial(async () => {
      await this.begin();
      const rel = boardFile(name);
      const cur = await this.baselineOf(rel);
      if (cur === null)
        throw new CanvasError("not_found", `画布不存在：${name}`);
      this.checkExpect(cur, expect);
      await this.writeAtomic(rel, serializeCanvas(doc));
      this.touch({ kind: "user" }, `save ${rel}`);
      return (await this.baselineOf(rel)) as Baseline;
    });
  }

  async saveCard(
    rel: string,
    text: string,
    expect?: { mtimeMs?: number; sha256?: string },
  ): Promise<Baseline> {
    return this.serial(async () => {
      await this.begin();
      this.assertIsText(rel);
      const cur = await this.baselineOf(rel);
      if (cur === null)
        throw new CanvasError("not_found", `卡片不存在：${rel}`);
      this.checkExpect(cur, expect);
      await this.writeAtomic(rel, text);
      this.touch({ kind: "user" }, `save ${rel}`);
      return (await this.baselineOf(rel)) as Baseline;
    });
  }

  /**
   * 批量保存。先查后写：文档基线不符整批拒绝（409）、卡片不存在整批拒绝（404），此时磁盘还没动过；
   * 单张卡片基线不符只跳过那一张，结果里列出来。写入顺序：改过的卡片 → 新卡片 → 文档最后写，
   * 文档里不会出现还没建出来的卡片。
   */
  async saveBatch(
    board: string,
    input: SaveBatchInput,
  ): Promise<SaveBatchResult> {
    return this.serial(async () => {
      await this.begin();
      const { doc, expect, edits, created } = input;
      const boardRel = boardFile(board);
      if (doc !== undefined) {
        const cur = await this.baselineOf(boardRel);
        if (cur === null)
          throw new CanvasError("not_found", `画布不存在：${board}`);
        this.checkExpect(cur, expect);
      }
      const byId = new Map((doc?.nodes ?? []).map((n) => [n.id, n]));
      const fresh: Array<{ node: CanvasNode; text: string }> = [];
      for (const c of created) {
        const node = byId.get(c.nodeId);
        if (node?.type !== "file")
          throw new CanvasError("invalid", `没有这个文件节点：${c.nodeId}`);
        fresh.push({ node, text: c.text });
      }
      const conflicts: string[] = [];
      const writable: typeof edits = [];
      for (const e of edits) {
        this.assertIsText(e.path);
        if (
          classify(e.path).kind === "card" &&
          this.boardOfCard(e.path) !== board
        )
          throw new CanvasError(
            "invalid_path",
            `不是这块画布的卡片：${e.path}`,
          );
        const cur = await this.baselineOf(e.path);
        if (cur === null)
          throw new CanvasError("not_found", `卡片不存在：${e.path}`);
        try {
          this.checkExpect(cur, e.expect);
          writable.push(e);
        } catch (err) {
          if (!(err instanceof CanvasConflict)) throw err;
          conflicts.push(e.path);
        }
      }

      const out: SaveBatchResult = {
        baseline: null,
        edits: [],
        created: [],
        conflicts,
      };
      const write = async (
        rel: string,
        text: string,
        dirReady = false,
      ): Promise<Baseline> => {
        await this.writeAtomic(rel, text, dirReady);
        this.touch({ kind: "user" }, `save ${rel}`);
        // 写进去的就是 text：基线不用把文件再读回来，只补一次 stat 取 mtime
        return (await this.baselineOf(rel, Buffer.from(text))) as Baseline;
      };
      for (const e of writable)
        out.edits.push({ path: e.path, baseline: await write(e.path, e.text) });
      if (fresh.length > 0) {
        await this.env.mkdirp(this.abs(cardsDir(board)));
        const taken = await this.cardNames(board);
        for (const { node, text } of fresh) {
          const name = uniqueName(taken, timeName(new Date()));
          taken.add(name);
          const path = cardFile(board, name);
          const baseline = await write(path, text, true);
          node.file = path;
          out.created.push({ nodeId: node.id, path, baseline });
        }
      }
      if (doc !== undefined)
        out.baseline = await write(boardRel, serializeCanvas(doc));
      return out;
    });
  }

  /** 建一块空画布与它的资源文件夹；名字清洗、空名用时间、重名加序号，返回最终名。 */
  async createBoard(name: string): Promise<string> {
    return this.serial(async () => {
      await this.begin();
      const final = await this.uniqueBoardName(name);
      await this.writeAtomic(
        boardFile(final),
        serializeCanvas({ nodes: [], edges: [] }),
      );
      await this.env.mkdirp(this.abs(cardsDir(final)));
      this.touch({ kind: "user" }, `create ${boardFile(final)}`);
      return final;
    });
  }

  async renameBoard(from: string, to: string): Promise<string> {
    return this.serial(async () => {
      await this.begin();
      await this.loadBoard(from);
      const taken = new Set(
        (await this.boardNames()).filter((n) => n !== from),
      );
      const final = uniqueName(
        taken,
        splitLeaf(from).dir + (sanitizeName(to) || timeName(new Date())),
      );
      if (final === from) return from;
      await this.relocateBoard(from, final);
      return final;
    });
  }

  /** 把画布挪到另一个名字（可以在别的文件夹里）；名字已被占用报错，卡片与资源文件夹一起走。 */
  async moveBoard(from: string, to: string): Promise<string> {
    return this.serial(async () => {
      await this.begin();
      await this.loadBoard(from);
      if (to === from) return from;
      const { dir } = splitLeaf(to);
      if (!isCleanPath(to) || (dir !== "" && !isFolderPath(dir.slice(0, -1))))
        throw new CanvasError("invalid_path", `不是合法的画布名：${to}`);
      if ((await this.boardNames()).includes(to))
        throw new CanvasError("exists", `已有同名画布：${to}`);
      await this.relocateBoard(from, to);
      return to;
    });
  }

  private async relocateBoard(from: string, final: string): Promise<void> {
    const { doc } = await this.loadBoard(from);
    for (const d of [cardsDir(final), assetsDir(final)])
      if ((await this.statOf(this.abs(d))) !== null)
        throw new CanvasError("exists", `目标已存在：${d}`);
    const known = await this.linkTargets();
    await this.env.mkdirp(this.pm.dirname(this.abs(boardFile(final))));
    renameFileRefsUnder(doc, cardsDir(from), cardsDir(final));
    await this.env.rename(
      this.abs(boardFile(from)),
      this.abs(boardFile(final)),
    );
    if ((await this.statOf(this.abs(cardsDir(from))))?.isDirectory)
      await this.env.rename(
        this.abs(cardsDir(from)),
        this.abs(cardsDir(final)),
      );
    renameFileRefsUnder(doc, assetsDir(from), assetsDir(final));
    if ((await this.statOf(this.abs(assetsDir(from))))?.isDirectory)
      await this.env.rename(
        this.abs(assetsDir(from)),
        this.abs(assetsDir(final)),
      );
    await this.writeAtomic(boardFile(final), serializeCanvas(doc));
    await this.rewriteNoteLinks(
      new Map([[boardFile(from), boardFile(final)]]),
      known,
    );
    this.touch({ kind: "user" }, `rename ${boardFile(from)}`);
  }

  async deleteBoard(name: string): Promise<void> {
    await this.serial(async () => {
      await this.begin();
      const rel = boardFile(name);
      if ((await this.statOf(this.abs(rel))) === null)
        throw new CanvasError("not_found", `画布不存在：${name}`);
      await this.env.remove(this.abs(rel));
      for (const d of [cardsDir(name), assetsDir(name)])
        if ((await this.statOf(this.abs(d)))?.isDirectory)
          await this.env.remove(this.abs(d), true);
      this.touch({ kind: "user" }, `delete ${rel}`);
    });
  }

  async createCard(
    board: string,
    input: { name?: string; text?: string; at?: { x: number; y: number } } = {},
  ): Promise<{ path: string; nodeId: string }> {
    return this.serial(async () => {
      await this.begin();
      const { doc } = await this.loadBoard(board);
      await this.env.mkdirp(this.abs(cardsDir(board)));
      const final = uniqueName(
        await this.cardNames(board),
        sanitizeName(input.name ?? "") || timeName(new Date()),
      );
      const path = cardFile(board, final);
      await this.writeAtomic(path, input.text ?? "");
      const node = addFileNode(doc, path, input.at);
      await this.writeAtomic(boardFile(board), serializeCanvas(doc));
      this.touch({ kind: "user" }, `create ${path}`);
      return { path, nodeId: node.id };
    });
  }

  /**
   * 粘贴 / 拖进画布的资源，分三步，为的是上传（可能很久）不占住串行队列：
   * 1. startAsset：建好资源文件夹，给出一个临时文件的绝对路径（在 `_large/` 里，不会被提交）；
   * 2. 调用方把字节流写进去（接口层做大小上限）；
   * 3. finishAsset：按大小定最终位置（超过 gitMaxBytes 的留在 `_large/`，其余在资源文件夹里）、避让重名，
   *    把节点放进画布文档，登记提交。
   * 出错就 discardAsset 删掉临时文件。
   */
  async startAsset(board: string): Promise<{ tmp: string }> {
    return this.serial(async () => {
      await this.begin();
      await this.loadBoard(board);
      const dir = this.abs(`${assetsDir(board)}/${LARGE_DIR}`);
      await this.env.mkdirp(dir);
      return {
        tmp: this.pm.join(
          dir,
          `.${Math.random().toString(16).slice(2, 12)}.part`,
        ),
      };
    });
  }

  /** 把写好的临时文件放进资源夹 dir：按大小定在 dir 里还是 `_large/` 里、避让重名；返回相对 `.canvas/` 的最终路径 */
  private async placeAsset(
    dir: string,
    tmp: string,
    input: { name: string; size: number; gitMaxBytes: number },
  ): Promise<{ path: string; large: boolean }> {
    const large = input.size > input.gitMaxBytes;
    const taken = new Set<string>();
    for (const d of [dir, `${dir}/${LARGE_DIR}`])
      for (const e of await this.env
        .readdir(this.abs(d))
        .catch(() => [] as Awaited<ReturnType<ExecEnv["readdir"]>>))
        if (!e.isDirectory) taken.add(e.name.toLowerCase());
    const name = uniqueFileName(taken, input.name);
    const path = `${dir}/${large ? `${LARGE_DIR}/` : ""}${name}`;
    await this.env.rename(tmp, this.abs(path));
    return { path, large };
  }

  async finishAsset(
    board: string,
    tmp: string,
    input: {
      name: string;
      size: number;
      /** 超过它就不进画布的 git 历史 */
      gitMaxBytes: number;
      at?: { x: number; y: number };
      nodeSize?: { w: number; h: number };
    },
  ): Promise<{ path: string; nodeId: string; large: boolean }> {
    return this.serial(async () => {
      const { doc } = await this.loadBoard(board);
      const { path, large } = await this.placeAsset(
        assetsDir(board),
        tmp,
        input,
      );
      const node = addFileNode(doc, path, input.at, input.nodeSize);
      await this.writeAtomic(boardFile(board), serializeCanvas(doc));
      this.touch({ kind: "user" }, `add ${path}`);
      return { path, nodeId: node.id, large };
    });
  }

  async discardAsset(tmp: string): Promise<void> {
    await this.env.remove(tmp).catch(() => {});
  }

  /**
   * 笔记里的图片（粘贴 / 拖进笔记编辑区）：存进笔记所在文件夹的隐藏文件夹 `.assets/<笔记名>/`，
   * 不是画布节点、不改任何画布文档。分两步，同上传画布资源：startNoteAsset 给临时文件，写完字节流后 finishNoteAsset 落位。
   * 笔记改名 / 挪动 / 删除时资源夹跟着走（见 moveNote、deleteNote）。
   */
  async startNoteAsset(note: string): Promise<{ tmp: string }> {
    return this.serial(async () => {
      await this.begin();
      this.assertIsNote(note);
      if ((await this.statOf(this.abs(note))) === null)
        throw new CanvasError("not_found", `笔记不存在：${note}`);
      const dir = this.abs(`${noteAssetsDir(note)}/${LARGE_DIR}`);
      await this.env.mkdirp(dir);
      return {
        tmp: this.pm.join(
          dir,
          `.${Math.random().toString(16).slice(2, 12)}.part`,
        ),
      };
    });
  }

  async finishNoteAsset(
    note: string,
    tmp: string,
    input: { name: string; size: number; gitMaxBytes: number },
  ): Promise<{ path: string; large: boolean }> {
    return this.serial(async () => {
      const made = await this.placeAsset(noteAssetsDir(note), tmp, input);
      this.touch({ kind: "user" }, `add ${made.path}`);
      return made;
    });
  }

  /** 删资源：文件与引用它的节点（连同连到节点的边）一起删。放在 `_large/` 里的没进历史，删了找不回。 */
  async deleteAsset(rel: string): Promise<void> {
    await this.serial(async () => {
      await this.begin();
      const board = this.boardOfAsset(rel);
      const { doc } = await this.loadBoard(board);
      if ((await this.statOf(this.abs(rel))) === null)
        throw new CanvasError("not_found", `资源不存在：${rel}`);
      await this.env.remove(this.abs(rel));
      removeNodesByFile(doc, rel);
      await this.writeAtomic(boardFile(board), serializeCanvas(doc));
      this.touch({ kind: "user" }, `delete ${rel}`);
    });
  }

  async renameCard(rel: string, name: string): Promise<string> {
    return this.serial(async () => {
      await this.begin();
      const board = this.boardOfCard(rel);
      const { doc } = await this.loadBoard(board);
      const taken = new Set(await this.cardNames(board));
      taken.delete(rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/, ""));
      const final = uniqueName(
        taken,
        sanitizeName(name) || timeName(new Date()),
      );
      const next = cardFile(board, final);
      if (next === rel) return rel;
      if ((await this.statOf(this.abs(rel))) === null)
        throw new CanvasError("not_found", `卡片不存在：${rel}`);
      await this.env.rename(this.abs(rel), this.abs(next));
      renameFileRefs(doc, rel, next);
      await this.writeAtomic(boardFile(board), serializeCanvas(doc));
      this.touch({ kind: "user" }, `rename ${rel}`);
      return next;
    });
  }

  async deleteCard(rel: string): Promise<void> {
    await this.serial(async () => {
      await this.begin();
      const board = this.boardOfCard(rel);
      const { doc } = await this.loadBoard(board);
      if ((await this.statOf(this.abs(rel))) === null)
        throw new CanvasError("not_found", `卡片不存在：${rel}`);
      await this.env.remove(this.abs(rel));
      removeNodesByFile(doc, rel);
      await this.writeAtomic(boardFile(board), serializeCanvas(doc));
      this.touch({ kind: "user" }, `delete ${rel}`);
    });
  }

  // ---- 笔记：树里的 .md，不属于任何一块画布；被画布引用的节点随笔记改名、删除而更新 ----

  async createNote(rel: string, text: string): Promise<Baseline> {
    return this.serial(async () => {
      await this.begin();
      this.assertIsNote(rel);
      if ((await this.statOf(this.abs(rel))) !== null)
        throw new CanvasError("exists", `笔记已存在：${rel}`);
      await this.writeAtomic(rel, text);
      this.touch({ kind: "user" }, `create ${rel}`);
      return (await this.baselineOf(rel, Buffer.from(text))) as Baseline;
    });
  }

  async saveNote(
    rel: string,
    text: string,
    expect?: { mtimeMs?: number; sha256?: string },
  ): Promise<Baseline> {
    return this.serial(async () => {
      await this.begin();
      this.assertIsNote(rel);
      const cur = await this.baselineOf(rel);
      if (cur === null)
        throw new CanvasError("not_found", `笔记不存在：${rel}`);
      this.checkExpect(cur, expect);
      await this.writeAtomic(rel, text);
      this.touch({ kind: "user" }, `save ${rel}`);
      return (await this.baselineOf(rel, Buffer.from(text))) as Baseline;
    });
  }

  async moveNote(from: string, to: string): Promise<void> {
    await this.serial(async () => {
      await this.begin();
      this.assertIsNote(from);
      this.assertIsNote(to);
      const known = await this.linkTargets();
      const assets = await this.assetsToMove(from, to);
      await this.moveFile(from, to);
      if (assets) {
        await this.env.mkdirp(this.pm.dirname(this.abs(assets.to)));
        await this.env.rename(this.abs(assets.from), this.abs(assets.to));
        await this.removeIfEmpty(this.pm.dirname(this.abs(assets.from)));
        await this.rewriteOwnAssetLinks(to, from);
      }
      await this.rewriteNoteLinks(new Map([[from, to]]), known);
      this.touch({ kind: "user" }, `rename ${from}`);
    });
  }

  /**
   * 笔记挪动 / 改名时它的图片资源夹（`<文件夹>/.assets/<笔记名>/`）要跟着走：有资源夹、位置变了才需要；
   * 目标位置已有同名文件夹报错（挪之前就判，免得挪了一半）。
   */
  private async assetsToMove(
    from: string,
    to: string,
  ): Promise<{ from: string; to: string } | null> {
    const a = noteAssetsDir(from);
    const b = noteAssetsDir(to);
    if (a === b || !(await this.statOf(this.abs(a)))?.isDirectory) return null;
    if ((await this.statOf(this.abs(b))) !== null)
      throw new CanvasError("exists", `目标已存在：${b}`);
    return { from: a, to: b };
  }

  /** 空文件夹就删（资源夹挪走后留下的空 `.assets/`）；非空或不存在不管 */
  private async removeIfEmpty(abs: string): Promise<void> {
    const left = await this.env.readdir(abs).catch(() => null);
    if (left !== null && left.length === 0)
      await this.env.remove(abs, true).catch(() => {});
  }

  /** 笔记改了名：正文里指向自己旧资源夹的相对链接改到新名字（只是换了文件夹、名字没变时不用改） */
  private async rewriteOwnAssetLinks(
    note: string,
    oldNote: string,
  ): Promise<void> {
    const stemOf = (p: string) =>
      p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, "");
    if (stemOf(note) === stemOf(oldNote)) return;
    const bytes = await this.readOf(note);
    if (bytes === null || bytes.length > PREVIEW_MAX_BYTES || bytes.includes(0))
      return;
    const text = bytes.toString("utf8");
    const next = rewriteAssetLinks(text, stemOf(oldNote), stemOf(note));
    if (next !== text) await this.writeAtomic(note, next);
  }

  // ---- 文件夹：树里用户自己建的目录（画布的 .cards / .assets 不算） ----

  async createFolder(rel: string): Promise<void> {
    await this.serial(async () => {
      await this.begin();
      this.assertFolder(rel);
      if ((await this.statOf(this.abs(rel))) !== null)
        throw new CanvasError("exists", `已存在：${rel}`);
      await this.env.mkdirp(this.abs(rel));
    });
  }

  /** 挪（或改名）一个文件夹：里面的画布、笔记、卡片、资源一起走；画布上的节点按前缀改，所有笔记里的 `[[…]]` 跟着改。 */
  async moveFolder(from: string, to: string): Promise<void> {
    await this.serial(async () => {
      await this.begin();
      this.assertFolder(from);
      this.assertFolder(to);
      if (to === from || to.startsWith(`${from}/`))
        throw new CanvasError("invalid", "不能把文件夹挪到它自己里面");
      if (!(await this.statOf(this.abs(from)))?.isDirectory)
        throw new CanvasError("not_found", `文件夹不存在：${from}`);
      if ((await this.statOf(this.abs(to))) !== null)
        throw new CanvasError("exists", `目标已存在：${to}`);
      const tree = await this.scanTree();
      const known = new Set([
        ...tree.boards.map(boardFile),
        ...tree.notes.map((n) => n.path),
      ]);
      const prefix = `${from}/`;
      const moves = new Map<string, string>();
      for (const b of tree.boards)
        if (b.startsWith(prefix))
          moves.set(boardFile(b), boardFile(to + b.slice(from.length)));
      for (const n of tree.notes)
        if (n.path.startsWith(prefix))
          moves.set(n.path, to + n.path.slice(from.length));
      await this.env.mkdirp(this.pm.dirname(this.abs(to)));
      await this.env.rename(this.abs(from), this.abs(to));
      await this.editBoards((doc) => renameFileRefsUnder(doc, from, to));
      await this.rewriteNoteLinks(moves, known);
      this.touch({ kind: "user" }, `move ${from}/`);
    });
  }

  /** 删文件夹：里面的一切一起删；别的画布上放着里面笔记的节点一并去掉（连线跟着没）。 */
  async deleteFolder(rel: string): Promise<void> {
    await this.serial(async () => {
      await this.begin();
      this.assertFolder(rel);
      if (!(await this.statOf(this.abs(rel)))?.isDirectory)
        throw new CanvasError("not_found", `文件夹不存在：${rel}`);
      const prefix = `${rel}/`;
      const gone = (await this.scanTree()).notes
        .map((n) => n.path)
        .filter((p) => p.startsWith(prefix));
      await this.env.remove(this.abs(rel), true);
      await this.editBoards((doc) =>
        gone.reduce((n, p) => n + removeNodesByFile(doc, p), 0),
      );
      this.touch({ kind: "user" }, `delete ${rel}/`);
    });
  }

  async deleteNote(rel: string): Promise<void> {
    await this.serial(async () => {
      await this.begin();
      this.assertIsNote(rel);
      if ((await this.statOf(this.abs(rel))) === null)
        throw new CanvasError("not_found", `笔记不存在：${rel}`);
      await this.env.remove(this.abs(rel));
      // 笔记自己的图片资源夹一起删，删空了的 .assets/ 也收掉
      const assets = this.abs(noteAssetsDir(rel));
      if ((await this.statOf(assets))?.isDirectory) {
        await this.env.remove(assets, true);
        await this.removeIfEmpty(this.pm.dirname(assets));
      }
      await this.editBoards((doc) => removeNodesByFile(doc, rel));
      this.touch({ kind: "user" }, `delete ${rel}`);
    });
  }

  /** 灵感卡升格为笔记：文件挪到树里的 to，节点留在画布上、改成指向新位置的引用。 */
  async promoteCard(rel: string, to: string): Promise<void> {
    await this.serial(async () => {
      await this.begin();
      this.assertIsCard(rel);
      this.assertIsNote(to);
      await this.moveFile(rel, to);
      this.touch({ kind: "user" }, `promote ${rel}`);
    });
  }

  // ---- 提交节奏 ----

  /** 取消定时器并立即冲一次：写操作开始前、canvas_edit 前、读历史前都先调它。 */
  async settle(): Promise<void> {
    await this.serial(() => this.flushInner());
  }

  async regenerateIndex(): Promise<void> {
    await this.serial(() => this.regenerateInner());
  }

  /** 整批落盘开始：期间不自动提交（canvas_edit 自己收尾时提交一次）。 */
  beginBatch(): void {
    this.batching++;
    this.clearTimer();
  }

  /** 整批落盘结束。 */
  endBatch(): void {
    if (this.batching > 0) this.batching--;
  }

  /** 工作区是否干净（含未跟踪文件）；没有 git 时恒为 true。 */
  async isClean(): Promise<boolean> {
    if (!(await this.gitReady())) return true;
    return !(await this.git.dirty());
  }

  /** canvas_edit 用：重生成 index 后立即提交一次，来源由调用方给。 */
  async commitAs(source: Source, summary: string): Promise<string | null> {
    return this.serial(async () => {
      // 这一批自己的改动已经在这里提交；之后再有用户改动会重新登记
      this.clearTimer();
      await this.regenerateInner();
      const sha = await this.git.commitAll(formatSubject(source, summary));
      this.pending = null;
      return sha;
    });
  }

  /** 整批操作中途失败时回滚；只在上层确认过开始时工作区干净的前提下调用。 */
  async rollback(): Promise<void> {
    return this.serial(async () => {
      this.clearTimer();
      this.pending = null;
      if (!(await this.gitReady())) return;
      await this.git.rollback();
    });
  }

  /** 一块画布资源文件夹里现有卡片的相对路径。 */
  async listCardFiles(board: string): Promise<string[]> {
    let entries: Awaited<ReturnType<ExecEnv["readdir"]>>;
    try {
      entries = await this.env.readdir(this.abs(cardsDir(board)));
    } catch {
      return [];
    }
    return entries
      .filter((e) => !e.isDirectory && e.name.endsWith(".md"))
      .map((e) => `${cardsDir(board)}/${e.name}`)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // ---- 历史 ----

  async history(rel?: string, limit?: number): Promise<CanvasHistoryEntry[]> {
    await this.settle();
    if (rel !== undefined && !insideCanvas(rel))
      throw new CanvasError("invalid_path", `路径不在 .canvas/ 内：${rel}`);
    if (!(await this.gitReady())) return [];
    const commits = await this.git.log(rel, limit);
    return commits.map((c: CanvasCommit) => {
      const p = parseSubject(c.subject);
      return {
        sha: c.sha,
        ts: c.ts,
        source: p.source.kind,
        ...(p.source.kind === "agent" ? { session: p.source.session } : {}),
        summary: p.summary,
      };
    });
  }

  async version(sha: string, rel: string): Promise<string> {
    await this.settle();
    await this.mustHaveGit();
    if (!insideCanvas(rel))
      throw new CanvasError("invalid_path", `路径不在 .canvas/ 内：${rel}`);
    const text = await this.showOrThrow(sha, rel);
    if (text === null)
      throw new CanvasError("not_found", `那个版本里没有这个文件：${rel}`);
    return text;
  }

  /** 把某个版本的内容写回当前文件，作为新提交（来源 restore）。 */
  async restore(rel: string, sha: string): Promise<string> {
    return this.serial(async () => {
      await this.flushInner();
      await this.mustHaveGit();
      if (!insideCanvas(rel))
        throw new CanvasError("invalid_path", `路径不在 .canvas/ 内：${rel}`);
      const text = await this.showOrThrow(sha, rel);
      if (text === null)
        throw new CanvasError("not_found", `那个版本里没有这个文件：${rel}`);
      await this.writeAtomic(rel, text);
      await this.regenerateInner();
      const committed = await this.git.commitAll(
        formatSubject({ kind: "restore" }, `restore ${rel}`),
      );
      if (committed !== null) return committed;
      const head = await this.git.log(undefined, 1);
      return head[0]?.sha ?? "";
    });
  }

  /** 撤销最近一个 agent 提交；之后又有提交时不做聪明处理，直接报原因。 */
  async undoLastAgent(): Promise<
    { ok: true; sha: string } | { ok: false; reason: string }
  > {
    return this.serial(async () => {
      await this.flushInner();
      await this.mustHaveGit();
      const commits = await this.git.log(undefined, 1);
      const head = commits[0];
      if (head === undefined)
        return { ok: false, reason: "还没有提交，没有可撤销的 agent 操作" };
      const parsed = parseSubject(head.subject);
      if (parsed.source.kind !== "agent")
        return { ok: false, reason: "之后又有改动，请用历史逐个文件恢复" };
      return this.git.revert(
        head.sha,
        formatSubject({ kind: "undo" }, parsed.summary),
      );
    });
  }

  // ---- 内部 ----

  /** 串行队列：前一个失败也继续排下一个。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 写操作的前置：先处理待提交的改动，再确保 `.canvas/` 与仓库就绪。
   * 还在去抖窗口里的自己的改动只取消定时器、接着攒；没有待提交的东西但工作区脏了，
   * 说明是别人绕开界面改的，先按 external 记进历史。
   */
  private async begin(): Promise<void> {
    if (this.batching > 0 || this.pending !== null) this.clearTimer();
    else if (!(await this.isClean())) await this.flushInner();
    if (this.ensured) return;
    if ((await this.statOf(this.root))?.isDirectory !== true)
      await this.env.mkdirp(this.root);
    await this.git.ensure(this.mirrored ? null : this.projectDir);
    this.ensured = true;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 登记来源并（重新）起定时器；到点经 serial 冲一次。整批落盘期间只登记。 */
  private touch(source: Source, note: string): void {
    this.pending =
      this.pending === null
        ? { source, notes: [note] }
        : { source, notes: [...this.pending.notes, note] };
    if (this.batching > 0) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.serial(() => this.flushInner()).catch(() => {});
    }, this.commitDelayMs);
    this.timer.unref?.();
  }

  /**
   * 重生成 index.md 后提交；没有登记的来源但工作区有改动时记作 external。
   * `.canvas/` 还不存在时什么都不做：读接口会经 settle 走到这里，不能顺手建东西。
   */
  private async flushInner(): Promise<void> {
    this.clearTimer();
    const pending = this.pending;
    this.pending = null;
    if ((await this.statOf(this.root))?.isDirectory !== true) return;
    await this.regenerateInner();
    if (!(await this.gitReady())) return;
    if (pending === null && !(await this.git.dirty())) return;
    const source: Source = pending?.source ?? { kind: "external" };
    const notes = pending?.notes ?? [];
    const summary =
      notes.length > 1
        ? `${notes[0]} and ${notes.length - 1} more`
        : (notes[0] ?? "");
    await this.git.commitAll(formatSubject(source, summary));
  }

  private async regenerateInner(): Promise<void> {
    const boards: IndexInput["boards"] = [];
    const tree = await this.scanTree();
    for (const name of tree.boards) {
      const loaded = await this.loadBoard(name).catch((err) => {
        if (err instanceof CanvasError && err.code === "format") return null;
        throw err;
      });
      if (loaded === null) continue;
      // 远端引用不查（每次保存都要生成索引，不为它们多跑网络往返）：索引里只写主机与路径；
      // 笔记的引用从笔记表里取，不在这里再读一遍
      const paths = [
        ...new Set(
          fileNodes(loaded.doc)
            .filter((n) => hostOf(n) === "")
            .map((n) => String(n.file))
            .filter((rel) => classify(rel).kind !== "note"),
        ),
      ];
      const files: IndexInput["boards"][number]["files"] = new Map();
      for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
        await Promise.all(
          paths
            .slice(i, i + READ_CONCURRENCY)
            .map(async (rel) => void files.set(rel, await this.indexFile(rel))),
        );
      }
      boards.push({ name, doc: loaded.doc, files });
    }
    const notes = await this.indexNotes(tree.notes);
    const text = renderIndex({ boards, notes, hostLabel: this.hostLabel });
    const cur = await this.readOf(INDEX);
    if (cur !== null && cur.toString("utf8") === text) return;
    await this.writeAtomic(INDEX, text);
  }

  private async indexFile(rel: string): Promise<IndexFile> {
    const st = await this.statOf(this.abs(rel));
    if (st?.isFile !== true) return { exists: false, text: null };
    const known = { exists: true, size: st.size };
    // 只有灵感卡要正文（取标题）；项目文件与资源只要存在与大小
    if (classify(rel).kind !== "card" || st.size > PREVIEW_MAX_BYTES)
      return { ...known, text: null };
    const bytes = await this.readOf(rel);
    if (bytes === null || bytes.includes(0)) return { ...known, text: null };
    return { ...known, text: bytes.toString("utf8") };
  }

  /** 笔记的正文与大小（供索引取标题、扫链接）。 */
  private async indexNotes(
    entries: ReadonlyArray<{ path: string }>,
  ): Promise<IndexNote[]> {
    const out: IndexNote[] = [];
    for (let i = 0; i < entries.length; i += READ_CONCURRENCY) {
      const batch = await Promise.all(
        entries
          .slice(i, i + READ_CONCURRENCY)
          .map(async (e): Promise<IndexNote | null> => {
            const bytes = await this.readOf(e.path);
            if (bytes === null) return null;
            const readable =
              bytes.length <= PREVIEW_MAX_BYTES && !bytes.includes(0);
            return {
              path: e.path,
              size: bytes.length,
              text: readable ? bytes.toString("utf8") : null,
            };
          }),
      );
      for (const n of batch) if (n !== null) out.push(n);
    }
    return out;
  }

  private async infoOf(rel: string): Promise<FileInfo> {
    const card = classify(rel).kind === "card";
    const abs = this.abs(rel);
    return this.describe(this.env, abs, card, await this.statOf(abs));
  }

  /** 别的主机上的引用：主机取不到、连不上都是 unreachable（不是缺失） */
  private async remoteInfo(host: string, abs: string): Promise<FileInfo> {
    const env = this.envOf(host);
    const lost: FileInfo = { exists: false, kind: "ref", unreachable: true };
    if (env === null) return lost;
    let st: Awaited<ReturnType<ExecEnv["stat"]>>;
    try {
      st = await env.stat(abs);
    } catch {
      return lost;
    }
    return this.describe(env, abs, false, st);
  }

  private async describe(
    env: ExecEnv,
    abs: string,
    card: boolean,
    st: Awaited<ReturnType<ExecEnv["stat"]>>,
  ): Promise<FileInfo> {
    const kind = card ? "card" : "ref";
    if (st?.isFile !== true) return { exists: false, kind };
    // 灵感卡给预览；项目文件引用只给存在、大小与时间（时间供前端拼图片 URL）。
    if (!card && !abs.endsWith(".md"))
      return { exists: true, kind, size: st.size, mtimeMs: mtime(st) };
    const preview = await this.previewOf(env, abs, st.size);
    return {
      exists: true,
      kind,
      size: st.size,
      mtimeMs: mtime(st),
      preview,
      ...(preview !== null && Buffer.byteLength(preview) < st.size
        ? { truncated: true }
        : {}),
    };
  }

  private async previewOf(
    env: ExecEnv,
    abs: string,
    size: number,
  ): Promise<string | null> {
    if (size > PREVIEW_MAX_BYTES) return null;
    const bytes = await env.readFile(abs).catch(() => null);
    if (bytes === null || bytes.includes(0)) return null;
    return bytes.toString("utf8").slice(0, PREVIEW_CHARS);
  }

  /** 挪一个文件并把所有画布里指向它的节点改到新路径；目标必须不存在。 */
  private async moveFile(from: string, to: string): Promise<void> {
    if ((await this.statOf(this.abs(from))) === null)
      throw new CanvasError("not_found", `文件不存在：${from}`);
    if ((await this.statOf(this.abs(to))) !== null)
      throw new CanvasError("exists", `目标已存在：${to}`);
    await this.env.mkdirp(this.pm.dirname(this.abs(to)));
    await this.env.rename(this.abs(from), this.abs(to));
    await this.editBoards((doc) => renameFileRefs(doc, from, to));
  }

  /** `[[…]]` 能指向的文件：画布（带 `.canvas`）与笔记，路径相对 `.canvas/`。 */
  private async linkTargets(): Promise<Set<string>> {
    const tree = await this.scanTree();
    return new Set([
      ...tree.boards.map(boardFile),
      ...tree.notes.map((n) => n.path),
    ]);
  }

  /** 挪完之后：每篇笔记里指向被挪走的画布 / 笔记的 `[[…]]` 改到新位置（含挪过去的那篇自己）。known 是挪之前的。 */
  private async rewriteNoteLinks(
    moves: ReadonlyMap<string, string>,
    known: ReadonlySet<string>,
  ): Promise<void> {
    for (const { path } of (await this.scanTree()).notes) {
      const bytes = await this.readOf(path);
      if (
        bytes === null ||
        bytes.length > PREVIEW_MAX_BYTES ||
        bytes.includes(0)
      )
        continue;
      const text = bytes.toString("utf8");
      const next = rewriteForMoves(text, moves, known);
      if (next !== text) await this.writeAtomic(path, next);
    }
  }

  /** 对每块画布的文档做一次修改；change 返回改动的节点数，大于 0 才写回。格式坏的画布跳过。 */
  private async editBoards(change: (doc: CanvasDoc) => number): Promise<void> {
    for (const name of await this.boardNames()) {
      const loaded = await this.loadBoard(name).catch((err) => {
        if (err instanceof CanvasError && err.code === "format") return null;
        throw err;
      });
      if (loaded === null) continue;
      if (change(loaded.doc) > 0)
        await this.writeAtomic(boardFile(name), serializeCanvas(loaded.doc));
    }
  }

  private assertIsText(rel: string): void {
    if (!insideCanvas(rel))
      throw new CanvasError("invalid_path", `路径不在 .canvas/ 内：${rel}`);
    const kind = classify(rel).kind;
    if (kind !== "card" && kind !== "note")
      throw new CanvasError("invalid_path", `不是灵感卡或笔记路径：${rel}`);
  }

  private assertFolder(rel: string): void {
    if (!insideCanvas(rel) || !isFolderPath(rel))
      throw new CanvasError("invalid_path", `不是合法的文件夹路径：${rel}`);
  }

  private assertIsNote(rel: string): void {
    if (!insideCanvas(rel))
      throw new CanvasError("invalid_path", `路径不在 .canvas/ 内：${rel}`);
    if (classify(rel).kind !== "note")
      throw new CanvasError("invalid_path", `不是笔记路径：${rel}`);
  }

  private assertIsCard(rel: string): void {
    if (!insideCanvas(rel))
      throw new CanvasError("invalid_path", `路径不在 .canvas/ 内：${rel}`);
    this.boardOfCard(rel);
  }

  private boardOfAsset(rel: string): string {
    const c = classify(rel);
    if (!insideCanvas(rel) || c.kind !== "asset" || c.board === undefined)
      throw new CanvasError("invalid_path", `不是资源路径：${rel}`);
    return c.board;
  }

  private boardOfCard(rel: string): string {
    const c = classify(rel);
    if (c.kind !== "card" || c.board === undefined)
      throw new CanvasError("invalid_path", `不是灵感卡路径：${rel}`);
    return c.board;
  }

  private checkExpect(
    cur: Baseline,
    expect?: { mtimeMs?: number; sha256?: string },
  ): void {
    if (expect === undefined) return;
    const stale =
      (expect.sha256 !== undefined && expect.sha256 !== cur.sha256) ||
      (expect.mtimeMs !== undefined && expect.mtimeMs !== cur.mtimeMs);
    if (stale) throw new CanvasConflict(cur);
  }

  private async mustHaveGit(): Promise<void> {
    if (!(await this.gitReady()))
      throw new CanvasError(
        "git_missing",
        "这个画布文件夹还没有 git 仓库，没有历史可用",
      );
  }

  /** sha 是拼进命令的字符串（注入边界），格式不对在这里就拦下。 */
  private async showOrThrow(sha: string, rel: string): Promise<string | null> {
    if (!SHA_RE.test(sha))
      throw new CanvasError("invalid", `非法的提交 sha：${sha}`);
    try {
      return await this.git.show(sha, rel);
    } catch (err) {
      throw new CanvasError(
        "invalid_path",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async gitReady(): Promise<boolean> {
    // `.canvas/` 还不存在时不去问 git：命令的工作目录不存在，结果会被缓存成「不可用」。
    if ((await this.statOf(this.root))?.isDirectory !== true) return false;
    if (!(await this.git.available())) return false;
    return (await this.statOf(this.pm.join(this.root, ".git"))) !== null;
  }

  private async loadBoard(
    name: string,
  ): Promise<{ doc: CanvasDoc; baseline: Baseline }> {
    const rel = boardFile(name);
    const bytes = await this.readOf(rel);
    if (bytes === null)
      throw new CanvasError("not_found", `画布不存在：${name}`);
    let doc: CanvasDoc;
    try {
      doc = parseCanvas(bytes.toString("utf8"));
    } catch (err) {
      if (err instanceof CanvasFormatError)
        throw new CanvasError("format", err.message, { path: rel });
      throw err;
    }
    return { doc, baseline: await this.requireBaseline(rel, bytes) };
  }

  private async boardNames(): Promise<string[]> {
    return (await this.scanTree()).boards;
  }

  /**
   * 递归扫 `.canvas/`：画布名（相对路径、无后缀）与笔记（树里的 `.md`）。
   * 点开头的目录、卡片 / 资源文件夹不进；根上的 index.md 是生成物，不算笔记。
   */
  private async scanTree(): Promise<{
    boards: string[];
    notes: Array<{ path: string }>;
    folders: string[];
  }> {
    const boards: string[] = [];
    const folders: string[] = [];
    const notes: Array<{ path: string }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Awaited<ReturnType<ExecEnv["readdir"]>>;
      try {
        entries = await this.env.readdir(
          dir === "" ? this.root : this.abs(dir),
        );
      } catch {
        return;
      }
      const subs: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory) {
          if (!/\.(cards|assets)$/.test(e.name)) {
            subs.push(`${dir}${e.name}/`);
            folders.push(dir + e.name);
          }
        } else if (e.name.endsWith(".canvas")) {
          boards.push(dir + e.name.slice(0, -".canvas".length));
        } else if (e.name.endsWith(".md") && dir + e.name !== INDEX) {
          notes.push({ path: dir + e.name });
        }
      }
      await Promise.all(subs.map(walk));
    };
    await walk("");
    const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    boards.sort(byPath);
    folders.sort(byPath);
    notes.sort((a, b) => byPath(a.path, b.path));
    return { boards, notes, folders };
  }

  private async cardNames(board: string): Promise<Set<string>> {
    try {
      return new Set(
        (await this.env.readdir(this.abs(cardsDir(board))))
          .filter((e) => !e.isDirectory && e.name.endsWith(".md"))
          .map((e) => e.name.slice(0, -".md".length)),
      );
    } catch {
      return new Set();
    }
  }

  /** 画布名是路径；以斜杠结尾（或清洗后是空）表示没给名字：在那个文件夹里用当前时间命名。 */
  private async uniqueBoardName(raw: string): Promise<string> {
    const clean = sanitizePath(raw);
    const named = /\/\s*$/.test(raw) || clean === "";
    const base = named
      ? `${clean === "" ? "" : `${clean}/`}${timeName(new Date())}`
      : clean;
    return uniqueName(new Set(await this.boardNames()), base);
  }

  private abs(rel: string): string {
    return this.pm.resolve(this.root, rel);
  }

  private async statOf(p: string) {
    try {
      return await this.env.stat(p);
    } catch {
      return null;
    }
  }

  private async readOf(rel: string): Promise<Buffer | null> {
    try {
      return await this.env.readFile(this.abs(rel));
    } catch {
      return null;
    }
  }

  private async requireBaseline(
    rel: string,
    known?: Buffer,
  ): Promise<Baseline> {
    const b = await this.baselineOf(rel, known);
    if (b === null) throw new CanvasError("not_found", `文件不存在：${rel}`);
    return b;
  }

  /** 磁盘上的当前基线；给了 bytes 就不再读一遍。文件不存在返回 null。 */
  private async baselineOf(
    rel: string,
    known?: Buffer,
  ): Promise<Baseline | null> {
    const bytes = known ?? (await this.readOf(rel));
    if (bytes === null) return null;
    const st = await this.statOf(this.abs(rel));
    return {
      mtimeMs: st ? mtime(st) : 0,
      sha256: SHA256(bytes),
    };
  }

  /** 同目录临时文件 + rename：写到一半失败不留残缺文件。 */
  /** dirReady：调用方刚确认过目录在（一批写同一个目录时不必每张都 mkdirp，远端上那是好几次往返） */
  private async writeAtomic(
    rel: string,
    text: string,
    dirReady = false,
  ): Promise<void> {
    const target = this.abs(rel);
    const dir = this.pm.dirname(target);
    if (!dirReady) await this.env.mkdirp(dir);
    const tmp = this.pm.join(
      dir,
      `.${this.pm.basename(target)}.${Math.random().toString(16).slice(2, 10)}.part`,
    );
    await this.env.writeFile(tmp, text);
    await this.env.rename(tmp, target);
  }
}
