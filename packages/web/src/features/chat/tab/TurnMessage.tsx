// 对话流里的单条消息：用户气泡 / 助手消息；每轮最后一条 assistant 下方带操作行。
// 「原文 / 渲染」只影响这一条消息的文字块（思考与工具链保持现状），状态只在本地。

import { useState } from "react";
import type { ChatEntry, Known } from "../../../api";
import { AgentMessage, UserBubble } from "./Messages";
import { TurnFooter } from "./TurnFooter";
import type { ToolRow } from "./toolRows";

export interface TurnMessageProps {
  m: Known | ChatEntry;
  sessionId: string;
  /** 是否为本轮 agent 回复的最后一条：只有它渲染操作行 */
  turnEnd: boolean;
  /** 嵌套调用的子行（父工具 id → 子行），用于 call_tool 这类工具发起的内层调用 */
  kids?: Map<string, ToolRow[]>;
}

export function TurnMessage({ m, sessionId, turnEnd, kids }: TurnMessageProps) {
  const [raw, setRaw] = useState(false);
  if (m.role === "user")
    return (
      <UserBubble
        text={m.text}
        sessionId={sessionId}
        attachments={m.attachments}
      />
    );
  if (!turnEnd)
    return (
      <AgentMessage
        text={m.text}
        blocks={m.blocks}
        sessionId={sessionId}
        kids={kids}
      />
    );
  return (
    <div className="ch-turn-msg">
      <AgentMessage
        text={m.text}
        blocks={m.blocks}
        sessionId={sessionId}
        raw={raw}
        kids={kids}
      />
      <TurnFooter sessionId={sessionId} m={m} raw={raw} onRawChange={setRaw} />
    </div>
  );
}
