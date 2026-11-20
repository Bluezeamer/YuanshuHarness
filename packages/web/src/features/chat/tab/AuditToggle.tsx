import { Button } from "../../../ui";
import { BackIcon } from "../../../ui/icons";
import type { Tab } from "../../workspace/model/types";
import { useChatSession } from "../hooks";

// 窗格头里标签条右端的入口：对话里是「审计 N」（N = 本会话的模型调用数），审计里换成「← 对话」。
// 空对话标签还没有绑会话，不出现。
export function AuditToggle({
  tab,
  patchTab,
}: {
  tab: Tab;
  patchTab(patch: Partial<Tab>): void;
}) {
  if (tab.sid === undefined) return null;
  return (
    <Toggle
      sessionId={tab.sid}
      audit={tab.ctab === "audit"}
      patchTab={patchTab}
    />
  );
}

function Toggle({
  sessionId,
  audit,
  patchTab,
}: {
  sessionId: string;
  audit: boolean;
  patchTab(patch: Partial<Tab>): void;
}) {
  const steps = useChatSession(sessionId).state.usage?.steps ?? 0;
  return audit ? (
    <Button
      variant="ghost"
      size="sm"
      data-audit-toggle="back"
      icon={<BackIcon />}
      onClick={() => patchTab({ ctab: "chat" })}
    >
      对话
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      data-audit-toggle="open"
      onClick={() => patchTab({ ctab: "audit" })}
    >
      审计 <span className="t-mono">{steps}</span>
    </Button>
  );
}
