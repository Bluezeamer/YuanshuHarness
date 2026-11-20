// P09 分叉动作编排：拉会话树 → assistant 序号映射到 entryId → fork → 在当前窗口里打开新会话。
// 依赖全部注入，便于单测；真实 API client 在 api/session-fork.ts，store 动作在 store/layoutStore.ts。

import type { CallResult, Result } from "../../../api/http";
import type { ForkedSession, SessionTree } from "../../../api/session-fork";
import type { ToastTone } from "../../../ui/Toast";
import { type ForkTarget, forkEntryId } from "../model/forkEntry";
import type { LayoutStore } from "../store/layoutStore";

export interface ForkDeps {
  getTree(
    sessionId: string,
    token: string | null,
  ): Promise<Result<SessionTree>>;
  fork(
    sessionId: string,
    entryId: string,
    token: string | null,
  ): Promise<CallResult<ForkedSession>>;
  store: Pick<LayoutStore, "adoptSession" | "showSession">;
  token: string | null;
  notify(message: string, tone: ToastTone): void;
  /** 通知壳刷新会话列表：新会话要先出现在列表里，左轨才能选中它 */
  changed?(sessionId: string): void;
}

export interface ForkRequest {
  sessionId: string;
  /** 目标 assistant 消息在已加载对话里的序号（见 model/forkEntry） */
  target: ForkTarget;
}

const TREE_FAILED = "读取会话树失败，无法分叉";
const ENTRY_MISSING = "找不到这条消息对应的分叉点";
const SWITCH_FAILED = "已分叉，但切换到新会话失败";

function forkError(r: { kind: string }): string {
  switch (r.kind) {
    case "network":
      return "网络错误，分叉失败";
    case "not_found":
      return "会话或分叉点不存在，分叉失败";
    case "conflict":
      return "会话运行中或压缩中，不能分叉";
    case "bad_request":
      return "分叉参数无效";
    default:
      return "分叉失败，请重试";
  }
}

/** 成功返回 true；失败已 toast，不再切换会话 */
export async function forkFromMessage(
  deps: ForkDeps,
  req: ForkRequest,
): Promise<boolean> {
  const tree = await deps.getTree(req.sessionId, deps.token);
  if (!tree.ok) {
    deps.notify(TREE_FAILED, "danger");
    return false;
  }
  const entryId = forkEntryId(tree.data, req.target);
  if (!entryId) {
    deps.notify(ENTRY_MISSING, "danger");
    return false;
  }
  const forked = await deps.fork(req.sessionId, entryId, deps.token);
  if (!forked.ok) {
    deps.notify(forkError(forked), "danger");
    return false;
  }
  const { id, title } = forked.data;
  // 新会话 id 先登记：打开发生在会话列表刷新之前，否则标签会被当作失效会话关掉
  deps.store.adoptSession(id);
  deps.changed?.(id);
  const switched = deps.store.showSession(id);
  deps.notify(`已分叉：${title}`, "ok");
  if (!switched) deps.notify(SWITCH_FAILED, "warn");
  return true;
}
