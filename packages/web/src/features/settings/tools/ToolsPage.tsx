import { useState } from "react";
import { TabPanel } from "../../../ui";
import { Page } from "../frame/layout";
import { useLeaveGuard } from "../frame/leave";
import { PageTabs } from "../frame/PageTabs";
import { BuiltinTab } from "./builtin/BuiltinTab";
import { createToolsStore } from "./builtin/store";
import { useSnapshot } from "./common/hooks";
import { McpTab } from "./mcp/McpTab";
import { createMcpStore } from "./mcp/store";
import { PluginTab } from "./plugins/PluginTab";
import { createPluginStore } from "./plugins/store";
import { SkillsTab } from "./skills/SkillsTab";
import { createSkillsStore } from "./skills/store";

type View = "tools" | "skills" | "mcp" | "plugins";

/**
 * 工具与能力：工具 / 技能 / MCP / 扩展四个页签。
 * 工具是 Server 注册的内置工具及其审批规则；技能、MCP 与 pi 扩展是 Server 持有的东西，做主从。
 */
export function ToolsPage() {
  const guard = useLeaveGuard();
  // store 放在页签之上：切页签不丢数据；各页签首次进入时才加载
  const [tools] = useState(() => createToolsStore());
  const [skills] = useState(() => createSkillsStore());
  const [mcp] = useState(() => createMcpStore());
  const [plugins] = useState(() => createPluginStore());
  const toolsState = useSnapshot(tools);
  const skillsState = useSnapshot(skills);
  const mcpState = useSnapshot(mcp);
  const pluginsState = useSnapshot(plugins);
  const [view, setView] = useState<View>("tools");

  return (
    <Page>
      <PageTabs
        idBase="tl"
        aria-label="工具与能力视图"
        value={view}
        onChange={(v) => guard(() => setView(v as View))}
        tabs={[
          {
            id: "tools",
            label: "工具",
            count:
              toolsState.phase === "ready"
                ? toolsState.tools.length
                : undefined,
          },
          {
            id: "skills",
            label: "技能",
            count:
              skillsState.phase === "ready"
                ? skillsState.skills.length
                : undefined,
          },
          {
            id: "mcp",
            label: "MCP",
            count:
              mcpState.phase === "ready" ? mcpState.servers.length : undefined,
          },
          {
            id: "plugins",
            label: "扩展",
            count:
              pluginsState.phase === "ready"
                ? pluginsState.plugins.length
                : undefined,
          },
        ]}
      />
      <TabPanel idBase="tl" id="tools" value={view} className="st-pane">
        <BuiltinTab store={tools} />
      </TabPanel>
      <TabPanel idBase="tl" id="skills" value={view} className="st-pane">
        <SkillsTab store={skills} />
      </TabPanel>
      <TabPanel idBase="tl" id="mcp" value={view} className="st-pane">
        <McpTab store={mcp} />
      </TabPanel>
      <TabPanel idBase="tl" id="plugins" value={view} className="st-pane">
        <PluginTab store={plugins} />
      </TabPanel>
    </Page>
  );
}
