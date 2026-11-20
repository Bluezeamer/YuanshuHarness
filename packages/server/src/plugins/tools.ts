// 插件工具（docs/model/plugin.md §3）：包里的扩展注册的工具，名字不可预知；
// 它们进 tools 槽、默认启用，但不进能力清单（会话里不能单独勾掉）。
// 以 pi 实际注册的为准：只有 sourceInfo.origin === "package" 的算插件工具，
// 内置、MCP（mcp__*）与框架工具都不是。
import { FRAMEWORK_TOOLS, TOOL_NAMES } from "../session/tool-catalog.js";

/** pi 的 ToolInfo 里判归属需要的那两项。 */
export interface PlacedTool {
  name: string;
  sourceInfo: { origin: string };
}

const FRAMEWORK = new Set(FRAMEWORK_TOOLS.map((t) => t.name));

export function pluginToolNames(infos: readonly PlacedTool[]): string[] {
  return infos
    .filter(
      (t) =>
        t.sourceInfo.origin === "package" &&
        !t.name.startsWith("mcp__") &&
        !TOOL_NAMES.has(t.name) &&
        !FRAMEWORK.has(t.name),
    )
    .map((t) => t.name);
}
