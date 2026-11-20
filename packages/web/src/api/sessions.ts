import { type GoalNotice, goalNoticeKey } from "./goal";
import { call, enc, get, type Result } from "./http";
import type { JobSnapshot } from "./jobs";

export interface SessionInfo {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  directoryId?: string | null;
  promptPresetId?: string | null;
  modePresetIds?: string[];
  activeModeId?: string | null;
}

/** 消息里的附件引用；sizeText 是服务端格式化好的体积文案 */
export interface MessageAttachment {
  name: string;
  mime: string;
  sizeText: string;
  path: string;
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

// 消息附件引用：字段缺失或形状不对就当作没有附件，不让一条坏数据拖垮界面。
export function parseAttachments(v: unknown): MessageAttachment[] | null {
  if (!Array.isArray(v)) return null;
  const list = v.flatMap((item): MessageAttachment[] => {
    const d = record(item);
    if (!d || typeof d.name !== "string" || typeof d.path !== "string")
      return [];
    return [
      {
        name: d.name,
        mime: typeof d.mime === "string" ? d.mime : "",
        sizeText: typeof d.sizeText === "string" ? d.sizeText : "",
        path: d.path,
      },
    ];
  });
  return list.length > 0 ? list : null;
}

/** 用户内容的编辑形态：文字（已去掉附件标记行）+ 附件引用。排队消息、回退回填共用。 */
export interface EditableContent {
  text: string;
  attachments: MessageAttachment[];
}

export function parseEditable(v: unknown): EditableContent | null {
  const d = record(v);
  if (!d || typeof d.text !== "string") return null;
  return { text: d.text, attachments: parseAttachments(d.attachments) ?? [] };
}

export interface ChatEntry {
  index: number;
  role: "user" | "assistant";
  text: string;
  /** 消息时间（ISO 8601）；旧会话或未落定的消息可能没有 */
  ts?: string;
  blocks?: Block[];
  attachments?: MessageAttachment[];
}

export interface Page {
  messages: ChatEntry[];
  nextBefore: string | null;
  /** 压缩边界锚点：afterIndex 是它之前已投影的 user/assistant 消息条数。 */
  compactions: CompactionAnchor[];
  /** 后台任务回调与目标卡片的锚点，口径同压缩边界 */
  notices: NoticeAnchor[];
}

/** 对话流里的压缩边界：锚在已投影消息序位 afterIndex 处。 */
export interface CompactionAnchor {
  afterIndex: number;
  seq: number;
  summary: string;
  tokensBefore: number;
  createdAt: string;
}

/** 对话流里一张卡片的内容：后台任务回调，或目标的一次变化 / 续跑。 */
export type NoticeBody =
  | { kind: "job"; job: JobSnapshot }
  | { kind: "goal"; goal: GoalNotice };

/** 历史里的卡片：锚在已投影消息序位 afterIndex 处。 */
export type NoticeAnchor = NoticeBody & { afterIndex: number; ts?: string };

/** 同一张卡（任务 + 终态时间；目标 + 事件 + 版本）实时到达的与历史里读到的靠它认出是同一张。 */
export const noticeKey = (n: NoticeBody): string =>
  n.kind === "job"
    ? `job:${n.job.id}@${n.job.endedAt ?? ""}`
    : goalNoticeKey(n.goal);

const noticeSortId = (n: NoticeBody): string =>
  n.kind === "job" ? n.job.id : n.goal.goalId;

export const listSessions = (token: string | null) =>
  get(
    "/api/v1/sessions",
    token,
    (b: { sessions: SessionInfo[] }) => b.sessions,
  );

// 服务端上限 200 条；默认 50 条恰好等于快照窗口，取不到更早的历史。
export const listMessages = (
  id: string,
  token: string | null,
  before?: string,
) =>
  get(
    `/api/v1/sessions/${enc(id)}/messages?limit=200${before ? `&before=${enc(before)}` : ""}`,
    token,
    (b: Page) => {
      if (!Array.isArray(b.messages)) throw new Error("bad page");
      return {
        messages: b.messages,
        nextBefore: b.nextBefore ?? null,
        compactions: Array.isArray(b.compactions) ? b.compactions : [],
        notices: Array.isArray(b.notices) ? b.notices : [],
      };
    },
  );

export const createSession = (
  token: string | null,
  body: { directoryId?: string; promptPresetId?: string },
) =>
  call("POST", "/api/v1/sessions", token, body, (b: { id: string }) => {
    if (typeof b.id !== "string") throw new Error("shape");
    return b;
  });

/** B20/P01 指令列表的一项：当前分支上的用户原文（服务端已过滤无文字的消息）。 */
export interface UserMessageEntry {
  entryId: string;
  text: string;
  timestamp: string | null;
}

// 当前分支的全部用户输入，最早在前；节点与本地消息按序位映射，长会话可先取全量再按需加载历史。
export const getUserMessages = (id: string, token: string | null) =>
  get(
    `/api/v1/sessions/${enc(id)}/user-messages`,
    token,
    (b: { messages?: unknown }) => {
      if (!Array.isArray(b.messages)) throw new Error("bad list");
      return b.messages.flatMap((m): UserMessageEntry[] => {
        const d = m as {
          entryId?: unknown;
          text?: unknown;
          timestamp?: unknown;
        } | null;
        return typeof d?.entryId === "string" && typeof d.text === "string"
          ? [
              {
                entryId: d.entryId,
                text: d.text,
                timestamp: typeof d.timestamp === "string" ? d.timestamp : null,
              },
            ]
          : [];
      });
    },
  );

// 子会话拓扑。
export interface TopologyNode {
  id: string;
  name: string | null;
  parentId: string | null;
  depth: number;
  state: "running" | "idle" | "done" | "failed" | "interrupted";
  task: string | null;
  denied: number;
  deniedReasons: string[];
}

export const getTopology = (token: string | null) =>
  get("/api/v1/topology", token, (b: { nodes: TopologyNode[] }) => b.nodes);

// ---- 历史分页 ----

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      args: string;
      result?: string;
      isError?: boolean;
      // 运行中的实时输出，仅来自 tool.updated，不属于历史。
      live?: string;
      // 嵌套调用（如 call_tool 转发的）：挂在父工具块内部，与父块同生命周期
      children?: {
        id: string;
        name: string;
        args?: string;
        result?: string;
        isError?: boolean;
        durationMs?: number;
      }[];
    };

