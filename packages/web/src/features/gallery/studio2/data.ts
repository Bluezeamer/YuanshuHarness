import { useState } from "react";
import { AGENT_SEGMENTS, type Item, LIB, type Segment } from "../studioData";

// 「提示词与能力」完整样张的假数据与内存里的 store：增删改都只改这里，刷新就复位。
export type Kind = "gmd" | "pmd" | "extra" | "agent" | "mode";

export interface Preset {
  id: string;
  kind: Kind;
  name: string;
  desc: string;
  segs: Segment[];
  active?: boolean;
  refs?: number;
}

export const NOUN: Record<Kind, string> = {
  gmd: "版本",
  pmd: "模板",
  extra: "版本",
  agent: "Agent",
  mode: "模式",
};

const C = (id: string): Item => ({ kind: "card", id });
const clone = <T>(v: T): T => structuredClone(v);
const one = (items: Item[]): Segment[] => [
  { id: "body", title: "正文", tag: null, channel: "system", items },
];
const pick = (...ids: string[]): Segment[] =>
  clone(AGENT_SEGMENTS.filter((s) => ids.includes(s.id)));

const INITIAL: Preset[] = [
  {
    id: "g3",
    kind: "gmd",
    name: "我的习惯 v3",
    desc: "中文回复；改代码前先说明；提交信息写英文",
    segs: one([C("lang"), C("commit"), C("delivery")]),
    active: true,
  },
  {
    id: "g2",
    kind: "gmd",
    name: "我的习惯 v2",
    desc: "中文回复；提交信息写英文",
    segs: one([C("lang"), C("commit")]),
  },
  {
    id: "pf",
    kind: "pmd",
    name: "前端项目模板",
    desc: "React + Tailwind；组件放 ui/；测试用 vitest",
    segs: one([C("lang"), C("commit"), C("format")]),
  },
  {
    id: "pb",
    kind: "pmd",
    name: "后端项目模板",
    desc: "FastAPI；依赖用 uv；测试放 tests/",
    segs: one([C("lang"), C("commit"), C("generic")]),
  },
  {
    id: "x1",
    kind: "extra",
    name: "按模型的补充约束",
    desc: "本地模型少并行、Claude 批量调用工具",
    active: true,
    segs: one([
      C("delivery"),
      {
        kind: "group",
        id: "g-x",
        name: "按模型的提示",
        cards: [
          {
            id: "local",
            when: { kind: "model", providers: ["qwen27b"], models: [] },
          },
          {
            id: "claude",
            when: {
              kind: "model",
              providers: [],
              models: ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5"],
            },
          },
        ],
      },
    ]),
  },
  {
    id: "a1",
    kind: "agent",
    name: "coder-full",
    desc: "完整编码助手：身份、工具规则、文档、环境与交付提醒",
    segs: clone(AGENT_SEGMENTS),
    refs: 3,
  },
  {
    id: "a2",
    kind: "agent",
    name: "reviewer",
    desc: "只评审不改代码",
    segs: pick("id", "rules", "done"),
  },
  {
    id: "a3",
    kind: "agent",
    name: "local-qwen",
    desc: "本地 Qwen 专用，短提示词、不带子代理",
    segs: pick("id", "rules"),
    refs: 1,
  },
  {
    id: "a4",
    kind: "agent",
    name: "doc-writer",
    desc: "写文档与变更说明，只读代码",
    segs: pick("id", "docs", "done"),
  },
  {
    id: "m1",
    kind: "mode",
    name: "plan",
    desc: "只读规划：不改文件，先给方案",
    segs: one([C("generic"), C("delivery")]),
  },
  {
    id: "m2",
    kind: "mode",
    name: "review",
    desc: "评审：读代码、给意见",
    segs: one([C("generic")]),
  },
];

/** 一份预设里一共挂了几张卡片（分组里的也算） */
export const cardsOf = (segs: Segment[]): number =>
  segs.reduce(
    (a, s) =>
      a +
      s.items.reduce(
        (b, it) => b + (it.kind === "card" ? 1 : it.cards.length),
        0,
      ),
    0,
  );

const uid = () => Math.random().toString(36).slice(2, 8);

export function useStore() {
  const [list, setList] = useState<Preset[]>(INITIAL);
  // 磁盘上的 ~/.ys/AGENTS.md 是否被手改过（样张里一开始就是改过的，用来演示覆盖提示）
  const [disk, setDisk] = useState(true);

  const get = (id: string) => list.find((p) => p.id === id);
  const patch = (id: string, p: Partial<Preset>) =>
    setList((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const add = (kind: Kind, name: string, desc: string, segs?: Segment[]) => {
    const id = uid();
    const base =
      segs ??
      (kind === "agent"
        ? clone(AGENT_SEGMENTS).map((s) => ({ ...s, items: [] }))
        : one([]));
    setList((l) => [...l, { id, kind, name, desc, segs: base }]);
    return id;
  };
  const copy = (id: string) => {
    const p = get(id);
    if (!p) return null;
    const nid = uid();
    setList((l) => [
      ...l,
      { ...clone(p), id: nid, name: `${p.name} 副本`, active: false, refs: 0 },
    ]);
    return nid;
  };
  const remove = (id: string) => setList((l) => l.filter((p) => p.id !== id));
  const activate = (id: string) => {
    const kind = get(id)?.kind;
    setList((l) =>
      l.map((p) => (p.kind === kind ? { ...p, active: p.id === id } : p)),
    );
    if (kind === "gmd") setDisk(false);
  };
  return { list, get, patch, add, copy, remove, activate, disk, setDisk };
}
export type Store = ReturnType<typeof useStore>;

/** 卡片库是模块级的假数据：样张里直接改它，页面靠 bump 重绘。 */
export function newLibCard(title: string, body: string, lib: string): string {
  const id = `c-${uid()}`;
  LIB.push({ id, title, lib, body, usedBy: 0 });
  return id;
}

/** 把预设里的某张卡片换成另一张（内置卡片复制后替换进来） */
export const swapCard = (
  segs: Segment[],
  from: string,
  to: string,
): Segment[] =>
  segs.map((s) => ({
    ...s,
    items: s.items.map((it) =>
      it.kind === "card"
        ? { ...it, id: it.id === from ? to : it.id }
        : {
            ...it,
            cards: it.cards.map((c) => ({
              ...c,
              id: c.id === from ? to : c.id,
            })),
          },
    ),
  }));
