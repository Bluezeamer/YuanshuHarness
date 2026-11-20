// P09 会话分叉：会话树（把界面消息映射到 entryId）与分叉接口。
// 不放进 sessions.ts：B20 线也在改那个文件，两个接口独立成新文件避免冲突。

import { type CallResult, call, enc, get, type Result } from "./http";

export type SessionTreeRole = "user" | "assistant" | "toolResult" | "system";
const ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "toolResult",
  "system",
]);

/** 树节点：只含对话节点（message / compaction / branch_summary） */
export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  type: string;
  role?: SessionTreeRole;
  /** 首行文本，服务端已截断 */
  preview: string;
  timestamp: string;
  label?: string;
  children: SessionTreeNode[];
}

/** 会话树：activePath 是当前 leaf 到根的 entry id 列表（叶在前） */
export interface SessionTree {
  leafId: string | null;
  activePath: string[];
  nodes: SessionTreeNode[];
}

export interface ForkedSession {
  id: string;
  title: string;
}

function pickNode(raw: unknown): SessionTreeNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.type !== "string") return null;
  const role = typeof d.role === "string" && ROLES.has(d.role) ? d.role : null;
  return {
    id: d.id,
    parentId: typeof d.parentId === "string" ? d.parentId : null,
    type: d.type,
    ...(role === null ? {} : { role: role as SessionTreeRole }),
    preview: typeof d.preview === "string" ? d.preview : "",
    timestamp: typeof d.timestamp === "string" ? d.timestamp : "",
    ...(typeof d.label === "string" ? { label: d.label } : {}),
    children: Array.isArray(d.children)
      ? d.children.flatMap((c) => pickNode(c) ?? [])
      : [],
  };
}

export const getSessionTree = (
  id: string,
  token: string | null,
): Promise<Result<SessionTree>> =>
  get(
    `/api/v1/sessions/${enc(id)}/tree`,
    token,
    (b: { leafId?: unknown; activePath?: unknown; nodes?: unknown }) => {
      if (!Array.isArray(b.activePath) || !Array.isArray(b.nodes))
        throw new Error("bad tree");
      return {
        leafId: typeof b.leafId === "string" ? b.leafId : null,
        activePath: b.activePath.filter(
          (x): x is string => typeof x === "string",
        ),
        nodes: b.nodes.flatMap((n) => pickNode(n) ?? []),
      };
    },
  );

/** 以 entryId 为分叉点复制出一个全新独立会话；不复制布局（由 web 端决定） */
export const forkSession = (
  id: string,
  entryId: string,
  token: string | null,
): Promise<CallResult<ForkedSession>> =>
  call(
    "POST",
    `/api/v1/sessions/${enc(id)}/fork`,
    token,
    { entryId },
    (b: { id?: unknown; title?: unknown }) => {
      if (typeof b.id !== "string") throw new Error("shape");
      return { id: b.id, title: typeof b.title === "string" ? b.title : b.id };
    },
  );
