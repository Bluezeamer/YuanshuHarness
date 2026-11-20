import {
  type SessionEntry,
  SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { JobSnapshot } from "../job/messages.js";
import type { AttachmentRef } from "../session/attachments.js";
import { splitAttachmentMarkers } from "../session/attachments.js";
import {
  type Block,
  blocksOf,
  type ChatRole,
  cut,
  isChatRole,
  messageText,
  TOOL_RESULT_MAX,
} from "../session/events.js";
import type { GoalNotice } from "../session/goal.js";
import { readHeader } from "./sessions.js";

export interface ChatEntry {
  index: number;
  role: ChatRole;
  text: string;
  // 会话条目的时间（ISO 8601），对话页操作行显示用。
  ts?: string;
  blocks?: Block[];
  // 用户消息的附件引用；text 里已不含 `[attach_file]` 标记。
  attachments?: AttachmentRef[];
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

type Entry = {
  type: string;
  id?: string;
  message?: Record<string, unknown>;
  timestamp?: string;
  summary?: string;
  tokensBefore?: number;
  firstKeptEntryId?: string;
  systemMessage?: { content?: unknown };
  customType?: string;
  details?: unknown;
  /** 只出卡片的 custom 条目（不进模型上下文）带的数据。 */
  data?: unknown;
};

/** 分支条目（history 投影只关心其中几个字段）；live 会话的 getBranch() 也能直接喂进来。 */
export type BranchEntry = Entry;

// 文件头校验过才交给 SDK：SDK 的 open 会重写空文件并换 id。
function openBranch(file: string, dir: string, id: string): Entry[] {
  if (readHeader(file, id) === null) throw new Error("会话文件头无效");
  return SessionManager.open(file, dir).getBranch() as unknown as Entry[];
}

// 当前分支上的 user/assistant 消息，序位从 0 起。
export function readMessages(
  file: string,
  dir: string,
  id: string,
): ChatEntry[] {
  return projectMessages(openBranch(file, dir, id));
}

// 这条分支条目会不会进对话投影（messages 接口的序位只数这些）。projectMessages 与
// projectNotices 共用它，两边的 afterIndex 口径才一定一致。
const projected = (e: Entry): boolean =>
  e.type === "message" && isChatRole(e.message?.role);

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

// 后台任务回调消息里带的快照；不是这种消息就是 undefined。
const noticeJob = (e: Entry): JobSnapshot | undefined => {
  if (e.type !== "custom_message" || e.customType !== "yuanshu.subagent")
    return undefined;
  return asRecord(asRecord(e.details)?.job) as JobSnapshot | undefined;
};

// 目标卡片：注入消息是 custom_message（进模型上下文），其余是只出卡片的 custom 条目。
const noticeGoal = (e: Entry): GoalNotice | undefined => {
  if (e.customType !== "yuanshu.goal") return undefined;
  if (e.type === "custom_message")
    return asRecord(asRecord(e.details)?.goal) as GoalNotice | undefined;
  if (e.type !== "custom") return undefined;
  return asRecord(asRecord(e.data)?.goal) as GoalNotice | undefined;
};

export type NoticeInfo =
  | { afterIndex: number; ts?: string; kind: "job"; job: JobSnapshot }
  | { afterIndex: number; ts?: string; kind: "goal"; goal: GoalNotice };

// 当前分支上的卡片锚点（界面按 afterIndex 在对话流里插入）；两种持久化形态都认。
export function projectNotices(path: Entry[]): NoticeInfo[] {
  const out: NoticeInfo[] = [];
  let count = 0;
  for (const e of path) {
    const ts = e.timestamp ? { ts: e.timestamp } : {};
    const job = noticeJob(e);
    const goal = job ? undefined : noticeGoal(e);
    if (job) out.push({ afterIndex: count, ...ts, kind: "job", job });
    else if (goal) out.push({ afterIndex: count, ...ts, kind: "goal", goal });
    if (projected(e)) count += 1;
  }
  return out;
}

export function readNotices(
  file: string,
  dir: string,
  id: string,
): NoticeInfo[] {
  return projectNotices(openBranch(file, dir, id));
}

// 与 readMessages 同一套投影，只是输入是已读出的分支条目（live 会话回退后重播历史用）。
export function projectMessages(path: Entry[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  const tools = new Map<string, Extract<Block, { type: "tool" }>>();
  for (const e of path) {
    const m = e.message;
    if (e.type !== "message" || !m) continue;
    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      const t = tools.get(m.toolCallId);
      if (t) {
        t.result = cut(messageText(m.content), TOOL_RESULT_MAX);
        t.isError = m.isError === true;
      }
      continue;
    }
    if (!isChatRole(m.role)) continue;
    const blocks = m.role === "assistant" ? blocksOf(m.content) : undefined;
    for (const b of blocks ?? []) if (b.type === "tool") tools.set(b.id, b);
    // 用户消息末尾的附件标记不进 text，改投影成 attachments。
    const parsed =
      m.role === "user"
        ? splitAttachmentMarkers(messageText(m.content))
        : { text: messageText(m.content), attachments: undefined };
    out.push({
      index: out.length,
      role: m.role,
      text: parsed.text,
      ...(e.timestamp ? { ts: e.timestamp } : {}),
      ...(blocks ? { blocks } : {}),
      ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
    });
  }
  return out;
}

export interface CompactionInfo {
  /** 当前分支上的序号，按时间从 1 起。 */
  seq: number;
  createdAt: string;
  summary: string;
  tokensBefore: number;
  /** messages 接口的锚点：该压缩条目之前已投影的 user/assistant 条数。 */
  afterIndex: number;
}

/** 压缩前的完整快照：messages 是上下文里的原始 pi 消息对象（不含 system），system 单独给。 */
export interface CompactionSnapshot {
  system?: unknown;
  messages: unknown[];
}

/** 压缩条目 + 重建出来的压缩前快照（calls 详情与 compactions 列表用）。 */
export interface CompactionDetail extends CompactionInfo {
  /** 快照里的对话项数，等于该段最后一次调用的区间右端。 */
  messageCount: number;
  snapshot: CompactionSnapshot;
}

type CompactionSite = {
  entry: Entry;
  /** 在分支 path 里的下标。 */
  index: number;
  /** 分支上紧邻的上一次压缩；没有时为 null。 */
  prev: Entry | null;
  prevIndex: number;
};

type CompactionScan = {
  /** 按时间排好的压缩条目摘要。 */
  infos: CompactionInfo[];
  sites: CompactionSite[];
};

// 扫一遍分支：收集压缩条目与其「上一次压缩」，同时累计 messages 接口的锚点。
function scanCompactions(path: Entry[]): CompactionScan {
  const sites: CompactionSite[] = [];
  const infos: CompactionInfo[] = [];
  let prev: Entry | null = null;
  let prevIndex = -1;
  let count = 0;
  path.forEach((entry, index) => {
    if (projected(entry)) count += 1;
    if (entry.type !== "compaction") return;
    infos.push({
      seq: infos.length + 1,
      createdAt: entry.timestamp ?? "",
      summary: entry.summary ?? "",
      tokensBefore: entry.tokensBefore ?? 0,
      afterIndex: count,
    });
    sites.push({ entry, index, prev, prevIndex });
    prev = entry;
    prevIndex = index;
  });
  return { infos, sites };
}

// 条目投影成上下文消息；system 不进 messages（快照单独给 system）。
function contextMessages(entries: Entry[]): unknown[] {
  const out: unknown[] = [];
  for (const e of entries)
    for (const m of sessionEntryToContextMessages(
      e as unknown as SessionEntry,
    )) {
      if ((m as { role?: unknown }).role !== "system") out.push(m);
    }
  return out;
}

/**
 * 压缩前的完整快照：口径同 SDK 的 buildContextEntries——先把上一次压缩的摘要放在最前，
 * 再放它保留的消息（firstKeptEntryId 起），最后是它之后的消息；第一次压缩则是分支起点到它之前的全部消息。
 * 摘要消息由 SDK 投影生成，其余消息都是 JSONL 里的原始对象——条数对应请求里的对话项数。
 */
function snapshotOf(path: Entry[], site: CompactionSite): CompactionSnapshot {
  let messages: unknown[];
  if (site.prev === null) {
    messages = contextMessages(path.slice(0, site.index));
  } else {
    // 保留点找不到（分支被改写等）时按「没有保留的消息」处理，与 SDK 的 buildContextEntries 一致。
    const keptAt = site.prev.firstKeptEntryId
      ? path.findIndex((e) => e.id === site.prev?.firstKeptEntryId)
      : -1;
    messages = [
      ...contextMessages([site.prev]),
      ...(keptAt < 0
        ? []
        : contextMessages(path.slice(keptAt, site.prevIndex))),
      ...contextMessages(path.slice(site.prevIndex + 1, site.index)),
    ];
  }
  const system = site.entry.systemMessage?.content;
  return {
    ...(system === undefined || system === null ? {} : { system }),
    messages,
  };
}

/** 当前分支上的压缩条目摘要，按时间从 1 编号；messages / calls 列表按它定位压缩段。 */
export function readCompactions(
  file: string,
  dir: string,
  id: string,
): CompactionInfo[] {
  return scanCompactions(openBranch(file, dir, id)).infos;
}

/** 压缩条目 + 各自的压缩前快照；只给 calls 详情与 compactions 列表用，列表接口不要碰。 */
export function readCompactionDetails(
  file: string,
  dir: string,
  id: string,
): CompactionDetail[] {
  const path = openBranch(file, dir, id);
  const { infos, sites } = scanCompactions(path);
  return infos.map((info, i) => {
    const snapshot = snapshotOf(path, sites[i] as CompactionSite);
    return { ...info, messageCount: snapshot.messages.length, snapshot };
  });
}

// 当前分支上的工具输出摘要（每条截断到 max 字符），供自动审核当不可信上下文；不进历史接口。
export function readToolOutputs(
  file: string,
  dir: string,
  id: string,
  max = 200,
): string[] {
  const out: string[] = [];
  for (const e of openBranch(file, dir, id)) {
    const m = e.message;
    if (e.type !== "message" || m?.role !== "toolResult") continue;
    const t = messageText(m.content).replace(/\s+/g, " ").trim();
    out.push(`工具输出：${t.length > max ? `${t.slice(0, max)}…` : t}`);
  }
  return out;
}

// 末尾最后一条带工具调用的助手消息，其调用是否有没拿到结果的。
export function hasDanglingToolCall(
  file: string,
  dir: string,
  id: string,
): boolean {
  const msgs = openBranch(file, dir, id)
    .filter((e) => e.type === "message" && e.message)
    .map((e) => e.message as Record<string, unknown>);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "assistant") continue;
    const calls = (Array.isArray(m.content) ? m.content : []).flatMap(
      (b: { type?: string; id?: string }) =>
        b?.type === "toolCall" && typeof b.id === "string" ? [b.id] : [],
    );
    if (calls.length === 0) return false;
    const answered = new Set(
      msgs
        .slice(i + 1)
        .filter((x) => x.role === "toolResult")
        .map((x) => x.toolCallId),
    );
    return calls.some((c) => !answered.has(c));
  }
  return false;
}

export const encodeCursor = (index: number): string =>
  Buffer.from(String(index)).toString("base64url");

function decodeCursor(cursor: string, max: number): number | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const s = Buffer.from(cursor, "base64url").toString();
  if (!/^(0|[1-9][0-9]*)$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
}

export type PageResult =
  | { ok: true; messages: ChatEntry[]; nextBefore: string | null }
  | { ok: false };

// 游标是"严格小于该序位"的上界；序位只增不变，所以新消息追加不会让游标错位。
export function pageMessages(
  all: ChatEntry[],
  before: string | undefined,
  limitRaw: string | undefined,
): PageResult {
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    if (!/^[0-9]+$/.test(limitRaw)) return { ok: false };
    limit = Number(limitRaw);
    if (limit < 1 || limit > MAX_LIMIT) return { ok: false };
  }
  const end =
    before === undefined ? all.length : decodeCursor(before, all.length);
  if (end === null) return { ok: false };
  const start = Math.max(0, end - limit);
  return {
    ok: true,
    messages: all.slice(start, end),
    nextBefore: start > 0 ? encodeCursor(start) : null,
  };
}
