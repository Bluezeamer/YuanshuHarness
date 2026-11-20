// 画布标签的 store：画布是一份文档。拖动 / 缩放 / 连线、卡片正文、新卡片（可以是空的、可以有很多张）都先攒在这里，
// 点「保存」（或 Ctrl+S）时一个请求全部写出去；删卡、改名、放文件这类「动作」不进攒着的改动，立即生效。
// 没保存的改动只在页面内存里（Server 不持有），同时同步镜像到浏览器本地存储（mirror.ts），刷新后能恢复。
// store 活在组件外面（useCanvasStore）：切到别的标签再回来，攒着的改动还在。
// 会改状态的异步操作（保存、刷新、放文件、改名、删除）排成一队，一个做完再做下一个，免得互相踩基线。
import {
  type BoardData,
  type BoardList,
  type CanvasDocJson,
  type CanvasEdgeJson,
  type CanvasNodeJson,
  deleteAsset,
  deleteCard,
  type FileInfo,
  listBoards,
  readBoard,
  readCard,
  renameCard,
  type SaveBatchBody,
  type SaveBatchData,
  saveBatch,
  saveBoard,
  saveCard,
  uploadAsset,
} from "../../../../api/canvas";
import { loadToken } from "../../../../api/http";
import {
  clearUnsaved,
  readUnsaved,
  type Unsaved,
  type UnsavedCard,
  writeUnsaved,
} from "./mirror";
import {
  DRAFT_SIZE,
  hostOfNode,
  isAssetPath,
  isNewFile,
  mergeDocs,
  newFile,
  newId,
  pastedName,
  previewInfo,
  type RefKind,
  refKindOf,
  sameDoc,
  sizeForRatio,
} from "./model";

export interface CanvasState {
  phase: "loading" | "ready" | "error";
  /** 树里显示的清单：服务端那份加上还没确认的预演（乐观更新） */
  list: BoardList | null;
  /** 服务端确认过的清单（不含预演）：历史的清理、删除后的落点这类要「真的存在」的判断用它 */
  confirmed: BoardList | null;
  /** 当前打开的画布；null = 这个目录还没有画布 */
  board: string | null;
  /** 画布文档，含用户这边没保存的改动；新卡片是其中 file 为占位名的节点 */
  doc: CanvasDocJson | null;
  files: Record<string, FileInfo>;
  /** 图片设置的指纹：带进图片地址，改了设置浏览器缓存里的旧缩略图才会作废 */
  mediaRev: string;
  /** 文档（位置、大小、连线、新卡片、放上来的引用）和服务端那一版不一样 */
  layoutDirty: boolean;
  /** 保存的进度：saving 时按钮转圈；error 要用户点重试 */
  save: "idle" | "saving" | "error";
  /** 改过还没保存的卡片正文：路径（新卡片是占位名）→ 正文 */
  edits: Record<string, string>;
  /** 正在上传的文件数（粘贴 / 拖进来的）；上传不算「没保存的改动」，传完节点已经在画布文件里了 */
  uploading: number;
  /** 文档被外部版本整体替换（载入、合并、新卡片换成真文件）就加一：画布据此重新铺节点；自己的拖动不加 */
  epoch: number;
  /** 这一次重铺之后要选中的节点（粘贴进来的）；下一次重铺自动清空 */
  pick: string[];
}

export interface UploadReport {
  placed: number;
  /** 没传成的文件与原因，直接给用户看 */
  failed: Array<{ name: string; reason: string }>;
}

/** 有没有没保存的东西：文档（含新卡片）或改过的卡片正文 */
export const isDirty = (s: CanvasState): boolean =>
  s.layoutDirty || Object.keys(s.edits).length > 0;

export type Done<T = void> =
  | { ok: true; data: T }
  | { ok: false; message: string };

export type SaveResult =
  | { kind: "error"; message: string }
  | {
      kind: "done";
      /** 有东西写出去了 */
      wrote: boolean;
      /** 新卡片的占位名 → 建出来的路径：界面据此把正在编辑的新卡片接到真文件上 */
      created: Record<string, string>;
      /** 磁盘上被别处改过、没有写入的卡片，要用户逐张选 */
      conflicts: string[];
    };

export interface StoreDeps {
  env: string;
  dir: string;
  token?: () => string | null;
}

