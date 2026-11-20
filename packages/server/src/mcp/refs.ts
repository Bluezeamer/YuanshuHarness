import type { CapabilityStore } from "../store/capabilities.js";
import type { PresetKind, PromptPresetStore } from "../store/prompt-presets.js";
import type { WorkspaceStore } from "../store/workspaces.js";

export interface McpRef {
  kind: "preset" | "workspace";
  id: string;
  /** 被引用位置的名字（预设名、workspace 名）。 */
  name: string;
  detail: string;
}

const KIND_LABEL: Record<PresetKind, string> = {
  agent: "agent 预设",
  mode: "模式预设",
  "global-extra": "全局附加提示词",
  "global-agentsmd": "全局 AGENTS.md",
  "project-agentsmd": "项目 AGENTS.md",
};

// 谁在引用这个 MCP 服务：提示词预设的能力集、workspace 级分配。
// 改名 = 新增并删除（A10），有引用就不让改，免得引用悄悄悬空。
// 审批档是服务自己的字段，随条目走，没有独立的审批规则引用服务名。
export function mcpReferences(
  name: string,
  deps: {
    presets?: PromptPresetStore;
    workspaces: WorkspaceStore;
    capabilities: CapabilityStore;
  },
): McpRef[] {
  const cap = `mcp:${name}`;
  const refs: McpRef[] = [];
  for (const p of deps.presets?.list() ?? [])
    if (p.capabilities?.includes(cap))
      refs.push({
        kind: "preset",
        id: p.id,
        name: p.name,
        detail: KIND_LABEL[p.kind],
      });
  for (const id of deps.capabilities.workspacesWith("mcp", name)) {
    const w = deps.workspaces.get(id);
    if (w)
      refs.push({
        kind: "workspace",
        id: w.id,
        name: w.name,
        detail: "工作区能力分配",
      });
  }
  return refs;
}
