// 灵感画布标签：绑定（主机 + 目录）。左边是画布与笔记的树，主区显示一块画布或一篇笔记（有返回 / 前进的历史）；
// 卡片在画布里原地编辑，笔记在主区里编辑。新建、改名、挪动、删除都从树里发起。
// 画布是目录里 `.canvas/` 下的文件，agent 与用户都改它。保存是画布级的：拖动、缩放、连线、卡片正文都先攒着，
// 点工具条的「保存」或按 Ctrl+S 一次写出去；建卡、删卡、改名、放文件这类动作立即生效。
import { type Edge, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { readCard } from "../../../../api/canvas";
import { loadToken } from "../../../../api/http";
import { environmentIdOf, hostIdOf } from "../../../../app/shell/hosts";
import {
  Button,
  ConfirmDialog,
  Empty,
  FormDialog,
  InlineNotice,
  Input,
  Loading,
  leafOf,
  parentOf,
  SplitHandle,
  type TreeNode,
  toast,
} from "../../../../ui";
import { useFsWatch } from "../../../chat";
import { useHostName, useHosts, useLayoutStore } from "../../layoutContext";
import { joinPath } from "../files/paths";
import { BarSlotsProvider } from "../preview/BarSlots";
import { ConflictDialog } from "../preview/ConflictDialog";
import type { TabRenderProps } from "../registry";
import { useAddToChat } from "../useAddToChat";
import { CanvasFlow, selectAll } from "./CanvasFlow";
import { CanvasRail } from "./CanvasRail";
import { CanvasTree } from "./CanvasTree";
import {
  absOfRef,
  cardTitle,
  DRAFT_SIZE,
  type FlowNode,
  freeSpot,
  isAssetPath,
  isLargeAsset,
  isNotePath,
  refTitle,
} from "./model";
import { NewItemDialog, type NewKind } from "./NewItemDialog";
import { NoteView } from "./NoteView";
import {
  back,
  canBack,
  canForward,
  currentOf,
  forward,
  loadNav,
  mapViews,
  type Nav,
  pushView,
  sameView,
  saveNav,
  startNav,
  type View,
} from "./nav";
import {
  boardId,
  countWithin,
  isWithin,
  type MoveOp,
  movedId,
  newFolderOf,
  newNotePathFor,
  nodesOf,
  opsForMoves,
  previewMoves,
  previewRemove,
  refOf,
  renameTarget,
  resolveTarget,
} from "./navTree";
import { canvasFileLabel, wholeLines } from "./quote";
import { syncBadge, useRemoteSync } from "./remoteSync";
import { isDirty } from "./store";
import { CanvasBar } from "./Toolbar";
import { treeOps } from "./treeOps";
import {
  clampWidth,
  mustFloat,
  readPrefs,
  TREE_DEFAULT,
  TREE_MAX,
  TREE_MIN,
  type TreePrefs,
  writePrefs,
} from "./treePrefs";
import { useCanvasStore } from "./useCanvasStore";
import { inEditable, useCanvasClipboard } from "./useClipboard";
import { useFloatPanel } from "./useFloatPanel";
import { useTreeView } from "./useTreeView";
import { VersionsPanel } from "./VersionsPanel";

interface Conflict {
  file: string;
  disk: {
    text: string;
    base: { mtimeMs: number | null; sha256: string | null };
  };
  mine: string;
  rest: string[];
}

type Dialog =
  | { kind: "new"; what: NewKind; folder: string; name: string }
  | {
      kind: "deleteNodes";
      /** 要删的树 id（文件夹里的不单列） */
      roots: string[];
      /** 只删一个笔记 / 画布时，有谁引用它 */
      refs: { boards: string[]; notes: string[] } | null;
    }
  | { kind: "renameCard"; file: string }
  | { kind: "deleteCards"; files: string[] }
  | { kind: "discard"; proceed: () => void };

const FIT = { padding: 0.2, maxZoom: 1, duration: 150 };
// 粘贴时给新节点留的位置：按默认节点里最大的（视频）算
const UPLOAD_SLOT = { w: 480, h: 270 };
const snap = (v: number) => Math.round(v / 8) * 8;

const viewTreeId = (v: View): string =>
  v.kind === "board" ? boardId(v.name) : v.path;

export function CanvasTab(props: TabRenderProps) {
  if (!props.tab.path)
    return (
      <div className="cv">
        <Empty
          title="没有选择目录"
          description="画布属于工作区里的一个目录；从「+」新建画布标签时会带上它。"
        />
      </div>
    );
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({
  tab,
  pane,
  sessionId,
  patchTab,
  patchAfx,
}: TabRenderProps) {
  const layout = useLayoutStore();
  const hostName = useHostName();
  const hosts = useHosts();
  const rf = useReactFlow<FlowNode, Edge>();
  const host = tab.host ?? "server";
  const env = environmentIdOf(host);
  const dir = tab.path ?? "";
  const store = useCanvasStore(env, dir, tab.id);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const dirty = isDirty(state);
  const sync = syncBadge(useRemoteSync(env, dir));

  // 主区显示什么：一块画布或一篇笔记，历史在 nav 里；侧栏树可以收起
  // 初始值从标签记录里读（切走再回来、刷新页面都靠它）；读不到就等画布载入后从当前画布开始
  const [nav, setNav] = useState<Nav | null>(() => loadNav(tab.afx?.cv));
  const view = nav === null ? null : currentOf(nav);
  const [noteDirty, setNoteDirty] = useState(false);
  const noteSave = useRef<(() => void) | null>(null);
  // 版本历史面板（看当前画布 / 笔记自己的提交，恢复旧版本、撤销 agent）；恢复后笔记要整个重新载入，靠 noteRev 换 key
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [noteRev, setNoteRev] = useState(0);
  // 树栏：固定（占位、可拖宽）或悬浮（鼠标移到左缘展开、移开收回）。偏好记在浏览器里；
  // 标签窄到放不下「树栏 + 最小主区」时强制悬浮，不改偏好，宽了就回去
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [prefs, setPrefs] = useState(readPrefs);
  const setPref = useCallback((patch: Partial<TreePrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      writePrefs(next);
      return next;
    });
  }, []);
  const [tabWidth, setTabWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setTabWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const forcedFloat = mustFloat(tabWidth, prefs.width);
  const floating = prefs.mode === "float" || forcedFloat;
  const [treeBusy, setTreeBusy] = useState(false);
  const panel = useFloatPanel({
    enabled: floating,
    busy: treeBusy,
    panel: panelRef,
  });
  // 树里选中的行（新建的位置以它为准）；树收起时由标签记着，主区换了东西就作废
  const [treePick, setTreePick] = useState<string | null>(null);
  // 树里展开的文件夹与滚动位置：记在标签里（悬浮树栏收起时树组件会卸载）并存进浏览器，下次打开还原
  const treeView = useTreeView(env, dir);
  const [tail, setTail] = useState<HTMLElement | null>(null);
  const tree = useMemo(() => treeOps(env, dir), [env, dir]);
  const nodes = useMemo(() => nodesOf(state.list), [state.list]);
  const anyDirty = dirty || noteDirty;

  // 首次打开才载入；切走再回来 store 还在（带着没保存的改动），只对一下磁盘上有没有新变化
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换了目录（store 换了）时执行
  useEffect(() => {
    if (store.getSnapshot().phase === "ready") return void store.refresh();
    void store.init(tab.canvas ?? null).then((restored) => {
      if (restored) toast("已恢复上次没保存的改动", { tone: "ok" });
    });
  }, [store]);

  // 有没保存的改动时，刷新或关闭页面前让浏览器问一句
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  // 记住打开的是哪块画布，刷新页面或换窗格后还在
  useEffect(() => {
    if (state.board && state.board !== tab.canvas)
      patchTab({ canvas: state.board });
  }, [state.board, tab.canvas, patchTab]);
  // 记住浏览历史（当前是画布还是笔记、能前进后退到哪）：标签在窗格里切走会卸载，没有它回来就回到第一块画布
  // （和记着的一样就不写：patchAfx 每次渲染都是新函数，写一次标签就重渲染一次，不比较会写个没完）
  const savedCv = tab.afx?.cv;
  useEffect(() => {
    if (!nav) return;
    const next = saveNav(nav);
    if (JSON.stringify(next) !== JSON.stringify(savedCv))
      patchAfx({ cv: next });
  }, [nav, savedCv, patchAfx]);

  // 有限感知刷新：订阅 .canvas/ 根、画布所在的子目录与它的卡片目录，agent 或别处改了就重取
  const root = joinPath(dir, ".canvas");
  const ready = state.list?.ready === true;
  const board = state.board;
  const folders = state.list?.folders;
  const watchPaths = useMemo(
    () =>
      ready
        ? [
            root,
            ...(folders ?? []).map((f) => joinPath(root, f)),
            ...(board ? [joinPath(root, `${board}.cards`)] : []),
          ]
        : [],
    [ready, board, folders, root],
  );
  const rev = useFsWatch(sessionId ?? undefined, env, watchPaths);
  const handled = useRef(rev);
  useEffect(() => {
    if (rev === handled.current) return;
    handled.current = rev;
    void store.refresh();
  }, [rev, store]);

  // 别的主机连上或断开：引用它们的卡片从「主机未连接」恢复（或反过来），重取一次信息
  const hostsKey = hosts.map((h) => h.id).join("\0");
  const seenHosts = useRef(hostsKey);
  useEffect(() => {
    if (seenHosts.current === hostsKey) return;
    seenHosts.current = hostsKey;
    void store.refresh();
  }, [hostsKey, store]);

  // 正在原地编辑的卡片的节点 id（保存前后不变；新卡片存成文件时它的路径会换）
  const [editing, setEditing] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 保存时发现卡片在别处被改过：逐张让用户选
  const [conflict, setConflict] = useState<Conflict | null>(null);

  // 换了画布：编辑态不带过去
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在画布名变了时复位
  useEffect(() => {
    setEditing(null);
  }, [state.board]);

  // 正在编辑的卡片没了（被删、被 agent 删掉）：收起
  useEffect(() => {
    if (editing && state.doc && !state.doc.nodes.some((n) => n.id === editing))
      setEditing(null);
  }, [editing, state.doc]);

  const fileOf = (id: string | null): string | undefined =>
    id === null ? undefined : state.doc?.nodes.find((n) => n.id === id)?.file;

  const open = (d: Dialog, initial = "") => {
    setName(initial);
    setError(null);
    setDialog(d);
  };
  const close = () => {
    setDialog(null);
    setBusy(false);
  };
  // 有没保存的改动时，离开这块画布（切画布、新建、改名）前先确认
  const guard = (proceed: () => void) => {
    if (!isDirty(store.getSnapshot())) return proceed();
    open({ kind: "discard", proceed });
  };
  const exit = () => setEditing(null);
  const edit = (id: string) => setEditing(id);

  // 卡片 / 笔记的正文（含还没保存的改动）连同来源加进对话的输入框
  const addToChat = useAddToChat(sessionId);
  const quoteFile = async (file: string) => {
    const r = await store.loadCard(file);
    if (!r.ok) {
      toast(`读不出 ${cardTitle(file)}：${r.message}`, { tone: "danger" });
      return;
    }
    if (r.data.trim() === "") {
      toast("这里还是空的", { tone: "warn" });
      return;
    }
    addToChat(
      canvasFileLabel(hostName(host), dir, file, wholeLines(r.data)),
      r.data,
    );
  };

  // 恢复旧版本或撤销 agent 之后：主区整个重读（没保存的改动已在面板里确认过要丢）。画布重读磁盘并清掉本地镜像，笔记换 key 重新载入
  const versionsChanged = () => {
    setEditing(null);
    setNoteRev((n) => n + 1);
    void store.discardAll();
    void store.syncList();
  };

  const viewKey = view === null ? "" : `${view.kind}:${viewTreeId(view)}`;
  // 换了画布或笔记：编辑态不带过去，树里选中的行也作废（新建的位置回到按打开的东西算）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在主区的内容变了时复位
  useEffect(() => {
    setEditing(null);
    setTreePick(null);
  }, [viewKey]);

  // ── 主区与历史 ──
  // 刚载入的画布进历史（初始，或历史被清空后）
  useEffect(() => {
    if (state.board)
      setNav(
        (n) => n ?? startNav({ kind: "board", name: state.board as string }),
      );
  }, [state.board]);

  // 服务端清单里已经没有的画布 / 笔记（被删、被 agent 或别处改名）从历史里去掉。
  // 只看服务端确认过的清单：树里的预演（在途的改名、挪动）还没落到服务端，不能据此把当前打开的东西丢掉
  const list = state.confirmed;
  useEffect(() => {
    if (!list?.ready) return;
    const boards = new Set(list.boards.map((b) => b.name));
    const notes = new Set(list.notes);
    setNav((n) => {
      if (n === null) return n;
      const live = mapViews(n, (v) =>
        (v.kind === "board" ? boards.has(v.name) : notes.has(v.path))
          ? v
          : null,
      );
      if (
        live !== null &&
        live.stack.length === n.stack.length &&
        live.at === n.at
      )
        return n;
      return live;
    });
  }, [list]);

  // 主区要的画布不是 store 里这块：读进来（有没保存的改动时，进历史之前已经确认过）
  const opening = useRef<string | null>(null);
  useEffect(() => {
    if (view?.kind !== "board" || state.phase !== "ready") return;
    if (view.name === state.board || opening.current === view.name) return;
    opening.current = view.name;
    void store.open(view.name).then((r) => {
      opening.current = null;
      if (!r.ok) {
        toast(r.message, { tone: "danger" });
        setNav((n) => n && mapViews(n, (v) => (sameView(v, view) ? null : v)));
      } else if (r.data) toast("已恢复上次没保存的改动", { tone: "ok" });
    });
  }, [view, state.board, state.phase, store]);

  // 离开笔记视图前：有没保存的改动就先确认
  const leaveNote = (next: () => void) =>
    noteDirty && view?.kind === "note"
      ? open({ kind: "discard", proceed: next })
      : next();
  // 要换到另一块画布前：当前这块有没保存的改动就先确认
  const guardBoard = (target: View, next: () => void) =>
    target.kind === "board" && target.name !== state.board
      ? guard(next)
      : next();

  const go = (target: View) =>
    leaveNote(() =>
      guardBoard(target, () =>
        setNav((n) => (n ? pushView(n, target) : startNav(target))),
      ),
    );
  const step = (to: Nav) =>
    leaveNote(() => guardBoard(currentOf(to), () => setNav(to)));

  // 窄栏上的树按钮：固定着的树栏点它就是收起（改成悬浮）；悬浮的是手动展开 / 收起
  const toggleTree = () => {
    if (floating) panel.toggle();
    else setPref({ mode: "float" });
  };
  // 固定 ⇄ 悬浮
  const togglePin = () =>
    setPref({ mode: prefs.mode === "fixed" ? "float" : "fixed" });

  // 笔记里点 [[链接]]：指到清单里的就打开，指不到就问要不要建（和 Obsidian 一样）
  const wikiRef = useRef((_target: string) => {});
  wikiRef.current = (target) => {
    const hit = resolveTarget(target, state.list);
    if (hit?.kind === "note") go({ kind: "note", path: hit.path });
    else if (hit?.kind === "board") go({ kind: "board", name: hit.name });
    else {
      const path = newNotePathFor(target);
      open({
        kind: "new",
        what: "note",
        folder: parentOf(path),
        name: leafOf(path),
      });
    }
  };
  const onWikilink = useCallback(
    (target: string) => wikiRef.current(target),
    [],
  );

  // ── 树里的改动（新建、改名、挪动、删除）：服务端连同引用一起改，这里再把历史与打开的画布跟过去 ──
  const blockerOf = (roots: readonly string[]): string | null => {
    if (
      state.board &&
      isDirty(store.getSnapshot()) &&
      isWithin(boardId(state.board), roots)
    )
      return "这块画布有没保存的改动，先保存或还原再操作";
    if (noteDirty && view?.kind === "note" && isWithin(view.path, roots))
      return "这篇笔记有没保存的改动，先保存或还原再操作";
    return null;
  };

  const afterMoves = async (done: readonly MoveOp[]) => {
    const cur = store.getSnapshot().board;
    const toId = cur ? movedId(boardId(cur), done) : null;
    const to = toId ? toId.slice(0, -".canvas".length) : null;
    const followed = cur !== null && to !== null && to !== cur;
    if (followed) opening.current = to;
    setNav(
      (n) =>
        n &&
        mapViews(n, (v) =>
          v.kind === "board"
            ? {
                kind: "board",
                name: movedId(boardId(v.name), done).slice(
                  0,
                  -".canvas".length,
                ),
              }
            : { kind: "note", path: movedId(v.path, done) },
        ),
    );
    // 当前画布没被挪：只需要服务端的清单（树已经预演过了），不必重读画布；被挪了才跟过去重读
    await (followed ? store.follow(to) : store.syncList());
    opening.current = null;
  };

  /** 依次做这些挪动（改名也是挪动）；返回错误提示，成功是 null。做成的先跟过去，出错就停在那里 */
  const runMoves = async (
    moves: Array<{ id: string; to: string }>,
  ): Promise<string | null> => {
    const blocked = blockerOf(moves.map((m) => m.id));
    if (blocked) return blocked;
    const ops = opsForMoves(nodes, moves);
    // 树上立刻按预演变（改名、挪动都不用等服务端），请求在后台做；出错就撤掉预演并报错
    const pv = store.preview((l) => previewMoves(l, ops));
    const finished: MoveOp[] = [];
    let failure: string | null = null;
    for (const op of ops) {
      const r = await tree.move(op);
      if (!r.ok) {
        failure = r.message;
        break;
      }
      finished.push(op);
    }
    if (failure === null) {
      await afterMoves(finished);
      await pv.settled();
      return null;
    }
    // 部分做成：预演撤掉，已经做成的那几个以服务端清单为准
    pv.revert();
    if (finished.length > 0) await afterMoves(finished);
    return failure;
  };
  // 行内改名：本地能判断的错误（空名、撞名、非法字符）当场在输入框里报；通过了就让输入框立刻收起、树按预演变，
  // 服务端的结果在后台等：失败时预演自动撤回并弹提示（不再让输入框一直等着往返）
  const renameNode = async (node: TreeNode, newName: string) => {
    const r = renameTarget(node, newName, new Set(nodes.map((n) => n.id)));
    if ("error" in r) return r.error;
    void runMoves([{ id: node.id, to: r.to }]).then((err) => {
      if (err) toast(err, { tone: "danger" });
    });
    return null;
  };
  const moveNodes = async (moves: Array<{ id: string; to: string }>) => {
    const err = await runMoves(moves);
    if (err) toast(err, { tone: "danger" });
  };

  const requestDelete = async (picked: TreeNode[]) => {
    // 选中了文件夹又选了它里面的东西：只算文件夹
    const roots = picked
      .map((n) => n.id)
      .filter((id) => !picked.some((o) => o.id !== id && isWithin(id, [o.id])));
    const blocked = blockerOf(roots);
    if (blocked) return void toast(blocked, { tone: "warn" });
    const only =
      roots.length === 1 ? picked.find((n) => n.id === roots[0]) : undefined;
    const ref = only ? refOf(only) : null;
    const refs = ref && ref.kind !== "folder" ? await tree.refs(ref) : null;
    open({ kind: "deleteNodes", roots, refs: refs?.ok ? refs.data : null });
  };
  const runDelete = async (
    roots: string[],
  ): Promise<{ ok: boolean; message?: string }> => {
    const deleted: string[] = [];
    let failure: string | undefined;
    const pv = store.preview((l) => previewRemove(l, roots));
    for (const id of roots) {
      const node = nodes.find((n) => n.id === id);
      if (!node) continue;
      const r = await tree.remove(refOf(node));
      if (!r.ok) {
        failure = r.message;
        break;
      }
      deleted.push(id);
    }
    if (failure !== undefined) pv.revert();
    else await pv.settled();
    if (deleted.length > 0) {
      setNav(
        (n) =>
          n &&
          mapViews(n, (v) => (isWithin(viewTreeId(v), deleted) ? null : v)),
      );
      await store.follow(null);
    }
    return failure === undefined
      ? { ok: true }
      : { ok: false, message: failure };
  };

  // 新建：位置默认是 folder（"" 是根），对话框里可以改
  const newIn = (what: NewKind, folder: string) =>
    open({ kind: "new", what, folder, name: "" });
  // 默认位置：树里选中的优先，其次主区打开的东西所在的文件夹，都没有就是根
  const newFolder = newFolderOf(
    nodes,
    treePick,
    view === null ? null : viewTreeId(view),
  );

  // 新放上去的东西排到了视野外：把视野平移过去，别让它藏在看不见的地方
  const reveal = (
    at: { x: number; y: number },
    size: { w: number; h: number },
  ) => {
    const r = bodyRef.current?.getBoundingClientRect();
    if (!r) return;
    const tl = rf.screenToFlowPosition({ x: r.left, y: r.top });
    const br = rf.screenToFlowPosition({ x: r.right, y: r.bottom });
    const inside =
      at.x >= tl.x &&
      at.y >= tl.y &&
      at.x + size.w <= br.x &&
      at.y + size.h <= br.y;
    if (!inside)
      void rf.setCenter(at.x + size.w / 2, at.y + size.h / 2, {
        zoom: rf.getZoom(),
        duration: 200,
      });
  };

  // 鼠标在画布里的位置：粘贴、拖入的东西以它为中心；鼠标不在画布里（在工具条上、在别处）就是 null
  const pointer = useRef<{ x: number; y: number } | null>(null);
  // 放一块 size 大小的新东西，返回它的中心：鼠标在画布里就是鼠标处，否则视野中心附近不压着现有节点的空位（必要时平移视野）
  const placeAt = (size: { w: number; h: number }) => {
    if (pointer.current) return rf.screenToFlowPosition(pointer.current);
    const r = bodyRef.current?.getBoundingClientRect();
    const c = r
      ? rf.screenToFlowPosition({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        })
      : { x: 0, y: 0 };
    const spot = freeSpot(
      { x: c.x - size.w / 2, y: c.y - size.h / 2 },
      state.doc?.nodes ?? [],
      size,
    );
    reveal(spot, size);
    return { x: spot.x + size.w / 2, y: spot.y + size.h / 2 };
  };

  // 粘贴 / 拖进来的文件：传到这块画布的资源文件夹，传完节点就在画布上了；结果合成一条提示。
  // at 是落点的中心（拖入、菜单粘贴）；缺省按鼠标位置或空位放
  const upload = async (files: File[], at?: { x: number; y: number }) => {
    if (files.length === 0 || !state.board) return;
    const report = await store.uploadAssets(files, at ?? placeAt(UPLOAD_SLOT));
    const first = report.failed[0];
    if (first)
      toast(
        report.failed.length === 1
          ? `${first.name}：${first.reason}`
          : `${report.failed.length} 个文件没传成：${first.name}：${first.reason}`,
        { tone: "danger" },
      );
    else if (report.placed > 0)
      toast(`已放入 ${report.placed} 个文件`, { tone: "ok" });
  };
  const clipboard = useCanvasClipboard({
    store,
    env,
    dir,
    placeAt,
    upload: (files, at) => void upload(files, at),
  });

  // 新卡片先是只在界面里的一个节点（空的也行，可以有很多张），保存时才建文件；
  // centre 是它的中心（缺省取当前视野中心）
  const newCard = (centre?: { x: number; y: number }) => {
    const r = bodyRef.current?.getBoundingClientRect();
    const mid =
      centre ??
      (r
        ? rf.screenToFlowPosition({
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
          })
        : { x: 0, y: 0 });
    const want = {
      x: mid.x - DRAFT_SIZE.w / 2,
      y: mid.y - DRAFT_SIZE.h / 2,
    };
    // 点工具条新建时避开已有的卡片（连着新建几张会排开）；双击空白处是用户点定的位置，不挪
    const spot = centre ? want : freeSpot(want, state.doc?.nodes ?? []);
    const at = { x: snap(spot.x), y: snap(spot.y) };
    const id = store.addCard(at);
    if (!id) return;
    setEditing(id);
    reveal(at, { w: DRAFT_SIZE.w, h: DRAFT_SIZE.h });
  };

  // 冲突的卡片逐张处理：先把磁盘上的版本取回来，再让用户选
  const askConflict = async (files: string[]) => {
    const [file, ...rest] = files;
    if (!file) return setConflict(null);
    const r = await readCard(loadToken(), env, dir, file);
    if (!r.ok)
      return toast("读不出磁盘上的版本，稍后再保存", { tone: "danger" });
    setConflict({
      file,
      disk: {
        text: r.data.text,
        base: { mtimeMs: r.data.mtimeMs, sha256: r.data.sha256 },
      },
      mine: store.getSnapshot().edits[file] ?? "",
      rest,
    });
  };
  const nextConflict = (c: Conflict) => {
    setConflict(null);
    if (fileOf(editing) === c.file) setEditing(null);
    void askConflict(c.rest);
  };

  // 保存整张画布：文档、改过的卡片、新卡片一个请求写出去
  const save = async () => {
    const r = await store.saveAll();
    if (r.kind === "error") return toast(r.message, { tone: "danger" });
    if (r.conflicts.length > 0) void askConflict(r.conflicts);
    else if (r.wrote) toast("已保存", { tone: "ok" });
  };
  const settleConflict = async (c: Conflict, text: string, done: string) => {
    const r = await store.writeCard(c.file, text, c.disk.base);
    if (r.ok) toast(done, { tone: "ok" });
    else toast(r.message, { tone: "danger" });
    if (r.ok) nextConflict(c);
    else setConflict(null);
  };
  const discard = () =>
    open({
      kind: "discard",
      proceed: () => {
        setEditing(null);
        void store.discardAll();
      },
    });

  /** 做一件事；成功就关掉对话框，再接着做 then（它可能又要弹确认，所以要在关掉之后） */
  const run = async <T,>(
    job: () => Promise<
      | { ok: true; data: T }
      | { ok: false; message?: string }
      | { ok: boolean; message?: string }
    >,
    then?: (data: T) => void,
  ) => {
    setBusy(true);
    setError(null);
    const r = await job();
    setBusy(false);
    if (r.ok) {
      close();
      then?.((r as { data: T }).data);
    } else setError(r.message ?? "没有成功，请重试");
  };

  const current = dialog;

  const sideWidth = prefs.width;
  const side = (
    <>
      <CanvasTree
        list={state.list}
        view={view}
        dirtyBoard={dirty ? state.board : null}
        onOpen={(r) => {
          if (r.kind === "board") go({ kind: "board", name: r.name });
          else if (r.kind === "note") go({ kind: "note", path: r.path });
          // 点按钮手动展开的悬浮树栏：选定了就收起，让出内容（悬停展开的，鼠标移开自己会收）
          if (floating && panel.manual && r.kind !== "folder") panel.close();
        }}
        newFolder={newFolder}
        initialFocus={treePick}
        onFocusChange={setTreePick}
        open={treeView.open}
        onOpenChange={treeView.setOpen}
        initialScroll={treeView.initialScroll}
        onScroll={treeView.onScroll}
        onNew={newIn}
        onRename={renameNode}
        onDelete={(picked) => void requestDelete(picked)}
        onMove={moveNodes}
        pinned={prefs.mode === "fixed"}
        forcedFloat={forcedFloat}
        onTogglePin={togglePin}
        onBusyChange={setTreeBusy}
      />
      <SplitHandle
        className="cv-side-grip"
        aria-label="调整树栏宽度"
        value={sideWidth}
        min={TREE_MIN}
        max={TREE_MAX}
        defaultValue={TREE_DEFAULT}
        onChange={(w) => setPref({ width: clampWidth(w) })}
      />
    </>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 只接 Ctrl+S（画布里任何位置都能保存）；tabIndex 让点画布时焦点留在这一层
    <div
      ref={rootRef}
      className="cv"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return;
        const key = e.key.toLowerCase();
        if (key === "s") {
          e.preventDefault();
          if (view?.kind === "note") noteSave.current?.();
          else void save();
        } else if (
          key === "a" &&
          !inEditable(e.target) &&
          view?.kind === "board"
        ) {
          e.preventDefault();
          selectAll(rf);
        }
      }}
      // 复制与粘贴：卡片、剪贴板里的文件与网页链接（在编辑器或输入框里照旧）
      onCopy={(e) => view?.kind === "board" && clipboard.onCopy(e.nativeEvent)}
      onPaste={(e) =>
        view?.kind === "board" && clipboard.onPaste(e.nativeEvent)
      }
    >
      <CanvasRail
        treeOpen={!floating || panel.open}
        treeCloses={!floating || (panel.open && panel.manual)}
        onToggleTree={toggleTree}
        onNew={(kind) => newIn(kind, newFolder)}
        onPointerEnter={panel.onPointerEnter}
        onPointerLeave={panel.onPointerLeave}
      />
      {!floating && (
        <div className="cv-side" style={{ width: sideWidth }}>
          {side}
        </div>
      )}
      {floating && panel.open && (
        <div
          ref={panelRef}
          className="cv-side"
          data-float
          style={{ width: sideWidth }}
          onPointerEnter={panel.onPointerEnter}
          onPointerLeave={panel.onPointerLeave}
        >
          {side}
        </div>
      )}
      <div className="cv-main">
        <CanvasBar
          state={state}
          view={view}
          canBack={nav !== null && canBack(nav)}
          canForward={nav !== null && canForward(nav)}
          onBack={() => nav && step(back(nav))}
          onForward={() => nav && step(forward(nav))}
          tailRef={setTail}
          sync={sync}
          versionsOpen={versionsOpen}
          onToggleVersions={() => setVersionsOpen((v) => !v)}
          onNewCard={() => newCard()}
          onSave={() => void save()}
          onDiscard={discard}
          zoom={{
            in: () => void rf.zoomIn({ duration: 150 }),
            out: () => void rf.zoomOut({ duration: 150 }),
            fit: () => void rf.fitView(FIT),
          }}
        />
        {state.list?.git === "missing" && (
          <InlineNotice tone="warn">
            这台主机上没有 git：画布照常使用，但没有历史，改动无法找回。
          </InlineNotice>
        )}
        <div
          className="cv-body"
          ref={bodyRef}
          onPointerMove={(e) => {
            pointer.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerLeave={() => {
            pointer.current = null;
          }}
        >
          {state.phase === "loading" && <Loading>正在读取</Loading>}
          {state.phase === "error" && (
            <Empty
              tone="danger"
              title="读不出画布"
              description="目录不可用，或这台主机已断开。"
              action={
                <Button onClick={() => void store.init(tab.canvas ?? null)}>
                  重试
                </Button>
              }
            />
          )}
          {state.phase === "ready" && view === null && (
            <Empty
              title={
                nodes.length === 0
                  ? "这个目录还没有画布或笔记"
                  : "从左边选一块画布或一篇笔记"
              }
              description="画布是收集想法的白板，笔记是 markdown 文件；都放在这个目录的 .canvas 里，agent 也能读写。"
              action={
                <>
                  <Button variant="primary" onClick={() => newIn("board", "")}>
                    新建画布
                  </Button>
                  <Button onClick={() => newIn("note", "")}>新建笔记</Button>
                </>
              }
            />
          )}
          {state.phase === "ready" && view?.kind === "note" && (
            <BarSlotsProvider value={{ lead: null, tail }}>
              <NoteView
                key={`${view.path}:${noteRev}`}
                env={env}
                dir={dir}
                hostLabel={hostName(host)}
                path={view.path}
                sessionId={sessionId}
                onDirtyChange={setNoteDirty}
                onWikilink={onWikilink}
                saveRef={noteSave}
              />
            </BarSlotsProvider>
          )}
          {state.phase === "ready" && view?.kind === "board" && state.board && (
            <CanvasFlow
              key={state.board}
              store={store}
              state={state}
              env={env}
              dir={dir}
              hostLabel={hostName(host)}
              hostNameOf={(envId) => hostName(hostIdOf(envId))}
              editing={editing}
              onEdit={edit}
              onExit={exit}
              onBlank={(id) => {
                if (editing && editing !== id) exit();
              }}
              onSave={() => void save()}
              onOpenRef={(file, refHost) => {
                if (!refHost && isNotePath(file))
                  return go({ kind: "note", path: file });
                // 别的主机上的引用：file 本身是绝对路径，在那台主机上开预览
                const abs = refHost ? file : absOfRef(dir, file);
                if (abs)
                  layout.openFilePreview(
                    pane.pid,
                    tab.id,
                    refHost ? hostIdOf(refHost) : host,
                    abs,
                  );
              }}
              onNewCard={newCard}
              onUpload={(files, at) => void upload(files, at)}
              onDeleteCards={(files) => open({ kind: "deleteCards", files })}
              onRenameCard={(file) =>
                open({ kind: "renameCard", file }, cardTitle(file))
              }
              onQuote={(file) => void quoteFile(file)}
              onCopy={() => {
                if (clipboard.copy() === null) return;
                toast("已复制", { tone: "ok" });
              }}
              onPaste={(at) => void clipboard.pasteAt(at)}
            />
          )}
          {versionsOpen && view !== null && (
            <VersionsPanel
              env={env}
              dir={dir}
              file={view.kind === "board" ? `${view.name}.canvas` : view.path}
              kind={view.kind}
              title={
                view.kind === "board"
                  ? view.name
                  : view.path.replace(/\.md$/i, "")
              }
              gitMissing={state.list?.git === "missing"}
              dirty={anyDirty}
              onChanged={versionsChanged}
              onClose={() => setVersionsOpen(false)}
            />
          )}
        </div>
      </div>

      {current?.kind === "new" && (
        <NewItemDialog
          key={`${current.what}:${current.folder}:${current.name}`}
          kind={current.what}
          folders={state.list?.folders ?? []}
          folder={current.folder}
          name={current.name}
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(path) => {
            const what = current.what;
            void run(
              async () => {
                const made =
                  what === "board"
                    ? await tree.createBoard(path)
                    : what === "note"
                      ? await tree.createNote(path)
                      : await tree.createFolder(path);
                // 新建要等服务端回话（画布名可能被避让重名、留空的用时间命名），不预演；回来直接换清单
                if (made.ok) await store.syncList();
                return made;
              },
              (result) => {
                if (what === "board") go({ kind: "board", name: result });
                else if (what === "note") go({ kind: "note", path: result });
              },
            );
          }}
        />
      )}

      <FormDialog
        open={current?.kind === "renameCard"}
        onClose={close}
        title="重命名卡片"
        description="卡片名就是文件名。"
        confirmLabel="改名"
        canSubmit={
          name.trim() !== "" &&
          current?.kind === "renameCard" &&
          name !== cardTitle(current.file)
        }
        busy={busy}
        error={error}
        onSubmit={() => {
          if (current?.kind !== "renameCard") return;
          const { file } = current;
          void run(async () => {
            return store.renameCard(file, name);
          });
        }}
      >
        <Input
          large
          autoFocus
          aria-label="卡片名"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </FormDialog>

      <ConfirmDialog
        open={current?.kind === "deleteNodes"}
        title={
          current?.kind === "deleteNodes"
            ? current.roots.length === 1
              ? `删除「${leafName(current.roots[0] as string)}」？`
              : `删除 ${current.roots.length} 项？`
            : ""
        }
        confirmLabel="删除"
        busy={busy}
        error={error}
        onClose={close}
        onConfirm={() => {
          if (current?.kind !== "deleteNodes") return;
          const { roots } = current;
          void run(() => runDelete(roots));
        }}
      >
        {current?.kind === "deleteNodes" && (
          <DeleteNote nodes={nodes} roots={current.roots} refs={current.refs} />
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={current?.kind === "deleteCards"}
        title={
          current?.kind === "deleteCards"
            ? current.files.every(isAssetPath)
              ? `删除 ${current.files.length} 个文件？`
              : current.files.some(isAssetPath)
                ? `删除 ${current.files.length} 个文件与灵感卡？`
                : `删除 ${current.files.length} 张灵感卡？`
            : ""
        }
        confirmLabel="删除"
        busy={busy}
        error={error}
        onClose={close}
        onConfirm={() => {
          if (current?.kind !== "deleteCards") return;
          const files = current.files;
          void run(async () => {
            return store.deleteCards(files);
          });
        }}
      >
        {current?.kind === "deleteCards" && (
          <>
            文件会被删除：
            {current.files
              .map((f) => (isAssetPath(f) ? refTitle(f) : cardTitle(f)))
              .join("、")}
            。画布有 git 历史时可以找回
            {current.files.some(isLargeAsset)
              ? "；其中太大的资源没进历史，删了就找不回了"
              : ""}
            。
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={current?.kind === "discard"}
        title="放弃未保存的修改？"
        confirmLabel="放弃"
        onClose={close}
        onConfirm={() => {
          if (current?.kind !== "discard") return;
          const { proceed } = current;
          close();
          proceed();
        }}
      >
        画布里有还没保存的修改（卡片文字、位置、连线），继续会全部丢掉。
      </ConfirmDialog>

      {conflict && (
        <ConflictDialog
          path={conflict.file}
          diskText={conflict.disk.text}
          mineText={conflict.mine}
          onCancel={() => setConflict(null)}
          onKeepDisk={() => {
            store.keepDisk(conflict.file, conflict.disk);
            toast("已载入磁盘上的内容", { tone: "ok" });
            nextConflict(conflict);
          }}
          onMerge={(merged) =>
            void settleConflict(conflict, merged, "已保存合并结果")
          }
          onOverwrite={() =>
            void settleConflict(conflict, conflict.mine, "已覆盖保存")
          }
        />
      )}
    </div>
  );
}

const leafName = (id: string): string =>
  id.slice(id.lastIndexOf("/") + 1).replace(/\.(md|canvas)$/i, "");

/** 删除确认里的说明：要删什么、被谁引用、能不能找回 */
function DeleteNote({
  nodes,
  roots,
  refs,
}: {
  nodes: readonly TreeNode[];
  roots: readonly string[];
  refs: { boards: string[]; notes: string[] } | null;
}) {
  const c = countWithin(nodes, roots);
  const parts = [
    c.folders > 0 ? `${c.folders} 个文件夹` : "",
    c.boards > 0 ? `${c.boards} 块画布（连同它的灵感卡与资源）` : "",
    c.notes > 0 ? `${c.notes} 篇笔记` : "",
  ].filter(Boolean);
  const used = refs ? refs.boards.length + refs.notes.length : 0;
  return (
    <>
      将删除 {parts.join("、")}。放在别的画布上的这些笔记会从画布上去掉；
      这些东西没有进历史的资源删了就找不回，其余保存在 .canvas 的 git 历史里。
      {used > 0 && (
        <>
          {" "}
          现在
          {refs && refs.boards.length > 0
            ? `有 ${refs.boards.length} 块画布放着它`
            : ""}
          {refs && refs.boards.length > 0 && refs.notes.length > 0 ? "、" : ""}
          {refs && refs.notes.length > 0
            ? `有 ${refs.notes.length} 篇笔记里的 [[链接]] 指向它（删了之后这些链接会失效）`
            : ""}
          。
        </>
      )}
    </>
  );
}