const MERGE_TRIES = 3;
// 一次放进来好几个文件时，彼此错开一点
const UPLOAD_STAGGER = 32;
// 新放上画布的项目文件引用的初始尺寸；图片放下后会按图片比例再调高度
const REF_SIZE: Record<RefKind, { w: number; h: number }> = {
  image: { w: 320, h: 240 },
  video: { w: 480, h: 270 },
  audio: { w: 320, h: 96 },
  markdown: { w: 320, h: 200 },
  file: { w: 240, h: 96 },
};

const FAIL_TEXT: Record<string, string> = {
  network: "网络不通，请稍后再试",
  not_found: "找不到，可能已被改名或删除",
  conflict: "已存在同名项，换个名字",
  bad_request: "名字或位置不合法",
  server: "服务端出错，请重试",
};
export const failText = (kind: string) =>
  FAIL_TEXT[kind] ?? FAIL_TEXT.server ?? "";

const omit = <T>(o: Record<string, T>, key: string): Record<string, T> => {
  const out = { ...o };
  delete out[key];
  return out;
};

const CLEAN: Pick<CanvasState, "layoutDirty" | "edits"> = {
  layoutDirty: false,
  edits: {},
};

/**
 * 新放进来的文件的节点大小：图片先读出它的宽高比再定高度（放上去就是对的，不用载入后再校正、
 * 画布也不会刚放上去就变成「未保存」）；读不出来（svg、没有解码能力）就用默认大小，载入后再校正。
 */
async function nodeSizeOf(
  file: File,
  kind: RefKind,
): Promise<{ w: number; h: number }> {
  const base = REF_SIZE[kind];
  if (kind !== "image" || typeof createImageBitmap !== "function") return base;
  try {
    const bmp = await createImageBitmap(file);
    const ratio = bmp.width / bmp.height;
    bmp.close();
    return Number.isFinite(ratio) && ratio > 0
      ? sizeForRatio(base.w, ratio)
      : base;
  } catch {
    return base;
  }
}

