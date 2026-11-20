// B20 历史节点：会话树 / 回退导航的接口客户端。
// 指令列表（user-messages）复用 sessions.ts 的 getUserMessages：同一份数据 P01 快速跳转也在用。
import { call, enc, get } from "./http";
import { type EditableContent, parseEditable } from "./sessions";

export type TreeRole = "user" | "assistant" | "toolResult" | "system";

/** 树里只出现对话节点；模型切换、标签、标题等状态条目由服务端折叠进最近的对话祖先。 */
export interface TreeNode {
  id: string;
  parentId: string | null;
  /** message / compaction / branch_summary */
  type: string;
  role?: TreeRole;
  /** 首行预览（服务端截断到 60 字）；compaction / branch_summary 是摘要首行，种类看 type */
  preview: string;
  timestamp: string;
  label?: string;
  children: TreeNode[];
}

export interface SessionTree {
  /** 当前 leaf 映射到的最近对话节点 */
  leafId: string | null;
  /** 当前分支从 leaf 到 root 的节点 id（leaf 在前） */
  activePath: string[];
  nodes: TreeNode[];
}

export interface NavigateResult {
  /** 目标是 user 消息时的指令原文（含附件）；用于回填输入框 */
  editor?: EditableContent;
  leafId: string | null;
}

const ROLES = new Set<string>(["user", "assistant", "toolResult", "system"]);

// 递归校验节点：形状不对就抛错，由 get/call 统一转成失败，不把脏数据带进界面。
function treeNodeOf(v: unknown): TreeNode {
  const n = v as Partial<TreeNode> | null;
  if (typeof n?.id !== "string" || n.id === "")
    throw new Error("bad tree node");
  if (typeof n.preview !== "string") throw new Error("bad tree node");
  return {
    id: n.id,
    parentId: typeof n.parentId === "string" ? n.parentId : null,
    type: typeof n.type === "string" ? n.type : "message",
    ...(typeof n.role === "string" && ROLES.has(n.role)
      ? { role: n.role as TreeRole }
      : {}),
    preview: n.preview,
    timestamp: typeof n.timestamp === "string" ? n.timestamp : "",
    ...(typeof n.label === "string" ? { label: n.label } : {}),
    children: Array.isArray(n.children) ? n.children.map(treeNodeOf) : [],
  };
}

export const getSessionTree = (id: string, token: string | null) =>
  get(
    `/api/v1/sessions/${enc(id)}/tree`,
    token,
    (b: {
      leafId?: unknown;
      activePath?: unknown;
      nodes?: unknown;
    }): SessionTree => {
      if (!Array.isArray(b.nodes) || !Array.isArray(b.activePath))
        throw new Error("bad tree");
      return {
        leafId: typeof b.leafId === "string" ? b.leafId : null,
        activePath: b.activePath.filter(
          (x): x is string => typeof x === "string",
        ),
        nodes: b.nodes.map(treeNodeOf),
      };
    },
  );

// 回退到历史节点：409 表示运行中 / 压缩中（CallResult 的 conflict）。
// 成功后服务端会向会话 WS 广播整份快照替换，这里只负责回填 editor。
export const navigateSession = (
  id: string,
  entryId: string,
  token: string | null,
) =>
  call(
    "POST",
    `/api/v1/sessions/${enc(id)}/navigate`,
    token,
    { entryId },
    (b: { editor?: unknown; leafId?: unknown }): NavigateResult => {
      const editor = parseEditable(b.editor);
      return {
        ...(editor ? { editor } : {}),
        leafId: typeof b.leafId === "string" ? b.leafId : null,
      };
    },
  );
