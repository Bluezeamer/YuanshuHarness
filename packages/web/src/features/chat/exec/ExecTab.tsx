import { Empty } from "../../../ui";
import {
  getTabDef,
  registerTab,
  type TabRenderProps,
} from "../../workspace/tabs/registry";
import { useOpenJob } from "../job/useOpenJob";
import { ExecView } from "./ExecView";
import { executionName } from "./names";

// 执行体标签：不绑定主机，换会话也不会把它带走；内容就是一个 ExecView。
function ExecTabBody({ tab, pane, sessionId }: TabRenderProps) {
  const execId = tab.sub;
  // 这个执行体自己的后台任务回调卡：任务属于它的子会话
  const openJob = useOpenJob(execId ?? "", pane.pid);
  if (!execId) return null;
  const parentId = tab.sid ?? sessionId;
  if (parentId === null) return <Empty compact title="找不到所属会话" />;
  return <ExecView parentId={parentId} execId={execId} onOpenJob={openJob} />;
}

/** 把 sub（执行体）标签类型注册进标签注册表；壳启动时调用一次，与 registerTerminalTab() 同风格 */
export function registerSubTab(): void {
  registerTab("sub", {
    icon: getTabDef("sub").icon,
    // 标题取执行体名称；名称由右栏或本标签拿到清单后缓存，取不到退回「执行体」
    title: (tab) => executionName(tab.sub) ?? "执行体",
    render: (props) => <ExecTabBody {...props} />,
  });
}
