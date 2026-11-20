// 每轮 agent 回复的最后一条消息下方的操作行：原文 / 渲染切换、分叉入口、消息时间。
// 分叉入口复用 workspace/fork 的 ForkButton 与 flow；没有对话数据层 / 布局时
// （独立渲染对话流的测试、预览）只保留切换与时间，不阻塞渲染。

import { useContext, useState } from "react";
import type { ChatEntry, Known } from "../../../api";
import { loadToken } from "../../../api/http";
import { forkSession, getSessionTree } from "../../../api/session-fork";
import { Button, fmtDateTime, toast } from "../../../ui";
import { ForkButton } from "../../workspace/fork/ForkButton";
import { forkFromMessage } from "../../workspace/fork/flow";
import { useLayoutStoreOptional } from "../../workspace/layoutContext";
import { forkTargetOf } from "../../workspace/model/forkEntry";
import type { LayoutStore } from "../../workspace/store/layoutStore";
import { ChatContext } from "../context";
import { useChatSession } from "../hooks";
import { useSessionChanged } from "./context";

export interface TurnFooterProps {
  sessionId: string;
  /** 本轮最后一条 assistant 消息：分叉目标与时间都取自它 */
  m: Known | ChatEntry;
  raw: boolean;
  onRawChange(raw: boolean): void;
}

export function TurnFooter({
  sessionId,
  m,
  raw,
  onRawChange,
}: TurnFooterProps) {
  const ts = m.ts;
  const time = fmtDateTime(ts);
  return (
    <div className="ch-turn">
      <Button
        variant="ghost"
        size="sm"
        className="ch-turn-act"
        aria-pressed={raw}
        title={raw ? "恢复 Markdown 渲染" : "查看原文（纯文本）"}
        onClick={() => onRawChange(!raw)}
      >
        {raw ? "渲染" : "原文"}
      </Button>
      <ForkAction sessionId={sessionId} m={m} />
      {time && ts && (
        <time className="ch-turn-time t-mono" dateTime={ts} title={ts}>
          {time}
        </time>
      )}
    </div>
  );
}

// 分叉入口：需要对话数据层（运行/压缩态、已加载消息）与布局（在当前窗口里打开新会话）。
function ForkAction({
  m,
  sessionId,
}: {
  m: Known | ChatEntry;
  sessionId: string;
}) {
  const hub = useContext(ChatContext);
  const store = useLayoutStoreOptional();
  if (!hub || !store) return null;
  return <ForkActionLive m={m} sessionId={sessionId} store={store} />;
}

function ForkActionLive({
  m,
  sessionId,
  store,
}: {
  m: Known | ChatEntry;
  sessionId: string;
  store: LayoutStore;
}) {
  const { state } = useChatSession(sessionId);
  const changed = useSessionChanged();
  const [busy, setBusy] = useState(false);
  const target = forkTargetOf(m, state.loaded.older, state.messages);
  const disabledReason = state.running
    ? "运行中不能分叉"
    : state.compacting
      ? "压缩中不能分叉"
      : target
        ? null
        : "找不到这条消息的分叉点";
  const fork = () => {
    if (!target || busy) return;
    setBusy(true);
    void forkFromMessage(
      {
        getTree: getSessionTree,
        fork: forkSession,
        store,
        token: loadToken(),
        notify: (message, tone) => void toast(message, { tone }),
        ...(changed ? { changed } : {}),
      },
      { sessionId, target },
    ).finally(() => setBusy(false));
  };
  return (
    <ForkButton busy={busy} disabledReason={disabledReason} onFork={fork} />
  );
}
