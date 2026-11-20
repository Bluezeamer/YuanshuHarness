import type { ChatSession } from "../hooks";
import type { AttachmentUploads } from "../input/useUploads";
import { ArchivedBar } from "./ArchivedBar";
import { Composer } from "./Composer";
import type { SessionMeta } from "./context";
import { QueueBar } from "./QueueBar";

export interface DockProps {
  sessionId: string;
  session: ChatSession;
  agentName: string;
  /** 会话库里的状态；archived 时输入栏换成只读条 */
  status: SessionMeta["status"];
  /** 附件上传链路；整个对话标签的拖入与输入卡共用 */
  uploads: AttachmentUploads;
  /** 发出一条消息后回调（对话流据此回到底部） */
  onSent(): void;
}

// 停靠区：排队消息 + 输入卡。审计视图整块不渲染；指标在页脚（StatusFoot），目标与计划在右侧状态（StatusPanel）。
export function Dock({
  sessionId,
  session,
  agentName,
  status,
  uploads,
  onSent,
}: DockProps) {
  return (
    <div className="ch-dock" data-chat-dock="">
      {status === "archived" ? (
        <ArchivedBar />
      ) : (
        <>
          <QueueBar sessionId={sessionId} session={session} />
          <Composer
            sessionId={sessionId}
            session={session}
            agentName={agentName}
            uploads={uploads}
            onSent={onSent}
          />
        </>
      )}
    </div>
  );
}