export interface Known {
  role: string;
  text: string;
  /** 消息时间（ISO 8601）；实时消息由服务端落定时间给出 */
  ts?: string;
  blocks?: Block[];
  attachments?: MessageAttachment[];
}

// 已加载的更早历史：index 连续递增；nextBefore 是继续往前翻的游标，null 表示已到最早。
// compactions 是分支上的压缩边界（锚点在 afterIndex 处），与分页无关，按 seq 去重合并；
// notices 是后台任务回调与目标卡片，同样与分页无关，按 noticeKey 去重合并。
export interface Loaded {
  older: ChatEntry[];
  nextBefore: string | null;
  compactions: CompactionAnchor[];
  notices: NoticeAnchor[];
}

export type HistoryResult = ({ ok: true } & Loaded) | { ok: false };

/** 按 seq 合并两批压缩锚点（同一批可能因分页重复返回）。 */
export function mergeCompactions(
  a: readonly CompactionAnchor[],
  b: readonly CompactionAnchor[],
): CompactionAnchor[] {
  const bySeq = new Map(a.map((c) => [c.seq, c]));
  for (const c of b) bySeq.set(c.seq, c);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

/** 合并两批卡片锚点（同一批可能因分页重复返回）。 */
export function mergeNotices(
  a: readonly NoticeAnchor[],
  b: readonly NoticeAnchor[],
): NoticeAnchor[] {
  const byKey = new Map(a.map((n) => [noticeKey(n), n]));
  for (const n of b) byKey.set(noticeKey(n), n);
  return [...byKey.values()].sort(
    (x, y) =>
      x.afterIndex - y.afterIndex ||
      (x.ts ?? "").localeCompare(y.ts ?? "") ||
      noticeSortId(x).localeCompare(noticeSortId(y)),
  );
}

type Anchors = Pick<Loaded, "compactions" | "notices">;

// 压缩边界与回调卡片两类锚点一起合并
const anchors = (a: Anchors, b: Anchors): Anchors => ({
  compactions: mergeCompactions(a.compactions, b.compactions),
  notices: mergeNotices(a.notices, b.notices),
});

// 快照带窗口第一条的序位 startIndex，与 REST 的 index 同一套：窗口之前的历史就是页里 index < startIndex 的部分，
// 不需要比对内容。页若没覆盖到 startIndex - 1（服务端落后，或快照已过时），重取而不是猜。
export async function loadOlder(
  fetchTail: () => Promise<Result<Page>>,
  startIndex: number,
  tries = 3,
): Promise<HistoryResult> {
  for (let i = 0; i < tries; i++) {
    const r = await fetchTail();
    if (!r.ok) return { ok: false };
    const older = r.data.messages.filter((m) => m.index < startIndex);
    if (startIndex === 0)
      return {
        ok: true,
        older: [],
        nextBefore: null,
        compactions: r.data.compactions,
        notices: r.data.notices,
      };
    if (older[older.length - 1]?.index !== startIndex - 1) continue;
    return {
      ok: true,
      older,
      nextBefore: r.data.nextBefore,
      compactions: r.data.compactions,
      notices: r.data.notices,
    };
  }
  return { ok: false };
}

// 重新对齐后的合并：已加载的历史是累积的，不能被新页替换（resync/重连后中间不会少消息）。
// 两段在 index 上相接或重叠才合并，重叠处以新页为准；中间有缺口（断开期间新增超过一页）
// 时拼不出连续序列，改用新页，更早的部分由"加载更早"补回。
export function afterTail(prev: Loaded, fresh: Loaded): Loaded {
  const first = (l: Loaded) => l.older[0]?.index ?? 0;
  const last = (l: Loaded) => l.older[l.older.length - 1]?.index ?? -1;
  if (prev.older.length === 0 || fresh.older.length === 0) {
    return prev.older.length === 0
      ? {
          ...fresh,
          ...anchors(prev, fresh),
        }
      : {
          ...prev,
          ...anchors(prev, fresh),
        };
  }
  if (first(fresh) > last(prev) + 1 || first(prev) > last(fresh) + 1)
    return {
      ...fresh,
      ...anchors(prev, fresh),
    };

  const byIndex = new Map(prev.older.map((m) => [m.index, m]));
  for (const m of fresh.older) byIndex.set(m.index, m);
  const older = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return {
    older,
    nextBefore: first(prev) < first(fresh) ? prev.nextBefore : fresh.nextBefore,
    ...anchors(prev, fresh),
  };
}

// 点"加载更早"后的拼接。请求期间游标已变（已被重新对齐替换）说明这页接不上，丢弃。
export function afterEarlier(prev: Loaded, cursor: string, page: Page): Loaded {
  if (prev.nextBefore !== cursor) return prev;
  const firstIndex = prev.older[0]?.index ?? Number.POSITIVE_INFINITY;
  return {
    older: [
      ...page.messages.filter((m) => m.index < firstIndex),
      ...prev.older,
    ],
    nextBefore: page.nextBefore,
    ...anchors(prev, page),
  };
}
