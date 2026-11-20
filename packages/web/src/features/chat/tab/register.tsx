import { registerTab } from "../../workspace/tabs/registry";
import { AuditToggle } from "./AuditToggle";
import { ChatTab } from "./ChatTab";

function ChatIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  );
}

/** 把 chat 标签注册进标签注册表；应用启动时调用一次（与 registerTerminalTab 同风格） */
export function registerChatTab(): void {
  registerTab("chat", {
    icon: <ChatIcon />,
    title: () => "对话",
    render: (props) => <ChatTab {...props} />,
    headAction: (props) => <AuditToggle {...props} />,
  });
}
