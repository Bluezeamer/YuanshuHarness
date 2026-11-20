// 执行体的运行视图：一行头（状态点、名称、角色、状态与时长、上下文读条）
// + 正文（直接复用主对话渲染层：消息、思考、工具链、Markdown、流式输出）+ 底部输入栏。
//
// 子代理就是会话池里的普通会话：对话和发送都走 useChatSession(execId)，
// 所以这里发送只写子会话，不惊动父会话；派发任务自然作为子会话的第一条用户消息出现。

import { useCallback, useEffect } from "react";
import type { JobSnapshot } from "../../../api";
import type { ExecutionBody } from "../../../api/flows";
import { Button, Empty } from "../../../ui";
import { useChatSession } from "../hooks";
import { Stream, type StreamProps } from "../tab/Stream";
import { useFlowLog } from "../tab/useFlowLog";
import { ExecComposer } from "./ExecComposer";
import { ExecConn, ExecHeader } from "./ExecParts";
import { rememberExecutions } from "./names";
import { useExecution } from "./useExecution";

export interface ExecViewProps {
  /** 派发它的会话（执行体清单从这里取） */
  parentId: string;
  execId: string;
  /** 点后台任务回调卡；不给就是只读的一行 */
  onOpenJob?: (job: JobSnapshot) => void;
}

const STOPPED =
  "这个执行体已不在运行：消息只会发给它自己的子会话，不会进入父会话，也不改变父会话的上下文与能力集。";

export function ExecView({ parentId, execId, onOpenJob }: ExecViewProps) {
  const found = useExecution(parentId, execId);

  if (found.phase === "ready")
    return <ExecBody exec={found.exec} {...(onOpenJob ? { onOpenJob } : {})} />;
  return (
    <div className="ch-ex" data-phase={found.phase}>
      {found.phase === "loading" && (
        <p className="ch-ex-state t-aux">载入中…</p>
      )}
      {found.phase === "missing" && (
        <Empty
          title="这个执行体不存在"
          description="它可能已被清理，或不属于这个会话。"
        />
      )}
      {found.phase === "error" && (
        <Empty
          tone="danger"
          title="无法载入执行体"
          description={found.why}
          action={
            <Button size="sm" onClick={found.retry}>
              重试
            </Button>
          }
        />
      )}
    </div>
  );
}

// 清单里确有这个执行体才连它的子会话，找不到 / 载入中不白连一条 WebSocket
function ExecBody({
  exec,
  onOpenJob,
}: {
  exec: ExecutionBody;
  onOpenJob?: (job: JobSnapshot) => void;
}) {
  const execId = exec.id;
  const session = useChatSession(execId);
  const { log, answer } = useFlowLog(session.state);

  useEffect(() => {
    rememberExecutions([exec]);
  }, [exec]);

  // 与主对话一致：先答先赢，本端点选后等服务端确认落定（子会话没有审批通道，这里只为共用渲染层保持同构）。
  const onAnswer = useCallback<StreamProps["onAnswer"]>(
    (prompt, a, label) => {
      const entry = log.prompts.find(
        (e) => e.prompt.promptId === prompt.promptId,
      );
      if (!entry || entry.answer) return;
      if (!session.actions.answerPrompt(prompt.promptId, a)) return;
      answer(prompt.promptId, { ...a, label });
    },
    [log.prompts, session.actions, answer],
  );

  return (
    <div className="ch-ex" data-phase="ready" data-exec-view={execId}>
      <ExecHeader exec={exec} now={Date.now()} />
      <ExecConn session={session} />
      <Stream
        sessionId={execId}
        session={session}
        log={log}
        onAnswer={onAnswer}
        {...(onOpenJob ? { onOpenJob } : {})}
      />
      {exec.state !== "run" && (
        <p className="ch-ex-stopped t-aux" data-exec-stopped>
          {STOPPED}
        </p>
      )}
      <ExecComposer execId={execId} name={exec.name} />
    </div>
  );
}
