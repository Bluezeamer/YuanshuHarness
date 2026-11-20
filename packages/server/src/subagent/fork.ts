// fork 的分叉点（subagent.md §4）：发出这次 spawn_subagent 的那条 assistant 消息的上一条。
// 整条 assistant 消息不进子代理的上下文，所以历史里没有 spawn 调用，也不用补占位；当前轮前面已读的内容全部保留。

/** 会话分支上的条目：fork 看 message，读冻结物看 custom。 */
export interface BranchEntry {
  id: string;
  parentId: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown };
}

/** 工具调用 id 形如 `call_x` 或 `call_x/1`（经 call_tool / job_start 的内层调用），后者取斜杠前的外层 id。 */
const outerId = (toolCallId: string) => toolCallId.split("/")[0] as string;

const hasCall = (content: unknown, id: string): boolean =>
  Array.isArray(content) &&
  content.some(
    (c: { type?: string; id?: string }) => c.type === "toolCall" && c.id === id,
  );

/** 分叉点的条目 id；找不到发起调用的 assistant 消息，或它是第一条（前面没有任何历史）返回 null。 */
export function forkPoint(
  branch: readonly BranchEntry[],
  toolCallId: string,
): string | null {
  const want = outerId(toolCallId);
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as BranchEntry;
    if (
      e.type === "message" &&
      e.message?.role === "assistant" &&
      hasCall(e.message.content, want)
    )
      return e.parentId;
  }
  return null;
}
