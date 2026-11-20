import type {
  ExtensionFactory,
  SessionEntry as PiEntry,
} from "@earendil-works/pi-coding-agent";
import { JOB_TOOLS } from "../job/tools.js";
import { liveToolDefs, type McpToolDef } from "../mcp/tools.js";
import { type PlacedTool, pluginToolNames } from "../plugins/tools.js";
import type { McpServerMeta } from "../store/mcp.js";
import type { SubagentSpec } from "../store/subagents.js";
import { evaluateTools, type ModeOps } from "./capabilities.js";
import { HEAD_TYPE, readHead, STATEMARK_TYPE } from "./frozen.js";
import { GOAL_TOOLS } from "./goal-tools.js";
import {
  GLOBAL_AGENTSMD_TAG,
  GLOBAL_EXTRA_TAG,
  PROJECT_AGENTSMD_TAG,
} from "./preset-selection.js";
import {
  renderNotice,
  STATE_TYPE,
  type StateMapping,
  sameState,
  type ToolDef,
  withListedSkills,
} from "./state-map.js";
import { TOOL_NAMES } from "./tool-catalog.js";

// 提示词送达（prompt-delivery.md）：每次运行前
//  1. 把 pi 的启用工具设成「当前启用集合 ∪ 冻结声明里的」——被拦的工具留在可执行集里，
//     由下面的钩子给出我们写的原因，而不是 pi 通用的 "Tool X not found"；
//  2. 现算状态映射，与最近一份承载者（冻结物或状态通知）比较，有差异才写一条状态通知；
//  3. 拦住不在启用集合里的工具调用（模式的限制与能力增减都走这里）。

/** 模式的运行时视图：提示词正文 + 对能力的操作。 */
export interface ModeView {
  id: string;
  name: string;
  text: string;
  userText: string;
  ops: ModeOps;
}

export const SWITCH_MODE = "switch_mode";
/** 框架工具：不出现在可勾选能力里、不受模式限制（prompt.md E6）。 */
export const FRAMEWORK_ROOT = [
  "call_tool",
  "ask_user",
  "todo_write",
  ...GOAL_TOOLS,
  ...JOB_TOOLS,
];
/** 子代理交付工具：只在子代理会话里有；经占位通道的尾部通知给出签名（subagent.md §5）。 */
export const DELIVER = "deliver";
export const FRAMEWORK_CHILD = ["call_tool", ...JOB_TOOLS, DELIVER];
/** 团队里 lead 与成员共用的消息工具：只有有队的 lead 与队员才有，同样经占位通道尾部给出签名（team.md §2）。 */
export const POST = "post";

/** 交付层对会话池的需求，池之外的测试可以用假的。 */
export interface DeliveryHost {
  /** 会话基线启用的工具名：预设能力 ∪ MCP 工具，不含框架工具 */
  baselineTools(id: string, mcpTools: McpToolDef[]): string[];
  activeMode(id: string): ModeView | null;
  /** 会话可切换的模式数；为 0 时不声明 switch_mode */
  modeCount(id: string): number;
  /** 会话在团队里（lead 有队，或自己是成员）：有 post 工具 */
  canPost(id: string): boolean;
  /** 我们生成的系统段（身份与各段，不含 AGENTS.md） */
  promptSlots(id: string): Record<string, string>;
  /** 会话此刻生效的技能（已同步到当前所在环境）；不给就不管技能这一栏 */
  skills?(
    id: string,
  ): { name: string; description: string; filePath: string }[];
  /** 技能集合变了就先同步到当前环境、更新 skills(id)；没变什么都不做 */
  refreshSkills?(id: string): Promise<void>;
}

/**
 * 会话创建时要让 pi 注册并允许的全部工具名（含框架工具）；能力的开关靠运行时的启用集合。
 * MCP 用通配而不是写死当时缓存里的工具名：pi 的白名单是创建时定死的，写死的话，会话创建之后才登记的 MCP
 * 要么整个被过滤（白名单里已有别的 `mcp__` 名），要么注册了却不能激活（白名单里一个都没有）。
 * 哪些 MCP 在会话里由登记 ∩ 勾选决定（loadConfig），是否启用由送达层的启用集合决定。
 * 插件工具同理，而且名字根本不可预知：白名单里再放一个 `*`（pi 的 matcher 支持通配），
 * 让包里的扩展注册的工具不被白名单挡掉。启用与否仍由送达层的启用集合决定。
 */
