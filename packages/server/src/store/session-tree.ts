import {
  type SessionEntry,
  SessionManager,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import { splitAttachmentMarkers } from "../session/attachments.js";
import { messageText } from "../session/events.js";
import { readHeader } from "./sessions.js";

// 树里只出现对话节点；状态条目（模型切换、标签、标题等）折叠进最近的祖先。
const CONVERSATIONS = new Set(["message", "compaction", "branch_summary"]);

export type TreeRole = "user" | "assistant" | "toolResult" | "system";
const ROLES = new Set<string>(["user", "assistant", "toolResult", "system"]);

export interface TreeViewNode {
  id: string;
  parentId: string | null;
  type: string;
  role?: TreeRole;
  // 首行文本，最多 PREVIEW_MAX 字。
  preview: string;
  timestamp: string;
  label?: string;
  children: TreeViewNode[];
}

/** 会话树：nodes 只含对话节点；leafId / activePath 也映射到对话节点，否则叶子常是标题等状态条目。 */
export interface SessionTreeView {
  leafId: string | null;
  activePath: string[];
  nodes: TreeViewNode[];
}

/** B20 指令列表的一项：整条用户原文，不截断。 */
export interface ForkUserMessage {
  entryId: string;
  text: string;
  timestamp: string | null;
}

export const PREVIEW_MAX = 60;

type MessageLike = {
  role?: unknown;
  content?: unknown;
};

const isConversation = (e: SessionEntry): boolean => CONVERSATIONS.has(e.type);

const messageOf = (e: SessionEntry): MessageLike | undefined =>
  e.type === "message" ? (e.message as MessageLike) : undefined;

// 首行文本（跳过开头的空行），超长按码点截断到 max 字。
function firstLine(text: string, max: number): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("")}…`;
}

const hasToolCall = (content: unknown): boolean =>
  Array.isArray(content) &&
  content.some((b) => (b as { type?: unknown } | null)?.type === "toolCall");

const MESSAGE_FALLBACK: Record<string, string> = {
  user: "（空消息）",
  assistant: "（空消息）",
  toolResult: "（工具结果）",
};

function messagePreview(role: unknown, content: unknown): string {
  // 用户消息末尾的附件标记不属于正文，预览里不显示。
  const text =
    role === "user"
      ? splitAttachmentMarkers(messageText(content)).text
      : messageText(content);
  const line = firstLine(text, PREVIEW_MAX);
  if (line !== "") return line;
  if (role === "assistant" && hasToolCall(content)) return "（工具调用）";
  return MESSAGE_FALLBACK[String(role)] ?? "（空消息）";
}

function previewOf(e: SessionEntry): string {
  switch (e.type) {
    case "compaction":
    case "branch_summary":
      return firstLine(e.summary, PREVIEW_MAX);
    case "message": {
      const m = messageOf(e);
      return messagePreview(m?.role, m?.content);
    }
    default:
      return "";
  }
}

// 跳过的状态条目的子节点挂到最近的对话祖先上，树结构保持连通。
function projectNodes(
  nodes: SessionTreeNode[],
  parentId: string | null,
  sink: TreeViewNode[],
): void {
  for (const node of nodes) {
    if (!isConversation(node.entry)) {
      projectNodes(node.children, parentId, sink);
      continue;
    }
    const role = messageOf(node.entry)?.role;
    const view: TreeViewNode = {
      id: node.entry.id,
      parentId,
      type: node.entry.type,
      ...(typeof role === "string" && ROLES.has(role)
        ? { role: role as TreeRole }
        : {}),
      preview: previewOf(node.entry),
      timestamp: node.entry.timestamp,
      ...(node.label === undefined ? {} : { label: node.label }),
      children: [],
    };
    sink.push(view);
    projectNodes(node.children, node.entry.id, view.children);
  }
}

// 当前 leaf 沿原始 parent 链上溯，只留下对话节点（leaf 常是标题等状态条目）。
export function activePathOf(manager: SessionManager): {
  leafId: string | null;
  activePath: string[];
} {
  const activePath: string[] = [];
  let id = manager.getLeafId();
  while (id !== null) {
    const entry = manager.getEntry(id);
    if (!entry) break;
    if (isConversation(entry)) activePath.push(entry.id);
    id = entry.parentId;
  }
  return { leafId: activePath[0] ?? null, activePath };
}

/** 当前 leaf 映射到最近的对话节点；导航结果与树用同一套口径。 */
export function conversationLeafId(manager: SessionManager): string | null {
  return activePathOf(manager).leafId;
}

/** 从 pi 的 getTree()/getLeafId() 投影出对外的树；live 会话与只读文件打开都走这里。 */
export function treeOf(manager: SessionManager): SessionTreeView {
  const nodes: TreeViewNode[] = [];
  projectNodes(manager.getTree(), null, nodes);
  return { ...activePathOf(manager), nodes };
}

/** 当前分支上的用户消息（按分支顺序，全量不截断），B20 回退选择用。 */
export function userMessagesOf(manager: SessionManager): ForkUserMessage[] {
  const out: ForkUserMessage[] = [];
  for (const entry of manager.getBranch()) {
    const m = messageOf(entry);
    if (m?.role !== "user") continue;
    const text = messageText(m.content);
    // 与 pi 的 getUserMessagesForForking 一致：没有文字的消息不进列表。
    if (text.trim() === "") continue;
    out.push({
      entryId: entry.id,
      text,
      timestamp: entry.timestamp ?? null,
    });
  }
  return out;
}

// 文件头校验过才交给 SDK：SDK 的 open 会重写空文件并换 id。
function openSession(file: string, dir: string, id: string): SessionManager {
  if (readHeader(file, id) === null) throw new Error("会话文件头无效");
  return SessionManager.open(file, dir);
}

export function readSessionTree(
  file: string,
  dir: string,
  id: string,
): SessionTreeView {
  return treeOf(openSession(file, dir, id));
}

export function readUserMessages(
  file: string,
  dir: string,
  id: string,
): ForkUserMessage[] {
  return userMessagesOf(openSession(file, dir, id));
}
