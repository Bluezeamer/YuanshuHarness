import type { ExecutionBody } from "../../../api/flows";
import { useChatSession } from "../hooks";
import { useFlows } from "./useFlows";

export type ExecLookup =
  | { phase: "loading" }
  | { phase: "error"; why: string; retry(): void }
  | { phase: "missing" }
  | { phase: "ready"; exec: ExecutionBody };

/**
 * 从父会话的执行体清单里找出这个执行体（清单是整棵子树，孙代理也在里面）。
 * 取数时机与右栏一致：flows.updated 与有运行中项时的 3 秒轮询。
 */
export function useExecution(parentId: string, execId: string): ExecLookup {
  const flows = useFlows(parentId, useChatSession(parentId).state.flowsRev);
  const exec = flows.data?.executions.find((x) => x.id === execId);
  if (exec) return { phase: "ready", exec };
  if (flows.data) return { phase: "missing" };
  if (flows.error)
    return { phase: "error", why: flows.error, retry: flows.reload };
  return { phase: "loading" };
}
