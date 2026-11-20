// 运行态的「一行预览」：同一时刻只露一行，内容是正在发生的那一步最新到达的一行。
// 优先级：正在生成参数的工具 > 正在执行的工具 > 思考（正文已经开始流出时思考不再是当前这一步）。

import type { PendingTool, Tool } from "../model/conversation";
import { lastLine, partialLine, partialText, viewOf } from "./toolRows";

export interface LiveLine {
  kind: "thinking" | "tool";
  /** 类型标签：「思考」或工具名 */
  label: string;
  text: string;
  /** 点开后看的全文（思考全文、参数目前生成的全部、目前的全部输出），预览行只是它的最后一行 */
  body: string;
  /** 同时还在跑的其他工具数 */
  more: number;
}

export function liveLineOf(s: {
  partial: string | null;
  partialThinking: string;
  pendingTools: readonly PendingTool[];
  /** 已经开始执行、还没落进消息的工具 */
  running: readonly Tool[];
}): LiveLine | null {
  const pending = s.pendingTools.at(-1);
  if (pending)
    return {
      kind: "tool",
      label: pending.name,
      text: partialLine(pending.name, pending.args),
      body: partialText(pending.name, pending.args),
      more: s.pendingTools.length - 1,
    };
  const run = s.running.at(-1);
  if (run)
    return {
      kind: "tool",
      label: run.name,
      text: lastLine(run.output ?? "") || viewOf(run.name, run.args).primary,
      body: run.output || viewOf(run.name, run.args).primary,
      more: s.running.length - 1,
    };
  if (s.partialThinking.trim() !== "" && !s.partial)
    return {
      kind: "thinking",
      label: "思考",
      text: lastLine(s.partialThinking),
      body: s.partialThinking,
      more: 0,
    };
  return null;
}
