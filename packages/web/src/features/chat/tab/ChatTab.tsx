import { SERVER_HOST } from "../../../app/shell/hosts";
import { Empty } from "../../../ui";
import { useLayoutStore } from "../../workspace/layoutContext";
import type { TabRenderProps } from "../../workspace/tabs/registry";
import { useOpenExecution } from "../exec/useOpenExecution";
import { useChatSession } from "../hooks";
import { useOpenJob } from "../job/useOpenJob";
import { StatusPanel } from "../status";
import { ChatView } from "./ChatView";
import { useSessionMeta } from "./context";

// chat 标签的渲染器：订阅会话数据，元信息由壳经 ChatTabContext 提供。
// 空对话标签还没有绑定会话：不给数据层发请求，只提示去左侧选一个。
export function ChatTab({ sessionId, ...props }: TabRenderProps) {
  if (sessionId === null)
    return (
      <Empty
        title="还没有对话"
        description="在左侧选一个会话，或新建一个对话。"
      />
    );
  // 按会话做 key：临时标签换绑会话时标签 id 不变，窗格不会重新挂载；
  // 不重挂的话对话流的本地记录（审批落定卡、压缩回执）会带进新会话。
  return <ChatTabBody key={sessionId} {...props} sessionId={sessionId} />;
}

function ChatTabBody({
  tab,
  pane,
  sessionId,
  patchAfx,
}: TabRenderProps & { sessionId: string }) {
  const session = useChatSession(sessionId);
  const meta = useSessionMeta(sessionId);
  const openExec = useOpenExecution(sessionId, pane.pid);
  const openJob = useOpenJob(sessionId, pane.pid);
  const store = useLayoutStore();
  return (
    <ChatView
      sessionId={sessionId}
      tab={tab}
      patchAfx={patchAfx}
      session={session}
      meta={meta}
      onOpenJob={openJob}
      rail={(paneWidth) => (
        <StatusPanel
          sessionId={sessionId}
          session={session}
          afx={tab.afx}
          patchAfx={patchAfx}
          width={paneWidth}
          onOpenExecution={openExec}
          onOpenJob={openJob}
          onOpenFile={(path) =>
            store.openFilePreview(pane.pid, tab.id, SERVER_HOST, path)
          }
          onOpenTeamDiff={(path) =>
            store.openTeamDiff(pane.pid, tab.id, path, sessionId)
          }
        />
      )}
    />
  );
}
