// P09 分叉点映射：把界面上的 assistant 消息映射到服务端会话树里的 entryId。
// 界面只持有「已加载的更早历史 + 快照窗口」这段连续后缀的完整对话；树里是整条分支。
// 两者按 assistant 序号对齐：树的 assistant 总数减去已加载的 assistant 数，就是未加载前缀的偏移。
// 工具调用-only 的 assistant 消息（没有正文）在两边都是正式消息，照常计数。

import type { SessionTree, SessionTreeNode } from "../../../api/session-fork";

/** 参与映射的最小消息形状：更早历史条目带绝对序位 index，窗口消息没有 */
export interface ForkMessage {
  role?: string;
  index?: number;
}

/** 目标消息在已加载区间里的 assistant 序号（1 起，含自身）与已加载 assistant 总数 */
export interface ForkTarget {
  ordinal: number;
  loadedAssistants: number;
}

const isAssistant = (m: ForkMessage | undefined): boolean =>
  m?.role === "assistant";

/**
 * 定位界面消息在「已加载消息」里的位置并算出 assistant 序号。
 * 窗口消息按对象身份定位（Stream 直接把 state.messages 的元素传给 Message），
 * 更早历史条目按 index 定位（重渲染后身份可能不保证）。
 * 找不到（不是助手消息 / 不在已加载区间）返回 null。
 */
export function forkTargetOf(
  m: ForkMessage,
  older: readonly ForkMessage[],
  messages: readonly ForkMessage[],
): ForkTarget | null {
  if (!isAssistant(m)) return null;
  const loaded = [...older, ...messages];
  let at = messages.indexOf(m);
  if (at >= 0) {
    at += older.length;
  } else {
    const index = m.index;
    if (typeof index !== "number") return null;
    at = older.findIndex((o) => o.index === index);
    if (at < 0) return null;
  }
  const ordinal = loaded.slice(0, at + 1).filter(isAssistant).length;
  return { ordinal, loadedAssistants: loaded.filter(isAssistant).length };
}

/**
 * 当前分支上的 assistant message 节点 id，按根到叶顺序。
 * activePath 是叶到根，反转后按节点类型/角色过滤。
 */
export function assistantEntryIds(tree: SessionTree): string[] {
  const byId = new Map<string, SessionTreeNode>();
  const walk = (nodes: readonly SessionTreeNode[]): void => {
    for (const n of nodes) {
      byId.set(n.id, n);
      walk(n.children);
    }
  };
  walk(tree.nodes);
  const ids: string[] = [];
  for (const id of [...tree.activePath].reverse()) {
    const node = byId.get(id);
    if (node?.type === "message" && node.role === "assistant") ids.push(id);
  }
  return ids;
}

/**
 * assistant 序号 → entryId；序号落到未加载前缀或树里没有对应节点时返回 null。
 * loadedAssistants 比树里的 assistant 还多说明界面与服务端分支不一致，同样返回 null。
 */
export function forkEntryId(
  tree: SessionTree,
  target: ForkTarget,
): string | null {
  const ids = assistantEntryIds(tree);
  const offset = ids.length - target.loadedAssistants;
  if (offset < 0 || target.ordinal < 1) return null;
  return ids[offset + target.ordinal - 1] ?? null;
}
