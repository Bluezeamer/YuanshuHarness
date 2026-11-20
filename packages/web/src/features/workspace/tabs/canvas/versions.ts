// 版本历史（`.canvas/` 自己的 git）的展示换算：来源、一行摘要、画布两个版本之间的差别。纯函数，单测见 versions.test.ts。
import type { VersionEntry } from "../../../../api/canvas";

const SOURCE: Record<VersionEntry["source"], string> = {
  user: "你",
  agent: "agent",
  restore: "恢复",
  undo: "撤销",
  external: "外部改动",
};

export const sourceLabel = (e: VersionEntry): string => SOURCE[e.source];

const VERB: Record<string, string> = {
  save: "保存",
  create: "新建",
  add: "添加",
  delete: "删除",
  rename: "改名",
  move: "挪动",
  promote: "升格",
  restore: "恢复",
};

/** 路径只留人认得的部分：去掉 .canvas / .md 后缀 */
const nice = (p: string): string => p.replace(/\.(canvas|md)$/, "");

/**
 * 一行摘要。服务端写的是 `save 想法.canvas`、`create 产品/访谈.md and 2 more` 这类英文；
 * agent 的提交摘要是它自己写的一句话，原样给；撤销记的是被撤销那次的摘要。
 */
export function summaryOf(e: VersionEntry): string {
  if (e.source === "external") return "文件在界面之外被改动";
  if (e.source === "agent") return e.summary || "agent 改了画布";
  const m = /^(\w+) (.+?)(?: and (\d+) more)?$/.exec(e.summary);
  if (e.source === "undo")
    return e.summary ? `撤销了：${e.summary}` : "撤销了 agent 的上一次修改";
  if (!m) return e.summary;
  const [, verb = "", what = "", more] = m;
  const head = `${VERB[verb] ?? verb} ${nice(what)}`;
  return more === undefined ? head : `${head} 等 ${Number(more) + 1} 项`;
}

export interface BoardChanges {
  /** 恢复后会回来的节点（当时有、现在没有） */
  back: string[];
  /** 恢复后会消失的节点（现在有、当时没有） */
  gone: string[];
  /** 位置或大小不一样的节点数 */
  moved: number;
  edgesBack: number;
  edgesGone: number;
}

interface Doc {
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<{ id?: unknown }>;
}

const parse = (text: string): Doc | null => {
  try {
    const d = JSON.parse(text) as Doc;
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
};

/** 节点在列表里的名字：文件取不带后缀的文件名，文字取第一行，链接取地址，分组取标题 */
export function nodeLabel(n: Record<string, unknown>): string {
  const s = (k: string) => (typeof n[k] === "string" ? (n[k] as string) : "");
  const file = s("file");
  if (file)
    return (
      file
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") || file
    );
  const firstLine = s("text")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return firstLine || s("url") || s("label") || "（未命名）";
}

const geo = (n: Record<string, unknown>) =>
  [n.x, n.y, n.width, n.height].join(",");

/** current 是现在的画布文档，older 是要恢复到的版本；解析不了返回 null */
export function boardChanges(
  current: string,
  older: string,
): BoardChanges | null {
  const a = parse(current);
  const b = parse(older);
  if (!a || !b) return null;
  const byId = (d: Doc) =>
    new Map((d.nodes ?? []).map((n) => [String(n.id), n] as const));
  const now = byId(a);
  const then = byId(b);
  const edgeIds = (d: Doc) => new Set((d.edges ?? []).map((e) => String(e.id)));
  const eNow = edgeIds(a);
  const eThen = edgeIds(b);
  let moved = 0;
  for (const [id, n] of then) {
    const cur = now.get(id);
    if (cur && geo(cur) !== geo(n)) moved++;
  }
  return {
    back: [...then].filter(([id]) => !now.has(id)).map(([, n]) => nodeLabel(n)),
    gone: [...now].filter(([id]) => !then.has(id)).map(([, n]) => nodeLabel(n)),
    moved,
    edgesBack: [...eThen].filter((id) => !eNow.has(id)).length,
    edgesGone: [...eNow].filter((id) => !eThen.has(id)).length,
  };
}

export const isUnchanged = (c: BoardChanges): boolean =>
  c.back.length === 0 &&
  c.gone.length === 0 &&
  c.moved === 0 &&
  c.edgesBack === 0 &&
  c.edgesGone === 0;
