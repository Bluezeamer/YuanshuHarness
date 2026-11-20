import { type ReactNode, useCallback, useRef, useState } from "react";
import type { JobSnapshot } from "../../../api";
import { Button, InlineNotice } from "../../../ui";
import type { Tab, TabAfx } from "../../workspace/model/types";
import { AuditPane } from "../audit";
import type { ChatSession } from "../hooks";
import { draftSink } from "../input/attachments";
import { useUploads } from "../input/useUploads";
import type { Prompt } from "../model/conversation";
import type { SessionMeta } from "./context";
import { Dock } from "./Dock";
import { HistoryNodes } from "./HistoryNodes";
import type { Answer } from "./PromptCards";
import { StatusFoot } from "./StatusFoot";
import { Stream } from "./Stream";
import { useChatFileDrop } from "./useChatFileDrop";
import { useDoubleEscape } from "./useDoubleEscape";
import { useElementWidth } from "./useElementWidth";
import { useFileRefDrop } from "./useFileRefDrop";
import { useFlowLog } from "./useFlowLog";

export interface ChatViewProps {
  sessionId: string;
  /**
   * 右栏（上下文）：按 .ch-shell 的真实宽度渲染，放在主栏旁边。ChatTab 提供真实的 ContextRail；
   * 单独渲染 ChatView（测试、预览）时不传即没有右栏。
   */
  rail?: (shellWidth: number) => ReactNode;
  tab: Tab;
  patchAfx(patch: Partial<TabAfx>): void;
  session: ChatSession;
  /** 壳提供的会话元信息；缺省按「运行中」、标题用 sessionId 兜底 */
  meta?: SessionMeta | undefined;
  /** 点后台任务回调卡；不给就是只读的一行 */
  onOpenJob?: (job: JobSnapshot) => void;
  /** 对话流左缘的导航线；默认有，手机端不要 */
  nav?: boolean;
}

function ConnBar({ session }: { session: ChatSession }) {
  const { conn } = session.state;
  if (conn !== "reconnecting" && conn !== "closed") return null;
  return (
    <InlineNotice
      tone={conn === "closed" ? "danger" : "warn"}
      className="ch-conn"
      data-conn={conn}
    >
      <span>
        {conn === "closed"
          ? "连接已断开，点击「重新连接」后以新快照恢复"
          : "正在重连…"}
      </span>
      {conn === "closed" && (
        <Button size="sm" onClick={session.actions.reconnect}>
          重新连接
        </Button>
      )}
    </InlineNotice>
  );
}

// 对话标签的内容：对话流 →（停靠区）→ 页脚。审计视图只留审计页与页脚。没有对话头：标题在标签与左轨，「审计 N」入口在窗格头（AuditToggle）。
export function ChatView({
  sessionId,
  rail,
  tab,
  patchAfx,
  session,
  meta,
  onOpenJob,
  nav = true,
}: ChatViewProps) {
  const view = tab.ctab === "audit" ? "audit" : "chat";
  const shell = useRef<HTMLDivElement>(null);
  const shellWidth = useElementWidth(shell);
  const { log, answer } = useFlowLog(session.state);
  // B20：编辑器为空、会话空闲、没有别的浮层抢 Esc 时，500ms 内连按两次 Esc 打开历史节点浮层。
  const [historyOpen, setHistoryOpen] = useState(false);
  const emptyDraft =
    session.draft.text.trim() === "" &&
    session.draft.attachments.length === 0 &&
    session.draft.quotes.length === 0;
  useDoubleEscape(
    view === "chat" &&
      !session.state.running &&
      !session.state.compacting &&
      emptyDraft &&
      !historyOpen,
    () => setHistoryOpen(true),
    shell,
  );
  // 附件上传与整标签拖入：审计视图不接收拖入，只挂在对话视图上。
  const uploads = useUploads(
    sessionId,
    draftSink(session.draft.attachments, session.actions),
  );
  const drop = useChatFileDrop(uploads.add);
  // 文件浏览器拖进来的条目：插入 `file:<主机>:<路径>` 引用（不是上传）
  const refDrop = useFileRefDrop((text) => {
    const cur = session.draft.text.trimEnd();
    session.actions.setDraft(cur === "" ? text : `${cur}\n${text}`);
  });
  const droppable = view === "chat";
  // 本端发送的次数：对话流据此回到底部
  const [sent, setSent] = useState(0);

  const onAnswer = useCallback(
    (p: Prompt, a: Answer, label: string) => {
      // 先答先赢：本端已点选过，第二次点击直接返回。
      const entry = log.prompts.find((e) => e.prompt.promptId === p.promptId);
      if (!entry || entry.answer) return;
      if (!session.actions.answerPrompt(p.promptId, a)) return;
      answer(p.promptId, { ...a, label });
    },
    [log.prompts, session.actions, answer],
  );

  return (
    <div className="ch-shell" data-chat-shell="" data-ctab={view} ref={shell}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 整块拖入区只接收文件拖放，键盘操作走输入卡选文件 */}
      <div
        className="ch-main"
        data-drop={
          droppable && (drop.dragging || refDrop.dragging) ? "" : undefined
        }
        data-drop-kind={droppable && refDrop.dragging ? "ref" : undefined}
        onDragEnter={
          droppable
            ? (e) => {
                drop.onDragEnter(e);
                refDrop.onDragEnter(e);
              }
            : undefined
        }
        onDragOver={
          droppable
            ? (e) => {
                drop.onDragOver(e);
                refDrop.onDragOver(e);
              }
            : undefined
        }
        onDragLeave={
          droppable
            ? (e) => {
                drop.onDragLeave(e);
                refDrop.onDragLeave(e);
              }
            : undefined
        }
        onDrop={
          droppable
            ? (e) => {
                drop.onDrop(e);
                refDrop.onDrop(e);
              }
            : undefined
        }
      >
        {view === "audit" ? (
          <div className="ch-audit">
            <AuditPane
              sessionId={sessionId}
              afx={tab.afx}
              patchAfx={patchAfx}
            />
          </div>
        ) : (
          <>
            <ConnBar session={session} />
            <Stream
              sessionId={sessionId}
              session={session}
              log={log}
              onAnswer={onAnswer}
              sent={sent}
              nav={nav}
              {...(onOpenJob ? { onOpenJob } : {})}
            />
            <Dock
              sessionId={sessionId}
              session={session}
              agentName={meta?.agentName ?? "agent"}
              status={meta?.status ?? "running"}
              uploads={uploads}
              onSent={() => setSent((n) => n + 1)}
            />
          </>
        )}
        <StatusFoot metrics={session.metrics} place={meta?.place} />
        {droppable && (drop.dragging || refDrop.dragging) && (
          <div className="ch-drop-mask" data-chat-drop="">
            <span className="t-entry">
              {refDrop.dragging ? "松开插入文件引用" : "松开上传文件"}
            </span>
          </div>
        )}
      </div>
      {/* 审计视图隐藏右栏；右栏在 .ch-shell 里与主栏并列，宽窄形态由它按 shellWidth 自己决定 */}
      {view === "chat" && rail?.(shellWidth)}
      {view === "chat" && (
        <HistoryNodes
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          sessionId={sessionId}
          session={session}
        />
      )}
    </div>
  );
}
