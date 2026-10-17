import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type ChatRole, messageText } from "../session/events.js";
import { readHeader } from "./sessions.js";

export interface ChatEntry {
  index: number;
  role: ChatRole;
  text: string;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

type Entry = { type: string; message?: Record<string, unknown> };

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
  const out: ChatEntry[] = [];
  for (const e of openBranch(file, dir, id)) {
    const m = e.message;
    if (e.type !== "message" || !m) continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push({ index: out.length, role: m.role, text: messageText(m.content) });
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