export const ALLOWLIST_MCP = "mcp__*";
export const ALLOWLIST_ALL = "*";
/**
 * 白名单放宽之后，pi 自带但不在我们能力目录里的工具会被注册进来；按名字排除，保持现有内置与 MCP 工具集不变：
 * powershell 是 Windows 专用、我们这个会话从不声明；三个 MCP 资源工具以前被 `mcp__*` 挡在外面。
 */
export const EXCLUDED_TOOLS = [
  "powershell",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];
export const allowlist = (): string[] => [
  ...new Set([
    ...TOOL_NAMES,
    ALLOWLIST_MCP,
    ALLOWLIST_ALL,
    ...FRAMEWORK_ROOT,
    SWITCH_MODE,
    DELIVER,
    POST,
  ]),
];

/** 我们生成的系统段（身份 + 各段），三份 AGENTS.md / 附加提示词不进状态。 */
export function promptSlotsOf(
  render: { preamble: string; sections: Record<string, string> } | null,
): Record<string, string> {
  if (!render) return {};
  const out: Record<string, string> = {};
  if (render.preamble) out.identity = render.preamble;
  for (const [tag, body] of Object.entries(render.sections))
    if (
      tag !== GLOBAL_AGENTSMD_TAG &&
      tag !== GLOBAL_EXTRA_TAG &&
      tag !== PROJECT_AGENTSMD_TAG &&
      body
    )
      out[tag] = body;
  return out;
}

export interface Delivery {
  /** 运行前调用：技能集合变了就同步到当前环境，之后的 mapping() 才是最新的。 */
  refreshSkills(): Promise<void>;
  /** 某个技能的 SKILL.md 在当前环境里的路径 */
  skillPath(name: string): string | undefined;
  /**
   * 告知 pi 此刻注册的工具：MCP 工具名单以它为准（连上之前用检测缓存），
   * 包里的扩展注册的工具也在这里认出来（sourceInfo.origin === "package"）。
   */
  observe(registered: readonly PlacedTool[]): void;
  /** MCP 工具所属的服务（审批档按服务分）；不是我们登记的 MCP 工具返回 undefined */
  serverOf(tool: string): string | undefined;
  mapping(): StateMapping;
  /** 工具此刻不可用的原因（英文，给模型看）；可用返回 null */
  block(tool: string): string | null;
  /** call_tool 可以转发的工具名 */
  callable(): string[];
}

