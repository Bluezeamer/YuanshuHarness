// 画布的复制粘贴：选中的卡片（连同它们之间的连线）复制成剪贴内容，粘贴时落在鼠标处；
// 剪贴板里的文件（截图、图片、视频……）与网页链接也在这里分流。
import { type Edge, useReactFlow } from "@xyflow/react";
import { useRef } from "react";
import { toast } from "../../../../ui";
import {
  buildClip,
  type Clip,
  type FlowNode,
  LINK_SIZE,
  linkNode,
  newId,
  pasteInto,
  refTitle,
  urlsIn,
} from "./model";
import type { CanvasStore } from "./store";

interface Point {
  x: number;
  y: number;
}

/**
 * 页面里复制下来的卡片：整个页面共用一份（切到别的画布标签也能粘）。
 * text 是同时放进系统剪贴板的可读文字：粘贴时系统剪贴板里还是它，才认这份；中间复制过别的东西就不认了。
 */
let clip: { text: string; data: Promise<Clip> } | null = null;

export const inEditable = (t: EventTarget | null): boolean =>
  t instanceof Element &&
  t.closest("input, textarea, [contenteditable], .cm-editor") !== null;

/** 浏览器允许时直接读系统剪贴板（右键菜单的「粘贴」用）；不允许或不支持返回 null */
async function readSystemClipboard(): Promise<{
  files: File[];
  text: string;
} | null> {
  try {
    const files: File[] = [];
    let text = "";
    for (const item of await navigator.clipboard.read())
      for (const type of item.types) {
        const blob = await item.getType(type);
        if (type === "text/plain") text = await blob.text();
        else if (type.startsWith("image/"))
          files.push(new File([blob], `image.${type.slice(6)}`, { type }));
      }
    return { files, text };
  } catch {
    return null;
  }
}

export interface ClipboardDeps {
  store: CanvasStore;
  env: string;
  dir: string;
  /** 放一块 size 大小的新东西：鼠标在画布里就以鼠标处为中心，否则是视野里不压着别的节点的空位；返回中心 */
  placeAt(size: { w: number; h: number }): Point;
  /** 粘贴进来的文件：传到画布的资源文件夹；at 是中心（缺省自己找） */
  upload(files: File[], at?: Point): void;
}

export function useCanvasClipboard(deps: ClipboardDeps) {
  const { store, env, dir, placeAt, upload } = deps;
  const rf = useReactFlow<FlowNode, Edge>();
  // 连着粘贴几次、鼠标没动：错开一点，免得整整齐齐叠在一起
  const again = useRef({ key: "", n: 0 });

  const copySelection = (): string | null => {
    const snap = store.getSnapshot();
    const sel = rf.getNodes().filter((n) => n.selected);
    if (!snap.doc || !snap.board || sel.length === 0) return null;
    const ids = new Set(sel.map((n) => n.id));
    const doc = snap.doc;
    const board = snap.board;
    // 灵感卡带完整正文：没保存的有攒着的，已存的去读（预览只有开头一段）
    const data = (async () => {
      const texts: Record<string, string> = {};
      let failed = 0;
      await Promise.all(
        sel
          .filter((n) => n.type === "card")
          .map(async (n) => {
            const r = await store.loadCard(n.data.file);
            if (r.ok) texts[n.id] = r.data;
            else failed += 1;
          }),
      );
      if (failed > 0)
        toast(`${failed} 张卡片没读出来，粘贴出来的是空卡片`, { tone: "warn" });
      return buildClip({ env, dir, board }, doc, ids, texts);
    })();
    const text = sel
      .map((n) =>
        n.type === "card" || n.type === "note"
          ? (n.data.info?.preview ?? "")
          : n.type === "link"
            ? (n.data.url ?? "")
            : n.type === "ref"
              ? refTitle(n.data.file)
              : n.data.label,
      )
      .filter(Boolean)
      .join("\n\n");
    clip = { text, data };
    return text;
  };

  const pasteClip = async (at?: Point): Promise<void> => {
    const snap = store.getSnapshot();
    if (!clip || !snap.board) return;
    const c = await clip.data;
    if (c.nodes.length === 0) return;
    const box = {
      w:
        Math.max(...c.nodes.map((k) => k.node.x + k.node.width)) -
        Math.min(...c.nodes.map((k) => k.node.x)),
      h:
        Math.max(...c.nodes.map((k) => k.node.y + k.node.height)) -
        Math.min(...c.nodes.map((k) => k.node.y)),
    };
    const mid = at ?? placeAt(box);
    const key = `${mid.x},${mid.y}`;
    again.current = {
      key,
      n: again.current.key === key ? again.current.n + 1 : 0,
    };
    const shift = again.current.n * 24;
    const out = pasteInto(
      c,
      { env, dir, board: snap.board },
      { x: mid.x + shift, y: mid.y + shift },
      newId,
    );
    if (out.nodes.length === 0)
      return void toast("这些内容放不进这块画布", { tone: "warn" });
    store.addNodes(out.nodes, out.edges, out.edits, true);
    if (out.skipped > 0)
      toast(
        `${out.skipped} 个节点放不进这里：项目文件引用只能回到同一个目录，画布自己的资源只能回到同一块画布`,
        { tone: "warn" },
      );
  };

  const pasteLinks = (urls: string[], at?: Point): void => {
    const mid = at ?? placeAt(LINK_SIZE);
    store.addNodes(
      urls.map((u, i) =>
        linkNode(u, {
          x: mid.x - LINK_SIZE.w / 2 + i * 32,
          y: mid.y - LINK_SIZE.h / 2 + i * 32,
        }),
      ),
      [],
      {},
      true,
    );
  };

  /** 剪贴板里的内容能放上画布就放，返回有没有接手：文件 > 自己复制的卡片 > 网页链接 */
  const handle = (
    content: { files: File[]; text: string },
    at?: Point,
  ): boolean => {
    if (content.files.length > 0) {
      upload(content.files, at);
      return true;
    }
    if (clip && content.text === clip.text) {
      void pasteClip(at);
      return true;
    }
    const urls = urlsIn(content.text);
    if (urls) {
      pasteLinks(urls, at);
      return true;
    }
    return false;
  };

  return {
    copy: copySelection,
    onCopy(e: ClipboardEvent) {
      // 在编辑器 / 输入框里、或选了一段文字时，照旧复制文字
      if (inEditable(e.target) || window.getSelection()?.toString()) return;
      const text = copySelection();
      if (text === null) return;
      e.clipboardData?.setData("text/plain", text);
      e.preventDefault();
    },
    onPaste(e: ClipboardEvent) {
      if (inEditable(e.target) || !e.clipboardData) return;
      const files = Array.from(e.clipboardData.files);
      const text = e.clipboardData.getData("text/plain");
      if (handle({ files, text })) e.preventDefault();
    },
    /** 右键菜单的「粘贴」：能读系统剪贴板就读，读不了就用页面里复制的卡片 */
    async pasteAt(at: Point) {
      const sys = await readSystemClipboard();
      if (sys && handle(sys, at)) return;
      if (!sys && clip) return pasteClip(at);
      toast(
        sys
          ? "剪贴板里没有能放上画布的内容"
          : "浏览器不让读取剪贴板，请用 Ctrl+V 粘贴",
        { tone: "warn" },
      );
    },
  };
}
