// 画布本体：节点与连线的平移缩放、拖动、缩放、连线，双击空白新建卡片，拖入文件放引用。
// 节点与连线的运行态放在这里（拖动要每帧更新），只在「放手」时把结果交给 store 存进文档。
// 传给 xyflow 的回调都是稳定引用（props 里的函数走 ref）：它们一换，所有节点都会跟着重渲染。
import "@xyflow/react/dist/base.css";
import {
  addEdge,
  Background,
  type Connection,
  ConnectionMode,
  type Edge,
  type FinalConnectionState,
  type NodeChange,
  type OnBeforeDelete,
  ReactFlow,
  type ReactFlowInstance,
  SelectionMode,
  useConnection,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Viewport,
  ViewportPortal,
} from "@xyflow/react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Menu, type MenuItem, toast } from "../../../../ui";
import { CanvasEdge } from "./CanvasEdge";
import { LOW_ZOOM } from "./edgeGeom";
import {
  type Box,
  type FlowNode,
  fromFlow,
  infoOf,
  isAssetPath,
  isHttpUrl,
  isUnsaved,
  keepsAspect,
  nearestSide,
  newId,
  nodeAt,
  refFileOf,
  sameDoc,
  sameInfo,
  sizeForRatio,
  toFlow,
} from "./model";
import { type NodeCtx, NodeCtxProvider } from "./nodeCtx";
import { MIN_NODE } from "./nodeParts";
import { NODE_TYPES } from "./nodes";
import { type Guide, type Rect, snapBox, snapResize, unionRect } from "./snap";
import type { CanvasState, CanvasStore } from "./store";
import { useEdgeMarquee } from "./useEdgeMarquee";
import { useCanvasFileDrop } from "./useFileDrop";
import { useWheelPan } from "./useWheelPan";

// 连线自己画（CanvasEdge）：箭头与感应宽度按屏幕像素算，看得见的线盖在卡片之上
const EDGE_TYPES = { cv: CanvasEdge };
const EDGE_OPTIONS = { type: "cv" };

const FIT = { padding: 0.2, maxZoom: 1 };
// 一次拖进好几个文件时，彼此错开一点
const STAGGER = 24;
// 拖线时离连接点多近就算连上（屏幕像素）：与连接点悬停圈的半径一致（32px 的圈）；库按画布单位算，所以要除以缩放
const CONNECT_RADIUS_PX = 16;
// 只有鼠标中键拖动平移（右键留给菜单）；左键拖空白是框选，按住空格再拖也平移，触控板双指滑动见 useWheelPan
const PAN_BUTTONS = [1];