export function makeDelivery(
  host: DeliveryHost,
  id: string,
  mcpTools: McpToolDef[],
  spec?: SubagentSpec,
  /** 会话此刻生效的 MCP 登记；没有 MCP 时不给 */
  servers?: () => McpServerMeta[],
): Delivery {
  // 缓存里有而 pi 没注册成的，不该通知给模型；没缓存而注册成了的，照常可用
  let live: McpToolDef[] | null = null;
  // 插件工具：只进基线（默认启用），不进能力清单，会话里不能单独勾掉（plugin.md §3）。
  let plugin: string[] = [];
  const defs = () => live ?? mcpTools;
  const framework = () => [
    ...(spec ? FRAMEWORK_CHILD : FRAMEWORK_ROOT),
    ...(!spec && host.modeCount(id) > 0 ? [SWITCH_MODE] : []),
    ...(host.canPost(id) ? [POST] : []),
  ];
  const registered = () => [
    ...TOOL_NAMES,
    ...defs().map((d) => d.name),
    ...plugin,
  ];
  const enabled = (mode: ModeView | null) => {
    const serverOf = new Map(defs().map((d) => [d.name, d.server]));
    return evaluateTools({
      baseline: [...host.baselineTools(id, defs()), ...plugin],
      registered: registered(),
      framework: framework(),
      mode: mode?.ops ?? null,
      serverOf: (t) => serverOf.get(t),
    });
  };

  const mapping = (): StateMapping => {
    const mode = host.activeMode(id);
    return {
      tools: [...enabled(mode)].sort(),
      prompt: host.promptSlots(id),
      ...(host.skills
        ? {
            skills: Object.fromEntries(
              host.skills(id).map((s) => [s.name, s.description]),
            ),
          }
        : {}),
      mode: mode
        ? {
            id: mode.id,
            name: mode.name,
            text: mode.text,
            userText: mode.userText,
          }
        : null,
    };
  };

  return {
    refreshSkills: async () => {
      await host.refreshSkills?.(id);
    },
    skillPath: (name) =>
      host.skills?.(id).find((s) => s.name === name)?.filePath,
    observe(infos) {
      if (servers)
        live = liveToolDefs(
          infos.map((t) => t.name),
          servers(),
        );
      plugin = pluginToolNames(infos);
    },
    serverOf: (tool) => defs().find((d) => d.name === tool)?.server,
    mapping,
    callable: () =>
      enabled(host.activeMode(id)).filter((t) => t !== "call_tool"),
    block(tool) {
      const mode = host.activeMode(id);
      if (enabled(mode).includes(tool)) return null;
      // 没有模式时本来也不可用 → 通用原因；有模式且去掉模式就可用 → 点名模式
      if (mode && enabled(null).includes(tool))
        return `You are currently in "${mode.name}" mode; per its settings the tool ${tool} is unavailable. This is a blocking error, nothing was executed.`;
      return `The tool ${tool} is not available in this session. This is a blocking error, nothing was executed.`;
    },
  };
}

interface Carrier {
  state: StateMapping;
}

/** 当前上下文里最近一份承载者：冻结物或状态通知。压缩折叠掉的不算。 */
export function latestCarrier(entries: readonly PiEntry[]): Carrier | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as PiEntry;
    if (e.type === "custom" && e.customType === HEAD_TYPE)
      return { state: (e.data as { state: StateMapping }).state };
    if (e.type === "custom" && e.customType === STATEMARK_TYPE)
      return { state: (e.data as { state: StateMapping }).state };
    if (e.type === "custom_message" && e.customType === STATE_TYPE)
      return { state: (e.details as { state: StateMapping }).state };
  }
  return null;
}

export function deliveryExtension(api: Delivery): ExtensionFactory {
  return (pi) => {
    const def = (name: string): ToolDef | undefined => {
      const t = pi.getAllTools().find((x) => x.name === name);
      return t
        ? { name, description: t.description, parameters: t.parameters }
        : undefined;
    };

    pi.on("before_agent_start", async (_e, ctx) => {
      api.observe(pi.getAllTools());
      await api.refreshSkills();
      const want = api.mapping();
      const { data, stale } = readHead(ctx.sessionManager.getBranch());
      const declared = new Set(
        (data?.head.toolsAdded ?? []).map((t) => t.name),
      );
      const fresh = !data || stale;
      const known = new Set(pi.getAllTools().map((t) => t.name));
      pi.setActiveTools(
        [...new Set([...want.tools, ...(fresh ? [] : [...declared])])].filter(
          (t) => known.has(t),
        ),
      );
      // 新会话 / 刚重建：这一轮会按当前状态重新冻结，没有东西可通知。
      if (fresh) return undefined;
      const carrier = latestCarrier(ctx.sessionManager.buildContextEntries());
      if (!carrier) return undefined;
      const prev = withListedSkills(carrier.state, data?.head, want);
      if (sameState(prev, want)) return undefined;
      const text = renderNotice(prev, want, declared, def, api.skillPath);
      if (text === null) return undefined;
      return {
        message: {
          customType: STATE_TYPE,
          content: text,
          display: false,
          details: { state: want },
        },
      };
    });

    pi.on("tool_call", (e) => {
      api.observe(pi.getAllTools());
      const why = api.block(e.toolName);
      return why === null ? undefined : { block: true, reason: why };
    });
  };
}
