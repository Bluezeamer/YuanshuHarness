// 把一段内容连同来源加进借用会话的输入草稿（引用 chip）：发送时拼成「Quote 来源 + 围栏块」，agent 看得到内容与出处。
// 目标会话是标签借用的那一个（sessionId，正在显示的第一个对话）；toast 里写明是哪个，免得分屏时认错。
import { useCallback } from "react";
import { toast } from "../../../ui";
import { makeQuote, useAddQuote } from "../../chat";
import { useSessionTitles } from "../layoutContext";

export function useAddToChat(
  sessionId: string | null,
): (label: string, text: string) => void {
  const add = useAddQuote();
  const titles = useSessionTitles();
  return useCallback(
    (label, text) => {
      if (!add || !sessionId) {
        toast("先打开一个对话，才能把内容加进去", { tone: "warn" });
        return;
      }
      add(sessionId, makeQuote(label, text));
      toast(`已添加到对话「${titles.get(sessionId) ?? "当前对话"}」`, {
        tone: "ok",
      });
    },
    [add, sessionId, titles],
  );
}
