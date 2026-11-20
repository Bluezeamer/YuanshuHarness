// Studio 样张的假数据。左边是段，中间是这一段的卡片与分组，右边是预览。
// 分组 = 一个 switch：每张卡片带一个条件「如果 ⟨条件⟩ 则用这张」，自上而下取第一张成立的；条件为空（null）的是「否则」保底。
// 现在只有一种条件：模型（从供应商与模型里选）；Cond 带 kind，以后加别的条件在这里扩。
export interface ProviderInfo {
  id: string;
  name: string;
  models: string[];
}

// 真实界面里这份清单取自「供应商与模型」设置。
export const PROVIDERS: ProviderInfo[] = [
  { id: "qwen27b", name: "本地部署", models: ["Qwen3.8-27B", "Qwen3.8-14B"] },
  {
    id: "anthropic",
    name: "Anthropic",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-5"],
  },
  { id: "deepseek", name: "DeepSeek", models: ["deepseek-v4", "deepseek-r2"] },
];

export interface SimModel {
  key: string;
  provider: string;
  model: string;
  label: string;
}

export const SIM_MODELS: SimModel[] = PROVIDERS.flatMap((p) =>
  p.models.map((m) => ({
    key: `${p.id}/${m}`,
    provider: p.id,
    model: m,
    label: `${p.name} · ${m}`,
  })),
);

export const DEFAULT_MODEL = "qwen27b/Qwen3.8-27B";

export interface LibCard {
  id: string;
  title: string;
  /** 卡片库里的分组 */
  lib: string;
  builtin?: boolean;
  body: string;
  /** 被多少个预设引用 */
  usedBy: number;
}

export const LIB: LibCard[] = [
  {
    id: "identity",
    title: "元枢身份",
    lib: "角色与身份",
    builtin: true,
    usedBy: 5,
    body: "You are Yuanshu, a coding agent working inside the user's projects.\nYou read, edit and run code through tools, and you report results plainly.",
  },
  {
    id: "tools",
    title: "工具清单",
    lib: "约定与规则",
    builtin: true,
    usedBy: 5,
    body: "Available tools:\n- read: Read file contents\n- bash: Execute bash commands\n- edit: Make precise edits\n- write: Create or overwrite files",
  },
  {
    id: "rules",
    title: "工具使用规则",
    lib: "约定与规则",
    builtin: true,
    usedBy: 5,
    body: "Use read to examine files instead of cat or sed.\nPrefer edit for precise changes over write.\nShow file paths clearly when working with files.",
  },
  {
    id: "local",
    title: "本地模型限制",
    lib: "约定与规则",
    usedBy: 2,
    body: "Run at most 2 subagents at once.\nThinking effort is limited to low and xhigh.",
  },
  {
    id: "claude",
    title: "Claude 工具习惯",
    lib: "约定与规则",
    usedBy: 1,
    body: "Batch independent tool calls in one turn.\nPrefer dedicated tools over shell pipelines.",
  },
  {
    id: "generic",
    title: "通用提示",
    lib: "约定与规则",
    usedBy: 4,
    body: "Keep answers short; ask when the request is ambiguous.",
  },
  {
    id: "docs",
    title: "harness 文档索引",
    lib: "自身文档",
    builtin: true,
    usedBy: 5,
    body: "Harness documentation:\n- Main docs: README.md\n- Extensions: docs/extensions.md\n- Skills: docs/skills.md",
  },
  {
    id: "delivery",
    title: "交付提醒",
    lib: "约定与规则",
    usedBy: 3,
    body: "Before you finish, state what changed, what you verified, and what is left.",
  },
  {
    id: "format",
    title: "输出格式约定",
    lib: "约定与规则",
    usedBy: 1,
    body: "Use Markdown. Put file paths and identifiers in backticks.",
  },
  {
    id: "agentsmd",
    title: "全局 AGENTS.md（导入）",
    lib: "项目约定",
    usedBy: 1,
    body: "(imported from ~/.pi/agent/AGENTS.md)",
  },
  {
    id: "lang",
    title: "语言与称呼",
    lib: "项目约定",
    usedBy: 3,
    body: "Reply in Chinese. Keep code comments short.",
  },
  {
    id: "commit",
    title: "提交规范",
    lib: "项目约定",
    usedBy: 3,
    body: "Use Conventional Commits: <type>(<scope>): <description>.",
  },
];

export const card = (id: string): LibCard =>
  LIB.find((c) => c.id === id) as LibCard;

/** 条件：现在只有「模型」一种。providers = 整个供应商；models = 具体到某个模型（"供应商id/模型名"）；两个都空 = 还没选。 */
export interface Cond {
  kind: "model";
  providers: string[];
  models: string[];
}

export const emptyCond = (): Cond => ({
  kind: "model",
  providers: [],
  models: [],
});

/** 分组里的一张卡片 + 它的条件；when 为 null = 否则（保底） */
export interface Case {
  id: string;
  when: Cond | null;
}

export interface Group {
  kind: "group";
  id: string;
  name: string;
  cards: Case[];
}
export interface CardRef {
  kind: "card";
  id: string;
}
export type Item = CardRef | Group;

export interface Segment {
  id: string;
  title: string;
  tag: string | null;
  channel: "system" | "user";
  /** 由 pi 渲染或我们生成，内容不可编辑 */
  lock?: string;
  items: Item[];
}