const openLink = (url: string | undefined) => {
  if (url && isHttpUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
};

const plot = (s: CanvasState) =>
  s.doc
    ? toFlow(s.doc, s.files, s.edits)
    : { nodes: [] as FlowNode[], edges: [] as Edge[] };

export interface CanvasFlowProps {
  store: CanvasStore;
  state: CanvasState;
  /** 画布所属的环境与目录：拖入的文件必须在这个目录里 */
  env: string;
  dir: string;
  hostLabel: string;
  /** 环境 id → 主机展示名（别的主机上的引用标注用） */
  hostNameOf(envId: string): string;
  /** 正在原地编辑的卡片的节点 id */
  editing: string | null;
  onEdit(id: string): void;
  onExit(): void;
  /** 点了空白处（或别的节点）：正在编辑的该收起了 */
  onBlank(id?: string): void;
  /** 保存整张画布 */
  onSave(): void;
  onOpenRef(file: string, host?: string): void;
  /** 双击空白处：at 是新卡片的中心 */
  onNewCard(at: { x: number; y: number }): void;
  /** 从系统里拖进来的文件：at 是落点（画布坐标），传到这块画布的资源文件夹里 */
  onUpload(files: File[], at: { x: number; y: number }): void;
  onDeleteCards(files: string[]): void;
  onRenameCard(file: string): void;
  /** 把卡片 / 笔记的正文连同来源加进对话的输入框 */
  onQuote(file: string): void;
  /** 复制选中的节点 */
  onCopy(): void;
  /** 在 at（画布坐标）粘贴剪贴板里的内容 */
  onPaste(at: { x: number; y: number }): void;
}

/** 全选：节点与连线 */
export function selectAll(rf: ReactFlowInstance<FlowNode, Edge>): void {
  rf.setNodes((ns) =>
    ns.map((n) => (n.selected ? n : { ...n, selected: true })),
  );
  rf.setEdges((es) =>
    es.map((e) => (e.selected ? e : { ...e, selected: true })),
  );
}

export function CanvasFlow(props: CanvasFlowProps) {
  const { store, state, env, dir, hostLabel, editing } = props;
  const cb = useRef(props);
  cb.current = props;
  const rf = useReactFlow<FlowNode, Edge>();
  const first = useMemo(() => plot(store.getSnapshot()), [store]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(first.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(first.edges);
  // 拖动吸附（库的 snapToGrid 关着，由 snapBox 全权负责）：先贴齐别的卡片的边与中线（出参考线），
  // 没贴上的方向落到 8 单位网格；按住 Alt 时两种吸附都关，卡片跟着鼠标自由移动
  const altDown = useRef(false);
  useEffect(() => {
    const set = (e: KeyboardEvent) => {
      altDown.current = e.altKey;
    };
    const off = () => {
      altDown.current = false;
    };
    window.addEventListener("keydown", set);
    window.addEventListener("keyup", set);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", set);
      window.removeEventListener("keyup", set);
      window.removeEventListener("blur", off);
    };
  }, []);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // 缩放开始时各节点的矩形：库每一帧都是按指针重新算新尺寸，要比对的是开始时的、不是上一帧吸过的
  const resizeStart = useRef(new Map<string, Rect>());
  const [guides, setGuides] = useState<Guide[]>([]);
  const showGuides = useCallback((next: Guide[]) => {
    setGuides((prev) =>
      JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
    );
  }, []);
  const onNodesChangeSnap = useCallback(
    (all: NodeChange<FlowNode>[]) => {
      // 缩放：库把新尺寸（含从左 / 上缩时的新位置）分成 dimensions 与 position 两条变化发来，这里整体吸一次再放行；
      // 缩放结束（resizing: false）清掉参考线与开始时的记录
      const resizingIds = new Set(
        all.flatMap((c) =>
          c.type === "dimensions" && c.resizing === true && c.dimensions
            ? [c.id]
            : [],
        ),
      );
      for (const c of all)
        if (c.type === "dimensions" && c.resizing === false) {
          resizeStart.current.delete(c.id);
          showGuides([]);
        }
      let changes = all;
      if (resizingIds.size > 0) {
        if (altDown.current) showGuides([]);
        else {
          const sizeOf = (n: FlowNode) => ({
            w: n.measured?.width ?? n.width ?? 0,
            h: n.measured?.height ?? n.height ?? 0,
          });
          const others = nodesRef.current
            .filter((n) => !resizingIds.has(n.id))
            .map((n) => ({ x: n.position.x, y: n.position.y, ...sizeOf(n) }));
          const g: Guide[] = [];
          for (const id of resizingIds) {
            const node = nodesRef.current.find((n) => n.id === id);
            const dim = changes.find(
              (c) => c.type === "dimensions" && c.id === id && c.dimensions,
            );
            if (!node || dim?.type !== "dimensions" || !dim.dimensions)
              continue;
            if (!resizeStart.current.has(id))
              resizeStart.current.set(id, {
                x: node.position.x,
                y: node.position.y,
                ...sizeOf(node),
              });
            const pos = changes.find(
              (c) => c.type === "position" && c.id === id,
            );
            const at =
              pos?.type === "position" && pos.position
                ? pos.position
                : node.position;
            const out = snapResize(
              resizeStart.current.get(id) as Rect,
              {
                x: at.x,
                y: at.y,
                w: dim.dimensions.width,
                h: dim.dimensions.height,
              },
              others,
              rf.getZoom(),
              {
                minW: MIN_NODE.w,
                minH: MIN_NODE.h,
                keepAspect: keepsAspect(node.data),
              },
            );
            g.push(...out.guides);
            const position = { x: out.rect.x, y: out.rect.y };
            const next = changes.filter(
              (c) => !(c.type === "position" && c.id === id),
            );
            changes = next.map((c) =>
              c.type === "dimensions" && c.id === id && c.dimensions
                ? {
                    ...c,
                    dimensions: { width: out.rect.w, height: out.rect.h },
                  }
                : c,
            );
            // 位置有变化（从左 / 上缩，或比例锁定时对侧跟着动）才发 position 变化
            if (
              position.x !== node.position.x ||
              position.y !== node.position.y
            )
              changes.push({ id, type: "position", position });
          }
          showGuides(g);
        }
      }
      // 拖动中与松手那一刻（库在松手时用它内部记的位置再发一次 dragging:false 的变化）都要吸，
      // 否则松手那一帧会回到没吸过的位置；缩放中的节点的位置变化不算拖动
      const moving = changes.flatMap((c) =>
        c.type === "position" && c.position && !resizingIds.has(c.id)
          ? [{ id: c.id, position: c.position, dragging: c.dragging === true }]
          : [],
      );
      const ended = changes.some(
        (c) => c.type === "position" && c.dragging === false,
      );
      if (moving.length === 0 || altDown.current) {
        if (ended || altDown.current) showGuides([]);
        return onNodesChange(changes);
      }
      const pos = new Map(moving.map((m) => [m.id, m.position]));
      const size = (n: FlowNode) => ({
        w: n.measured?.width ?? n.width ?? 0,
        h: n.measured?.height ?? n.height ?? 0,
      });
      const dragged = nodesRef.current
        .filter((n) => pos.has(n.id))
        .map((n) => ({
          ...(pos.get(n.id) as { x: number; y: number }),
          ...size(n),
        }));
      const others = nodesRef.current
        .filter((n) => !pos.has(n.id))
        .map((n) => ({ x: n.position.x, y: n.position.y, ...size(n) }));
      if (dragged.length === 0) return onNodesChange(changes);
      const {
        dx,
        dy,
        guides: g,
      } = snapBox(unionRect(dragged), others, rf.getZoom());
      showGuides(ended ? [] : g);
      onNodesChange(
        dx === 0 && dy === 0
          ? changes
          : changes.map((c) =>
              c.type === "position" && c.position
                ? {
                    ...c,
                    position: {
                      x: c.position.x + dx,
                      y: c.position.y + dy,
                    },
                  }
                : c,
            ),
      );
    },
    [onNodesChange, rf, showGuides],
  );
  // 选中的卡片排在别的卡片之上，但仍在连线之下：不用库的 elevateNodesOnSelect（它抬到 1000，会盖住连线）
  const shown = useMemo(
    () =>
      nodes.map((n) =>
        n.selected && n.type !== "group" && n.zIndex !== 1
          ? { ...n, zIndex: 1 }
          : n,
      ),
    [nodes],
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);

  // 文档被外部版本整体替换（载入、合并、新卡片换成真文件、加了新卡片）就重铺一遍并保留选中
  const seen = useRef(state.epoch);
  useEffect(() => {
    if (seen.current === state.epoch) return;
    seen.current = state.epoch;
    const next = plot(store.getSnapshot());
    // 粘贴进来的新节点要被选中（此时旧的选中让位）；其余情况保留原来的选中
    const pick = new Set(store.getSnapshot().pick);
    setNodes((prev) => {
      const picked =
        pick.size > 0
          ? pick
          : new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return next.nodes.map((n) =>
        picked.has(n.id) ? { ...n, selected: true } : n,
      );
    });
    setEdges(next.edges);
  }, [state.epoch, store, setNodes, setEdges]);

  // 卡片正文变了（磁盘上的预览、攒着没保存的正文、文件缺失）：更新节点上带的信息；没变的节点不动。
  // 正在编辑的那张显示的是编辑器，预览不跟着每次按键更新（收起编辑时再对齐），只更新「未保存」标记
  useEffect(() => {
    setNodes((prev) => {
      let changed = false;
      const out = prev.map((n) => {
        const file = n.data.file;
        if (!file) return n;
        const card = n.data.kind === "card" || n.data.kind === "note";
        const info =
          n.id === editing
            ? n.data.info
            : card
              ? infoOf(file, state.files, state.edits)
              : (state.files[n.data.key] ?? null);
        const dirty = card && isUnsaved(file, state.edits);
        if (sameInfo(n.data.info, info) && !!n.data.dirty === dirty) return n;
        changed = true;
        return { ...n, data: { ...n.data, info, dirty } };
      });
      return changed ? out : prev;
    });
  }, [state.files, state.edits, editing, setNodes]);

  // 放手之后才存：等一拍，让运行态先落定
  const commitSoon = useCallback(() => {
    setTimeout(() => {
      const cur = store.getSnapshot().doc;
      if (!cur) return;
      const next = fromFlow(cur, rf.getNodes(), rf.getEdges());
      if (!sameDoc(cur, next)) store.commit(next);
    }, 0);
  }, [store, rf]);

  // 线松在卡片范围内（不必对准连接点）就连到那张卡片，存档里的方向取离落点最近的边；
  // 松在连接点上的由 xyflow 自己连（onConnect）
  const flowRef = useRef<HTMLDivElement>(null);
  // 缩放写成 .cv-flow 上的 CSS 变量（--cv-z、倒数 --cv-iz）：卡片名、连接点与缩放柄的感应区等按它反向换算，
  // 缩放时大小不变；直接改样式、不走 React，缩放过程中不重渲染。缩得太小时卡片名不显示
  const applyZoom = useCallback(({ zoom }: Viewport) => {
    const el = flowRef.current;
    if (!el) return;
    el.style.setProperty("--cv-z", String(zoom));
    el.style.setProperty("--cv-iz", String(1 / zoom));
    if (zoom < LOW_ZOOM) el.setAttribute("data-lowzoom", "");
    else el.removeAttribute("data-lowzoom");
  }, []);
  const [connectRadius, setConnectRadius] = useState(CONNECT_RADIUS_PX);
  const boxes = useCallback(
    (): Box[] =>
      rf.getNodes().map((n) => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        width: n.measured?.width ?? n.width ?? 0,
        height: n.measured?.height ?? n.height ?? 0,
        group: n.type === "group",
      })),
    [rf],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((es) => addEdge({ ...c, id: newId() }, es));
      commitSoon();
    },
    [setEdges, commitSoon],
  );
  const onConnectEnd = useCallback(
    (e: globalThis.MouseEvent | TouchEvent, cs: FinalConnectionState) => {
      if (cs.isValid || !cs.fromNode || !cs.fromHandle) return;
      const p = "changedTouches" in e ? e.changedTouches[0] : e;
      if (!p) return;
      const at = rf.screenToFlowPosition({ x: p.clientX, y: p.clientY });
      const id = nodeAt(at, boxes(), cs.fromNode.id);
      const target = id ? rf.getNode(id) : undefined;
      const w = target?.measured?.width ?? target?.width;
      const h = target?.measured?.height ?? target?.height;
      if (!target || !w || !h) return;
      onConnect({
        source: cs.fromNode.id,
        sourceHandle: cs.fromHandle.id ?? null,
        target: target.id,
        targetHandle: nearestSide(
          { x: at.x - target.position.x, y: at.y - target.position.y },
          { width: w, height: h },
        ),
      });
    },
    [rf, boxes, onConnect],
  );
  // 拖线时让松手会连上的那张卡片亮起来
  useWheelPan(flowRef);
  useEdgeMarquee(flowRef, nodes, setEdges);
  // useConnection 给的 to 已经是画布坐标
  const hover = useConnection((c) =>
    c.inProgress ? nodeAt(c.to, boxes(), c.fromNode.id) : null,
  );
  useEffect(() => {
    if (hover === null) return;
    const mark = (on: boolean) =>
      setNodes((ns) =>
        ns.map((n) =>
          n.id === hover ? { ...n, className: on ? "cv-target" : "" } : n,
        ),
      );
    mark(true);
    return () => mark(false);
  }, [hover, setNodes]);

  // 已经存成文件的灵感卡：删除要二次确认，不走画布默认的立即删除；没存过的新卡片、引用与连线只是从画布上拿掉
  const onBeforeDelete: OnBeforeDelete<FlowNode, Edge> = useCallback(
    async ({ nodes: ns, edges: es }) => {
      // 已经存成文件的灵感卡与粘贴进来的资源：文件是画布自己的，删除要确认；引用只是从画布上拿掉。
      // 同一个资源文件还被别的节点用着（复制粘贴出来的）就只拿掉这个节点，文件留着
      const gone = new Set(ns.map((n) => n.id));
      const shared = (file: string) =>
        rf.getNodes().some((o) => o.data.file === file && !gone.has(o.id));
      const saved = ns.filter(
        (n) =>
          (n.type === "card" && !n.data.draft) ||
          (n.type === "ref" &&
            isAssetPath(n.data.file) &&
            !shared(n.data.file)),
      );
      if (saved.length > 0)
        cb.current.onDeleteCards(saved.map((n) => n.data.file));
      const kept = new Set(saved.map((n) => n.id));
      return {
        nodes: ns.filter((n) => !kept.has(n.id)),
        edges: es.filter((e) => !kept.has(e.source) && !kept.has(e.target)),
      };
    },
    [rf],
  );

  const onNodeDoubleClick = useCallback((_: MouseEvent, n: FlowNode) => {
    if (n.type === "card" || n.type === "note") cb.current.onEdit(n.id);
    else if (n.type === "ref") cb.current.onOpenRef(n.data.file, n.data.host);
    else if (n.type === "link") openLink(n.data.url);
  }, []);
  const onNodeClick = useCallback(
    (_: MouseEvent, n: FlowNode) => cb.current.onBlank(n.id),
    [],
  );
  const onPaneClick = useCallback(() => cb.current.onBlank(), []);
  // ── 右键菜单 ──
  const showMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const copyItem: MenuItem = {
    id: "copy",
    label: "复制",
    hint: "Ctrl+C",
    onSelect: () => cb.current.onCopy(),
  };
  const removeNodes = (ids: string[]) =>
    void rf.deleteElements({ nodes: ids.map((id) => ({ id })) });

  const nodeItems = (n: FlowNode): MenuItem[] => {
    const file = n.data.file;
    const quote: MenuItem = {
      id: "quote",
      label: "添加到对话",
      onSelect: () => cb.current.onQuote(file),
    };
    const remove: MenuItem = {
      id: "remove",
      label: "从画布移除",
      onSelect: () => removeNodes([n.id]),
    };
    if (n.type === "card")
      return [
        { id: "edit", label: "编辑", onSelect: () => cb.current.onEdit(n.id) },
        // 还没存成文件的卡片没有文件名可改，删除就是从画布上拿掉
        ...(n.data.draft
          ? [
              copyItem,
              { ...remove, separatorBefore: true, tone: "danger" as const },
            ]
          : [
              quote,
              {
                id: "rename",
                label: "重命名",
                onSelect: () => cb.current.onRenameCard(file),
              },
              copyItem,
              {
                id: "delete",
                label: "删除卡片",
                tone: "danger" as const,
                separatorBefore: true,
                onSelect: () => cb.current.onDeleteCards([file]),
              },
            ]),
      ];
    // 笔记不属于这块画布：只能编辑、预览里打开、从画布移除（改名与删除在笔记自己那里）
    if (n.type === "note")
      return [
        { id: "edit", label: "编辑", onSelect: () => cb.current.onEdit(n.id) },
        {
          id: "open",
          label: "在预览里打开",
          onSelect: () => cb.current.onOpenRef(file),
        },
        quote,
        copyItem,
        { ...remove, separatorBefore: true },
      ];
    if (n.type === "ref") {
      const open: MenuItem = {
        id: "open",
        label: "在预览里打开",
        onSelect: () => cb.current.onOpenRef(file, n.data.host),
      };
      if (!isAssetPath(file))
        return [open, copyItem, { ...remove, separatorBefore: true }];
      // 资源文件被几个节点共用时，可以只拿掉这一个
      const used = rf.getNodes().filter((o) => o.data.file === file).length;
      return [
        open,
        copyItem,
        ...(used > 1 ? [{ ...remove, separatorBefore: true }] : []),
        {
          id: "delete",
          label: "删除文件",
          tone: "danger" as const,
          separatorBefore: used <= 1,
          onSelect: () => cb.current.onDeleteCards([file]),
        },
      ];
    }
    if (n.type === "link")
      return [
        {
          id: "open",
          label: "在新标签页打开",
          onSelect: () => openLink(n.data.url),
        },
        copyItem,
        { ...remove, separatorBefore: true },
      ];
    return [copyItem, { ...remove, separatorBefore: true }];
  };

  const selectionItems = (ids: string[]): MenuItem[] => [
    { ...copyItem, label: `复制 ${ids.length} 个` },
    {
      id: "remove",
      label: `删除 ${ids.length} 个`,
      tone: "danger",
      separatorBefore: true,
      onSelect: () => removeNodes(ids),
    },
  ];

  const onNodeMenu = (e: MouseEvent, node: FlowNode) => {
    const picked = rf.getNodes().filter((n) => n.selected);
    // 点在没选中的节点上：先只选它（和文件管理器一样）；点在已选中的多个节点上：菜单管这一批
    if (!node.selected)
      rf.setNodes((ns) =>
        ns.map((n) => ({ ...n, selected: n.id === node.id })),
      );
    showMenu(
      e,
      node.selected && picked.length > 1
        ? selectionItems(picked.map((n) => n.id))
        : nodeItems(node),
    );
  };
  const onSelectionMenu = (e: MouseEvent, ns: FlowNode[]) =>
    showMenu(e, selectionItems(ns.map((n) => n.id)));
  const onEdgeMenu = (e: MouseEvent, edge: Edge) => {
    rf.setEdges((es) => es.map((x) => ({ ...x, selected: x.id === edge.id })));
    showMenu(e, [
      {
        id: "reverse",
        label: "反向",
        onSelect: () => {
          setEdges((es) =>
            es.map((x) =>
              x.id === edge.id
                ? {
                    ...x,
                    source: x.target,
                    target: x.source,
                    ...(x.targetHandle ? { sourceHandle: x.targetHandle } : {}),
                    ...(x.sourceHandle ? { targetHandle: x.sourceHandle } : {}),
                  }
                : x,
            ),
          );
          commitSoon();
        },
      },
      {
        id: "delete",
        label: "删除连线",
        tone: "danger",
        separatorBefore: true,
        onSelect: () => void rf.deleteElements({ edges: [{ id: edge.id }] }),
      },
    ]);
  };
  const onPaneMenu = (e: MouseEvent | globalThis.MouseEvent) => {
    const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: "new",
          label: "新建卡片",
          onSelect: () => cb.current.onNewCard(at),
        },
        {
          id: "paste",
          label: "粘贴",
          hint: "Ctrl+V",
          onSelect: () => cb.current.onPaste(at),
        },
        {
          id: "all",
          label: "全选",
          hint: "Ctrl+A",
          separatorBefore: true,
          onSelect: () => selectAll(rf),
        },
        {
          id: "fit",
          label: "适应窗口",
          onSelect: () => void rf.fitView(FIT),
        },
      ],
    });
  };

  // 菜单项在点开的那一刻现算；传给 xyflow 的回调要稳定（一换所有节点都重渲染），所以转发到最新一份
  const menus = useRef({
    node: onNodeMenu,
    selection: onSelectionMenu,
    edge: onEdgeMenu,
    pane: onPaneMenu,
  });
  menus.current = {
    node: onNodeMenu,
    selection: onSelectionMenu,
    edge: onEdgeMenu,
    pane: onPaneMenu,
  };
  const onNodeContextMenu = useCallback(
    (e: MouseEvent, n: FlowNode) => menus.current.node(e, n),
    [],
  );
  const onSelectionContextMenu = useCallback(
    (e: MouseEvent, ns: FlowNode[]) => menus.current.selection(e, ns),
    [],
  );
  const onEdgeContextMenu = useCallback(
    (e: MouseEvent, edge: Edge) => menus.current.edge(e, edge),
    [],
  );
  const onPaneContextMenu = useCallback(
    (e: MouseEvent | globalThis.MouseEvent) => menus.current.pane(e),
    [],
  );

  // 图片载入后让节点的宽高比等于图片本身的比例（宽度不变）：刚拖进来的、以前被随意拉伸过的都一样。
  // 图片节点缩放时锁定的是开始缩放那一刻的比例，所以这一步要先对上，缩放时才不会出现空白
  const fitImage = useCallback(
    (id: string, ratio: number) => {
      const node = rf.getNode(id);
      const w = node?.width ?? node?.measured?.width;
      const cur = node?.height ?? node?.measured?.height;
      if (!node || !w || !cur) return;
      const { w: nw, h: nh } = sizeForRatio(w, ratio);
      // 差在取整的误差内就不动，免得一打开画布就变成「未保存」
      if (Math.abs(nh - cur) <= 2 && Math.abs(nw - w) <= 2) return;
      rf.updateNode(id, { width: nw, height: nh });
      // 等 xyflow 把新尺寸写进它的节点表，再取一次存档（同一拍里读回来还是旧值）
      requestAnimationFrame(commitSoon);
    },
    [rf, commitSoon],
  );

  const ctx = useMemo<NodeCtx>(
    () => ({
      env,
      dir,
      hostLabel,
      hostNameOf: (id) => cb.current.hostNameOf(id),
      mediaRev: state.mediaRev,
      editing,
      commitLayout: commitSoon,
      startEdit: (f) => cb.current.onEdit(f),
      exitEdit: () => cb.current.onExit(),
      loadCard: (f) => store.loadCard(f),
      setText: (f, t) => store.setEdit(f, t),
      save: () => cb.current.onSave(),
      openRef: (f, h) => cb.current.onOpenRef(f, h),
      fitImage,
    }),
    [env, dir, hostLabel, state.mediaRev, editing, commitSoon, store, fitImage],
  );

  const dropFile = useCanvasFileDrop(
    (item, at) => {
      // 文件夹放不上画布：批量里夹着的文件夹跳过，全是文件夹才提示
      const files = item.entries.filter((e) => !e.isDir);
      if (files.length === 0) {
        toast("只能放文件，不能放文件夹", { tone: "warn" });
        return;
      }
      const base = rf.screenToFlowPosition(at);
      let placed = 0;
      let dup = 0;
      for (const { path: p } of files) {
        // 画布所在目录之内的用相对路径（画布跟着项目挪也不失效）；别的主机、目录之外的存主机 + 绝对路径
        const inside = item.env === env ? refFileOf(dir, p) : null;
        const at = {
          x: base.x + placed * STAGGER,
          y: base.y + placed * STAGGER,
        };
        const id = inside
          ? store.addRef(inside, at)
          : store.addRef(p, at, item.env);
        if (id === null) {
          dup += 1;
          continue;
        }
        placed += 1;
      }
      if (placed === 0 && dup > 0)
        toast("这个文件已经在画布上了", { tone: "warn" });
    },
    (files, at) => cb.current.onUpload(files, rf.screenToFlowPosition(at)),
    (paths, at) => {
      const base = rf.screenToFlowPosition(at);
      let placed = 0;
      for (const p of paths) {
        const id = store.addRef(p, {
          x: base.x + placed * STAGGER,
          y: base.y + placed * STAGGER,
        });
        if (id !== null) placed += 1;
      }
      if (placed === 0) toast("这篇笔记已经在画布上了", { tone: "warn" });
    },
  );

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    // 只有双击空白处才新建；双击节点是打开它
    if (!(e.target as HTMLElement).classList.contains("react-flow__pane"))
      return;
    cb.current.onNewCard(
      rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
    );
  };

  const empty = nodes.length === 0;
  return (
    <NodeCtxProvider value={ctx}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 包裹层只做落点与双击空白新建，键盘上有「新建卡片」按钮与删除键 */}
      <div
        ref={flowRef}
        className="cv-flow"
        data-drop={dropFile.dragging || undefined}
        onDoubleClick={onDoubleClick}
        onDragEnter={dropFile.onDragEnter}
        onDragOver={dropFile.onDragOver}
        onDragLeave={dropFile.onDragLeave}
        onDrop={dropFile.onDrop}
      >
        <ReactFlow<FlowNode, Edge>
          nodes={shown}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          defaultEdgeOptions={EDGE_OPTIONS}
          onInit={(inst) => applyZoom(inst.getViewport())}
          onViewportChange={applyZoom}
          onMoveEnd={(_, vp) => setConnectRadius(CONNECT_RADIUS_PX / vp.zoom)}
          onNodesChange={onNodesChangeSnap}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          connectionRadius={connectRadius}
          elevateNodesOnSelect={false}
          onNodeDragStop={commitSoon}
          onNodesDelete={commitSoon}
          onEdgesDelete={commitSoon}
          onBeforeDelete={onBeforeDelete}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onNodeContextMenu={onNodeContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          connectionMode={ConnectionMode.Loose}
          zoomOnDoubleClick={false}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={PAN_BUTTONS}
          panActivationKeyCode="Space"
          minZoom={0.2}
          maxZoom={5}
          fitView={first.nodes.length > 0}
          fitViewOptions={FIT}
          deleteKeyCode={["Backspace", "Delete"]}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1.5} color="var(--line-strong)" />
          {guides.length > 0 && (
            <ViewportPortal>
              {guides.map((g) => (
                <div
                  key={`${g.axis}:${g.at}`}
                  className="cv-guide"
                  data-axis={g.axis}
                  style={
                    g.axis === "x"
                      ? { left: g.at, top: g.from, height: g.to - g.from }
                      : { top: g.at, left: g.from, width: g.to - g.from }
                  }
                />
              ))}
            </ViewportPortal>
          )}
        </ReactFlow>
        {empty && (
          <div className="cv-hint t-aux">
            双击空白处新建卡片，或从文件管理器把项目里的文件拖进来
          </div>
        )}
        <Menu
          label="节点操作"
          open={menu !== null}
          onOpenChange={(o) => {
            if (!o) setMenu(null);
          }}
          {...(menu ? { point: { x: menu.x, y: menu.y } } : {})}
          items={menu?.items ?? []}
          trigger={() => null}
        />
      </div>
    </NodeCtxProvider>
  );
}