export function createCanvasStore(deps: StoreDeps) {
  const { env, dir } = deps;
  const token = deps.token ?? loadToken;

  let state: CanvasState = {
    phase: "loading",
    list: null,
    confirmed: null,
    board: null,
    doc: null,
    files: {},
    mediaRev: "",
    ...CLEAN,
    save: "idle",
    uploading: 0,
    epoch: 0,
    pick: [],
  };
  const subs = new Set<() => void>();
  const set = (patch: Partial<CanvasState>) => {
    // pick 只管紧跟着的那一次重铺
    state = {
      ...state,
      ...("epoch" in patch && !("pick" in patch) ? { pick: [] } : {}),
      ...patch,
    };
    if ("doc" in patch || "edits" in patch || "layoutDirty" in patch) mirror();
    for (const f of [...subs]) f();
  };

  /** 服务端已知的那一版文档：三方合并的 base，也是保存时的基线 */
  let server: { doc: CanvasDocJson; baseline: BoardData["baseline"] } | null =
    null;
  /** 开过编辑的卡片在服务端的那一版（正文与基线）：改过的正文要拿它判断「有没有改回原样」、保存时拿它判冲突 */
  const known = new Map<string, UnsavedCard>();

  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };

  const docDirty = (doc: CanvasDocJson): boolean =>
    server !== null && !sameDoc(doc, server.doc);

  /** 没保存的改动同步镜像到本地存储；干净了就删。同步写、没有定时器：关页面前最后一次改动也已经落下 */
  const mirror = (): void => {
    const board = state.board;
    if (!board || !server) return;
    if (!isDirty(state)) {
      clearUnsaved(env, dir, board);
      return;
    }
    const cards: Record<string, UnsavedCard> = {};
    for (const f of Object.keys(state.edits)) {
      const k = known.get(f);
      if (k) cards[f] = k;
    }
    writeUnsaved(env, dir, board, {
      base: server.doc,
      baseSha: server.baseline.sha256,
      doc: state.layoutDirty ? state.doc : null,
      edits: state.edits,
      known: cards,
    });
  };

  const adopt = (b: BoardData) => {
    server = { doc: b.canvas, baseline: b.baseline };
    known.clear();
    set({
      board: b.name,
      doc: b.canvas,
      files: b.files,
      mediaRev: b.mediaRev,
      ...CLEAN,
      save: "idle",
      epoch: state.epoch + 1,
    });
  };

  /** 把上次没保存的改动盖回刚载入的版本上；磁盘上的版本变过就以它为底合并。返回有没有恢复出东西 */
  const restore = (b: BoardData, saved: Unsaved): boolean => {
    const mine = saved.doc;
    const doc =
      mine === null
        ? b.canvas
        : saved.baseSha === b.baseline.sha256
          ? mine
          : mergeDocs(saved.base, mine, b.canvas);
    const alive = new Set(doc.nodes.map((n) => n.file));
    const edits = Object.fromEntries(
      Object.entries(saved.edits).filter(([f]) => alive.has(f)),
    );
    const layoutDirty = !sameDoc(doc, b.canvas);
    if (!layoutDirty && Object.keys(edits).length === 0) return false;
    for (const [f, k] of Object.entries(saved.known))
      if (f in edits) known.set(f, k);
    set({ doc, edits, layoutDirty, epoch: state.epoch + 1 });
    return true;
  };

  /**
   * 载入整块画布，攒着的改动作废（调用前由界面确认过）；离开的那块画布的本地镜像一并删掉。
   * 有这块画布上次没保存的镜像就恢复（keepLocal = false 时不读它，载入后状态干净，镜像随之被删）。data 是有没有恢复出东西。
   */
  const load = async (
    name: string,
    keepLocal = true,
  ): Promise<Done<boolean>> => {
    const r = await readBoard(token(), env, dir, name);
    if (!r.ok) return { ok: false, message: failText(r.kind) };
    const leaving = state.board;
    if (leaving && leaving !== name) clearUnsaved(env, dir, leaving);
    const saved = keepLocal ? readUnsaved(env, dir, name) : null;
    adopt(r.data);
    return { ok: true, data: saved ? restore(r.data, saved) : false };
  };

  // 乐观更新：树里的操作先在界面上预演（每个预演是对清单的纯函数），服务端确认或失败后撤掉；
  // state.list 始终是「服务端那份清单 + 还没确认的预演」，后台刷新不会把预演冲掉
  const previews = new Map<number, (l: BoardList) => BoardList>();
  let previewSeq = 0;
  let serverList: BoardList | null = null;
  const shownList = (): BoardList | null =>
    serverList === null
      ? null
      : [...previews.values()].reduce((l, f) => f(l), serverList);
  const loadList = async (): Promise<BoardList | null> => {
    const r = await listBoards(token(), env, dir);
    if (!r.ok) return null;
    serverList = r.data;
    set({ list: shownList(), confirmed: r.data });
    // 返回服务端确认过的清单：调用方（刷新、初始化、删除后的落点）判断的是「真的存在什么」，不能看在途的预演
    return r.data;
  };

  /**
   * 磁盘上的版本（agent 或别处改了）并进来：以它为底，把用户相对上次已知版本改的文档盖上去；
   * 卡片被删了，它没保存的正文一并作废。
   */
  const merge = (theirs: BoardData) => {
    if (theirs.name !== state.board) return;
    const mine = state.doc;
    const base = server;
    const dirty = state.layoutDirty && mine !== null && base !== null;
    const doc =
      dirty && mine && base
        ? mergeDocs(base.doc, mine, theirs.canvas)
        : theirs.canvas;
    const alive = new Set(doc.nodes.map((n) => n.file));
    const kept = Object.entries(state.edits).filter(([f]) => alive.has(f));
    server = { doc: theirs.canvas, baseline: theirs.baseline };
    set({
      doc,
      files: theirs.files,
      mediaRev: theirs.mediaRev,
      layoutDirty: dirty && !sameDoc(doc, theirs.canvas),
      ...(kept.length === Object.keys(state.edits).length
        ? {}
        : { edits: Object.fromEntries(kept) }),
      epoch: state.epoch + 1,
    });
  };

  const reconcile = async (): Promise<Done> => {
    const board = state.board;
    if (!board) return { ok: false, message: "没有打开的画布" };
    const r = await readBoard(token(), env, dir, board);
    if (!r.ok) return { ok: false, message: failText(r.kind) };
    merge(r.data);
    return { ok: true, data: undefined };
  };

  /** 保存请求的内容：文档（改过或有新卡片才带）、改过的已有卡片（带各自的基线）、新卡片（正文可以是空） */
  const batchBody = (
    board: string,
    doc: CanvasDocJson,
    edits: Record<string, string>,
  ): SaveBatchBody => {
    const created = doc.nodes
      .filter((n) => typeof n.file === "string" && isNewFile(n.file))
      .map((n) => ({ nodeId: n.id, text: edits[n.file as string] ?? "" }));
    const withDoc = state.layoutDirty || created.length > 0;
    return {
      board,
      ...(withDoc && server ? { doc, expect: server.baseline } : {}),
      edits: Object.entries(edits)
        .filter(([f]) => !isNewFile(f))
        .map(([path, text]) => ({
          path,
          text,
          expect: known.get(path)?.base ?? { mtimeMs: null, sha256: null },
        })),
      created,
    };
  };

  /** 服务端写好了：本地不再回读，用写进去的内容与返回的基线直接更新状态 */
  const applySaved = (
    sent: { doc: CanvasDocJson; edits: Record<string, string> },
    data: SaveBatchData,
  ): SaveResult => {
    const paths = new Map(data.created.map((c) => [c.nodeId, c.path]));
    const remap = (doc: CanvasDocJson): CanvasDocJson =>
      paths.size === 0
        ? doc
        : {
            ...doc,
            nodes: doc.nodes.map((n) => {
              const p = paths.get(n.id);
              return p === undefined ? n : { ...n, file: p };
            }),
          };
    if (server && data.baseline)
      server = { doc: remap(sent.doc), baseline: data.baseline };
    const doc = state.doc ? remap(state.doc) : null;

    let files = state.files;
    let edits = state.edits;
    const created: Record<string, string> = {};
    const settle = (
      file: string,
      sentText: string,
      base: UnsavedCard["base"],
    ) => {
      known.set(file, { text: sentText, base });
      files = { ...files, [file]: previewInfo(sentText, files[file]) };
    };
    for (const e of data.edits) {
      const text = sent.edits[e.path] ?? "";
      settle(e.path, text, e.baseline);
      if (edits[e.path] === text) edits = omit(edits, e.path);
    }
    for (const c of data.created) {
      const ph = newFile(c.nodeId);
      created[ph] = c.path;
      const text = sent.edits[ph] ?? "";
      settle(c.path, text, c.baseline);
      // 保存期间又在新卡片里改了字：这部分仍是没保存的，挪到真路径下
      const now = edits[ph];
      edits = omit(edits, ph);
      if (now !== undefined && now !== text)
        edits = { ...edits, [c.path]: now };
    }
    set({
      doc,
      files,
      edits,
      layoutDirty: doc !== null && docDirty(doc),
      save: "idle",
      ...(data.created.length > 0 ? { epoch: state.epoch + 1 } : {}),
    });
    return {
      kind: "done",
      wrote: data.baseline !== null || data.edits.length > 0,
      created,
      conflicts: data.conflicts,
    };
  };

  const writeAll = async (): Promise<SaveResult> => {
    const board = state.board;
    if (!board || !state.doc || !server)
      return { kind: "error", message: "没有打开的画布" };
    if (!isDirty(state))
      return { kind: "done", wrote: false, created: {}, conflicts: [] };
    set({ save: "saving" });
    const fail = (message: string): SaveResult => {
      set({ save: "error" });
      return { kind: "error", message };
    };
    for (let i = 0; i < MERGE_TRIES; i++) {
      const sent = { doc: state.doc as CanvasDocJson, edits: state.edits };
      const r = await saveBatch(
        token(),
        env,
        dir,
        batchBody(board, sent.doc, sent.edits),
      );
      if (r.ok) return applySaved(sent, r.data);
      if (!("conflict" in r)) return fail(failText(r.kind));
      // 磁盘上的画布变了（agent 加了卡片等）：以它为底合并，再发一次
      const theirs = await readBoard(token(), env, dir, board);
      if (!theirs.ok) return fail(failText(theirs.kind));
      merge(theirs.data);
    }
    return fail("画布没有保存成功");
  };

  /** 磁盘上有变化（agent 或别处改了，或自己刚存完）：没有变化只换卡片预览，有变化就并进来，攒着的改动保住 */
  const refreshNow = async (): Promise<void> => {
    const list = await loadList();
    const board = state.board;
    if (!list || !board) return;
    if (!list.boards.some((b) => b.name === board)) {
      // 当前画布没了（被改名或删除）：换到第一块
      const next = list.boards[0]?.name;
      if (next) await load(next);
      else {
        clearUnsaved(env, dir, board);
        server = null;
        known.clear();
        set({
          board: null,
          doc: null,
          files: {},
          ...CLEAN,
          epoch: state.epoch + 1,
        });
      }
      return;
    }
    const r = await readBoard(token(), env, dir, board);
    if (!r.ok) return;
    if (server?.baseline.sha256 === r.data.baseline.sha256) {
      set({ files: r.data.files, mediaRev: r.data.mediaRev });
      return;
    }
    merge(r.data);
  };
  const refresh = (): Promise<void> => serial(refreshNow);

  /** 文档改动（位置、大小、连线、新卡片）：本地先生效，等保存。画布自己的拖动不用重铺；从外面往文档里加东西（replot）才要 */
  const commit = (
    doc: CanvasDocJson,
    replot = false,
    pick: string[] = [],
  ): void => {
    const files = new Set(doc.nodes.map((n) => n.file));
    const kept = Object.entries(state.edits).filter(([f]) => files.has(f));
    set({
      doc,
      layoutDirty: docDirty(doc),
      // 画布上删掉的卡片（含从没存过的新卡片）攒着的正文一起作废
      ...(kept.length === Object.keys(state.edits).length
        ? {}
        : { edits: Object.fromEntries(kept) }),
      ...(replot ? { epoch: state.epoch + 1, pick } : {}),
    });
  };

  return {
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    getSnapshot: (): CanvasState => state,

    /** 首次载入：打开想要的画布，没有就第一块；一块都没有停在空态。返回有没有恢复出上次没保存的改动 */
    async init(want: string | null): Promise<boolean> {
      const list = await loadList();
      if (!list) {
        set({ phase: "error" });
        return false;
      }
      const names = list.boards.map((b) => b.name);
      const pick = want && names.includes(want) ? want : names[0];
      if (!pick) {
        set({ phase: "ready", board: null, doc: null });
        return false;
      }
      const r = await load(pick);
      set({ phase: r.ok ? "ready" : "error" });
      return r.ok && r.data;
    },

    open: (name: string) => load(name),

    /** 磁盘上有变化（agent 或别处改了，或自己刚存完）：没有变化只换卡片预览，有变化就并进来，攒着的改动保住 */
    refresh,

    /**
     * 树里挪了 / 删了东西之后：to 是打开的画布挪到的新名字，跟过去（调用前界面确认过它没有未保存的改动）；
     * null 就只重取清单与当前画布（它被删了会自己换到第一块）。排在队列里，不和保存、刷新交错。
     */
    follow: (to: string | null): Promise<Done> =>
      serial(async () => {
        if (to === null) {
          await refreshNow();
          return { ok: true, data: undefined };
        }
        await loadList();
        const r = await load(to);
        return r.ok ? { ok: true, data: undefined } : r;
      }),

    /** 只重取清单（树里的操作做完之后：画布本身没动，不必重读）；排在队列里 */
    syncList: (): Promise<void> => serial(async () => void (await loadList())),

    /**
     * 先在界面上预演一个树操作（清单立刻变），返回撤销它的函数：服务端做完调 settled()（换成服务端的清单），
     * 出错调 revert()（预演撤掉、清单回到服务端那份）。预演期间的后台刷新照常，不会把它冲掉。
     */
    preview(apply: (l: BoardList) => BoardList): {
      settled(): Promise<void>;
      revert(): void;
    } {
      const id = ++previewSeq;
      previews.set(id, apply);
      if (serverList !== null) set({ list: shownList() });
      return {
        settled: () =>
          serial(async () => {
            // 服务端已经做完：撤掉预演，换成服务端的清单（其间别的预演还叠在上面）
            previews.delete(id);
            await loadList();
          }),
        revert: () => {
          previews.delete(id);
          if (serverList !== null) set({ list: shownList() });
        },
      };
    },

    commit,

    /** 把攒着的一切一次写出去：文档、改过的卡片、新卡片一个请求；卡片冲突的不覆盖、留着正文，结果里列出来 */
    saveAll: () => serial(writeAll),

    /** 全部放弃：重新读磁盘上的版本，本地镜像一并删掉 */
    async discardAll(): Promise<Done> {
      const board = state.board;
      if (!board) return { ok: false, message: "没有打开的画布" };
      const r = await load(board, false);
      return r.ok ? { ok: true, data: undefined } : r;
    },

    /**
     * 在 at（左上角）处加一张新卡片：只在界面里（文档里的一个节点，file 是占位名），保存时才建文件；
     * 可以是空的，可以同时有很多张。返回节点 id（保存前后不变），界面据此进入编辑。
     */
    addCard(at: { x: number; y: number }): string | null {
      const doc = state.doc;
      if (!doc) return null;
      const id = newId();
      const file = newFile(id);
      commit(
        {
          ...doc,
          nodes: [
            ...doc.nodes,
            {
              id,
              type: "file",
              file,
              x: Math.round(at.x),
              y: Math.round(at.y),
              width: DRAFT_SIZE.w,
              height: DRAFT_SIZE.h,
            },
          ],
        },
        true,
      );
      return id;
    },

    /** 开始编辑一张卡片：有攒着的正文就接着改，新卡片没有正文就是空的，其余读服务端的；读不出来报错，不给空白让人误存 */
    async loadCard(file: string): Promise<Done<string>> {
      const pending = state.edits[file];
      if (isNewFile(file)) return { ok: true, data: pending ?? "" };
      if (pending !== undefined && known.has(file))
        return { ok: true, data: pending };
      const r = await readCard(token(), env, dir, file);
      if (!r.ok) return { ok: false, message: failText(r.kind) };
      known.set(file, {
        text: r.data.text,
        base: { mtimeMs: r.data.mtimeMs, sha256: r.data.sha256 },
      });
      return { ok: true, data: r.data.text };
    },

    /** 编辑器里的正文变了：和服务端那一版不同就攒着，改回原样就不算改动；新卡片没有「原样」，空就不记 */
    setEdit(file: string, text: string): void {
      const original = isNewFile(file) ? "" : known.get(file)?.text;
      if (original === undefined) return;
      if (text === original) {
        if (file in state.edits) set({ edits: omit(state.edits, file) });
      } else if (state.edits[file] !== text)
        set({ edits: { ...state.edits, [file]: text } });
    },

    /** 冲突里选「用磁盘上的」：丢掉自己的改动，认磁盘版本 */
    keepDisk(file: string, disk: UnsavedCard): void {
      known.set(file, disk);
      set({
        edits: omit(state.edits, file),
        files: {
          ...state.files,
          [file]: previewInfo(disk.text, state.files[file]),
        },
      });
    },

    /** 冲突里选「覆盖」或「合并」：用磁盘当前的基线把这份正文写下去 */
    async writeCard(
      file: string,
      text: string,
      base: UnsavedCard["base"],
    ): Promise<Done> {
      const r = await saveCard(token(), env, dir, file, text, base);
      if (!r.ok)
        return {
          ok: false,
          message:
            "conflict" in r ? "刚刚又被改过，请再试一次" : failText(r.kind),
        };
      known.set(file, { text, base: r.data });
      set({
        edits:
          state.edits[file] === text ? omit(state.edits, file) : state.edits,
        files: { ...state.files, [file]: previewInfo(text, state.files[file]) },
      });
      return { ok: true, data: undefined };
    },

    renameCard: (path: string, name: string): Promise<Done<string>> =>
      serial(async () => {
        const r = await renameCard(token(), env, dir, path, name);
        if (!r.ok) return { ok: false, message: failText(r.kind) };
        const to = r.data.path;
        // 攒着的正文跟着卡片走
        const k = known.get(path);
        if (k) {
          known.delete(path);
          known.set(to, k);
        }
        const text = state.edits[path];
        if (text !== undefined)
          set({ edits: { ...omit(state.edits, path), [to]: text } });
        const o = await reconcile();
        return o.ok ? { ok: true, data: to } : o;
      }),

    /**
     * 删除画布自己的文件：已存在的灵感卡与粘贴进来的资源，文件与节点一起删，攒着的正文作废，其余改动保住
     * （没存过的新卡片在画布上直接删，不走这里）。
     */
    deleteCards: (paths: readonly string[]): Promise<Done> =>
      serial(async () => {
        for (const p of paths) {
          const r = isAssetPath(p)
            ? await deleteAsset(token(), env, dir, p)
            : await deleteCard(token(), env, dir, p);
          if (!r.ok) return { ok: false, message: failText(r.kind) };
          known.delete(p);
        }
        return reconcile();
      }),

    /**
     * 粘贴 / 拖进来的文件：一个一个传到这块画布的资源文件夹里，服务端传完就把节点放进画布文档，
     * 全部传完再并回来。at 是第一个文件的中心（画布坐标），后面的依次错开。
     * 上传不进串行队列（可能很久），期间照常编辑、保存。
     */
    async uploadAssets(
      files: readonly File[],
      at: { x: number; y: number },
    ): Promise<UploadReport> {
      const board = state.board;
      const report: UploadReport = { placed: 0, failed: [] };
      if (!board) return report;
      set({ uploading: state.uploading + files.length });
      const now = new Date();
      for (const [i, f] of files.entries()) {
        const name = pastedName(f, now);
        const size = await nodeSizeOf(f, refKindOf(name));
        const r = await uploadAsset(token(), env, dir, board, f, {
          name,
          at: {
            x: at.x - size.w / 2 + i * UPLOAD_STAGGER,
            y: at.y - size.h / 2 + i * UPLOAD_STAGGER,
          },
          size,
        });
        set({ uploading: state.uploading - 1 });
        if (r.ok) report.placed += 1;
        else
          report.failed.push({
            name,
            reason:
              r.kind === "too_large"
                ? r.max === undefined
                  ? "文件太大"
                  : `超过 ${Math.round(r.max / 1024 / 1024)} MB 的上限（设置里可以调）`
                : failText(r.kind),
          });
      }
      if (report.placed > 0) await refresh();
      return report;
    },

    /**
     * 往文档里加一批现成的节点与连线（粘贴复制来的卡片、网页链接）：只在界面里，和别的布局改动一样等保存。
     * edits 是其中新卡片的占位名 → 正文；select 为真时加进来的节点会被选中。
     */
    addNodes(
      nodes: readonly CanvasNodeJson[],
      edges: readonly CanvasEdgeJson[] = [],
      edits: Readonly<Record<string, string>> = {},
      select = false,
    ): void {
      const doc = state.doc;
      if (!doc || nodes.length === 0) return;
      commit(
        {
          ...doc,
          nodes: [...doc.nodes, ...nodes],
          edges: [...doc.edges, ...edges],
        },
        true,
        select ? nodes.map((n) => n.id) : [],
      );
      if (Object.keys(edits).length > 0)
        set({ edits: { ...state.edits, ...edits } });
    },

    /**
     * 把目录里的项目文件放上画布成一个引用节点，返回节点 id；已经在画布上就不重复放，返回 null。
     * 本地立刻放上去，同时单独把这一个节点写进磁盘版本（画布上其余没保存的改动不动），
     * 这样服务端读得到这个文件，预览信息马上取回来。
     */
    addRef(
      file: string,
      at: { x: number; y: number },
      /** 别的主机（或目录之外）的文件：那台主机的环境 id，file 是它上面的绝对路径 */
      host?: string,
    ): string | null {
      const doc = state.doc;
      if (!doc) return null;
      if (
        doc.nodes.some((n) => n.file === file && hostOfNode(n) === (host ?? ""))
      )
        return null;
      const id = newId();
      const size = REF_SIZE[refKindOf(file)];
      const node: CanvasNodeJson = {
        id,
        type: "file",
        file,
        ...(host ? { host } : {}),
        x: Math.round(at.x),
        y: Math.round(at.y),
        width: size.w,
        height: size.h,
      };
      commit({ ...doc, nodes: [...doc.nodes, node] }, true);
      void serial(async () => {
        const board = state.board;
        const base = server;
        if (!board || !base || base.doc.nodes.some((n) => n.id === id)) return;
        const next = { ...base.doc, nodes: [...base.doc.nodes, node] };
        const w = await saveBoard(
          token(),
          env,
          dir,
          board,
          next,
          base.baseline,
        );
        // 冲突或失败：节点留在本地，等下一次保存与刷新
        if (!w.ok) return;
        server = { doc: next, baseline: w.data.baseline };
        await reconcile();
      });
      return id;
    },
  };
}

export type CanvasStore = ReturnType<typeof createCanvasStore>;