const c = (id: string): CardRef => ({ kind: "card", id });

export const AGENT_SEGMENTS: Segment[] = [
  {
    id: "id",
    title: "角色定义",
    tag: null,
    channel: "system",
    items: [c("identity")],
  },
  {
    id: "rules",
    title: "工具与规则",
    tag: "rules",
    channel: "system",
    items: [
      c("tools"),
      c("rules"),
      {
        kind: "group",
        id: "g-model",
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
          { id: "generic", when: null },
        ],
      },
    ],
  },
  {
    id: "docs",
    title: "自身文档",
    tag: "docs",
    channel: "system",
    items: [c("docs")],
  },
  {
    id: "skills",
    title: "技能清单",
    tag: "skills",
    channel: "system",
    lock: "pi 渲染",
    items: [],
  },
  {
    id: "env",
    title: "环境信息",
    tag: "cwd",
    channel: "system",
    lock: "内置生成",
    items: [],
  },
  {
    id: "done",
    title: "交付提醒",
    tag: "delivery",
    channel: "user",
    items: [c("delivery")],
  },
];

export const FILE_SEGMENTS: Segment[] = [
  {
    id: "body",
    title: "AGENTS.md 正文",
    tag: null,
    channel: "system",
    items: [
      c("lang"),
      c("commit"),
      {
        kind: "group",
        id: "g-file-model",
        name: "按模型的约定",
        cards: [
          {
            id: "local",
            when: { kind: "model", providers: ["qwen27b"], models: [] },
          },
        ],
      },
    ],
  },
];

/** 条件是否对这个模型成立 */
export function holds(c: Cond, m: SimModel): boolean {
  return c.providers.includes(m.provider) || c.models.includes(m.key);
}

/** 条件的一句话摘要，给按钮显示 */
export function condText(c: Cond): string {
  const name = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id;
  const parts = [
    ...c.providers.map((id) => `${name(id)}（全部）`),
    ...c.models.map((k) => k.split("/")[1] ?? k),
  ];
  return parts.length ? parts.join("、") : "";
}

export interface Eval {
  /** 每个分组选中的那张卡片；都不匹配且没有保底就是 null */
  winner: Map<string, string | null>;
  /** 最终参与拼接的卡片 */
  cards: string[];
}

/** 一段在某个模型下的求值：段下面直接挂的卡片都要；分组里自上而下取第一张匹配（或留空）的。 */
export function evalSegment(seg: Segment, m: SimModel): Eval {
  const winner = new Map<string, string | null>();
  const cards: string[] = [];
  for (const it of seg.items) {
    if (it.kind === "card") {
      cards.push(it.id);
      continue;
    }
    const w = it.cards.find((c) => c.when === null || holds(c.when, m));
    winner.set(it.id, w?.id ?? null);
    if (w) cards.push(w.id);
  }
  return { winner, cards };
}

export const segBody = (seg: Segment, m: SimModel): string =>
  evalSegment(seg, m)
    .cards.map((id) => card(id).body)
    .join("\n\n");

/** 整份预设拼出的 system 与 user 文本 */
export function renderAll(
  segs: Segment[],
  m: SimModel,
): { system: string; user: string } {
  const sys: string[] = [];
  const usr: string[] = [];
  for (const s of segs) {
    const body = s.lock ? `(${s.lock}，内容不在这里展开)` : segBody(s, m);
    if (!body) continue;
    const text = s.tag === null ? body : `<${s.tag}>\n${body}\n</${s.tag}>`;
    (s.channel === "system" ? sys : usr).push(text);
  }
  return { system: sys.join("\n\n"), user: usr.join("\n\n") };
}

/** 卡片在这份预设里的位置，给预览面板写「段 › 分组」 */
export function whereIs(segs: Segment[], id: string): string | null {
  for (const s of segs)
    for (const it of s.items) {
      if (it.kind === "card" && it.id === id) return s.title;
      if (it.kind === "group" && it.cards.some((c) => c.id === id))
        return `${s.title} › ${it.name}`;
    }
  return null;
}

export const usedIds = (segs: Segment[]): Set<string> =>
  new Set(
    segs.flatMap((s) =>
      s.items.flatMap((it) =>
        it.kind === "card" ? [it.id] : it.cards.map((c) => c.id),
      ),
    ),
  );

/** 两份文本的逐行差异（样张里用最朴素的 LCS，足够短文本）。 */
export function lineDiff(
  a: string,
  b: string,
): { n: number; t: "same" | "add" | "del"; s: string }[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const l: number[][] = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0),
  );
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      (l[i] as number[])[j] =
        x[i] === y[j]
          ? ((l[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (l[i + 1] as number[])[j] as number,
              (l[i] as number[])[j + 1] as number,
            );
  const out: { n: number; t: "same" | "add" | "del"; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ n: out.length, t: "same", s: x[i] as string });
      i++;
      j++;
    } else if (
      j < y.length &&
      (i === x.length ||
        ((l[i] as number[])[j + 1] as number) >=
          ((l[i + 1] as number[])[j] as number))
    ) {
      out.push({ n: out.length, t: "add", s: y[j++] as string });
    } else out.push({ n: out.length, t: "del", s: x[i++] as string });
  }
  return out;
}
