import {
  getTabDef,
  registerTab,
  type TabRenderProps,
} from "../../workspace/tabs/registry";
import { JobView } from "./JobView";
import { jobName } from "./names";

// 后台任务标签：不绑定主机；内容就是一个 JobView。
function JobTabBody({ tab }: TabRenderProps) {
  return tab.job ? <JobView jobId={tab.job} /> : null;
}

/** 把 job（后台任务）标签类型注册进标签注册表；壳启动时调用一次，与 registerSubTab() 同风格 */
export function registerJobTab(): void {
  registerTab("job", {
    icon: getTabDef("job").icon,
    // 标题取任务的简述；开标签时与载入任务后缓存，取不到退回「后台任务」
    title: (tab) => jobName(tab.job) ?? "后台任务",
    render: (props) => <JobTabBody {...props} />,
  });
}
