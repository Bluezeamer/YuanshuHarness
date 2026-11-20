import { useCallback, useEffect, useState } from "react";
import type { SessionSnapshot } from "../store/sessionStore";
import {
  clearAnswer,
  emptyLog,
  type FlowLog,
  markAnswered,
  observe,
  type PromptAnswer,
} from "./flowLog";

// 观察会话快照，维护对话流里的回执 / 弹窗落定记录（见 flowLog.ts）。
export function useFlowLog(state: SessionSnapshot) {
  const [log, setLog] = useState<FlowLog>(emptyLog);
  const { compact, prompts, promptError } = state;
  const open = state.conn === "open";
  const count = state.messages.length;

  useEffect(() => {
    setLog((l) => observe(l, { open, count, compact, prompts }, new Date()));
  }, [open, count, compact, prompts]);

  // 答复被拒：撤回本端的点选，卡片回到可答状态并显示失败原因。
  useEffect(() => {
    if (promptError) setLog((l) => clearAnswer(l, promptError.promptId));
  }, [promptError]);

  const answer = useCallback(
    (promptId: string, a: Omit<PromptAnswer, "time">) =>
      setLog((l) => markAnswered(l, promptId, a, new Date())),
    [],
  );
  return { log, answer };
}
