import type {
  McpServerInfo,
  SkillInfo,
  ToolInfo,
} from "../../../../api/capabilities";
import {
  CAPABILITY_UNITS,
  DEFAULT_OFF_UNITS,
  UNIT_TOOLS,
} from "../../../../api/capabilities";
import type { ConnectionList } from "../../../../api/connections";
import type { Tier } from "../../../../api/defaults";
import type { DirectoryInfo } from "../../../../api/directories";
import type { ModelSpec, ProviderView } from "../../../../api/providers";
import type { StudioPreset } from "../../../../api/studio";

export interface Host {
  id: string;
  name: string;
  kind: "local" | "ssh";
  detail: string;
}

export type ToolRow = ToolInfo & { factory: unknown };

/** 面板需要的全部目录数据，打开时一次取齐 */
export interface Catalog {
  /** 两类预设：agent / 模式 */
  agentPresets: StudioPreset[];
  modePresets: StudioPreset[];
  /** 项目 AGENTS.md 模板：创建工作区时可选一个写进主目录 */
  agentsTemplates: StudioPreset[];
  providers: ProviderView[];
  hosts: Host[];
  skills: SkillInfo[];
  mcp: McpServerInfo[];
  tools: ToolRow[];
  directories: DirectoryInfo[];
  /** Server 用户 home，给 local 主机当目录建议 */
  home: string | null;
  /** 选目录的起点（全局默认值设置），`~` 在各主机上展开为各自的家目录 */
  directoryStart: string;
  /** 全局默认审批档；会话没覆盖就跟随它 */
  globalTier: Tier;
  /** 配了审批模型才能选「模型」档 */
  hasReviewModel: boolean;
}

export const hostsOf = (list: ConnectionList): Host[] => [
  {
    id: list.server.environmentId,
    name: list.server.label,
    kind: "local",
    detail: list.server.host,
  },
  ...list.connections
    .filter((c) => c.status === "active")
    .map(
      (c): Host => ({
        id: c.id,
        name: c.label,
        kind: "ssh",
        detail: `${c.user}@${c.host}`,
      }),
    ),
];

/** 主机不在已连接清单里（已断开或被删）时给个占位，避免行里显示空白 */
export const localHostIdOf = (cat: Catalog): string =>
  (cat.hosts.find((h) => h.kind === "local") ?? cat.hosts[0])?.id ?? "";

export const hostOf = (cat: Catalog, id: string): Host =>
  cat.hosts.find((h) => h.id === id) ?? {
    id,
    name: id,
    kind: "ssh",
    detail: "未连接",
  };

/** 目录建议：该主机上已有目录的目录，local 再补 Server 的 home */
export const suggestionsOf = (cat: Catalog, hostId: string): string[] => {
  const out = cat.directories
    .filter((w) => w.environmentId === hostId)
    .map((w) => w.path);
  const local = cat.hosts.find((h) => h.id === hostId)?.kind === "local";
  if (local && cat.home && !out.includes(cat.home)) out.push(cat.home);
  return out;
};

/** 默认 agent 预设 = 列表里的第一张（与后端 selectPresets 的回退一致） */
export const defaultAgentPreset = (cat: Catalog): StudioPreset | undefined =>
  cat.agentPresets[0];

export const agentPresetOf = (
  cat: Catalog,
  id: string,
): StudioPreset | undefined =>
  (id ? cat.agentPresets.find((p) => p.id === id) : undefined) ??
  defaultAgentPreset(cat);

export const modePresetsOf = (
  cat: Catalog,
  ids: readonly string[],
): StudioPreset[] =>
  ids.flatMap((id) => {
    const p = cat.modePresets.find((x) => x.id === id);
    return p ? [p] : [];
  });

// ---- 模型 ----

/** 只有状态 ok 的供应商算已连接，才允许被会话指定 */
export const connectedProviders = (cat: Catalog): ProviderView[] =>
  cat.providers.filter((p) => p.status === "ok");

export const modelSpecOf = (
  cat: Catalog,
  provider: string,
  model: string,
): ModelSpec | undefined =>
  cat.providers
    .find((p) => p.id === provider)
    ?.models.find((m) => m.id === model);

export const LEVEL_LABEL: Record<string, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

/** 模型声明的思考级别；不支持思考的模型只有「关闭」 */
export const levelsOf = (spec: ModelSpec | undefined): string[] =>
  spec && spec.levels.length > 0 ? spec.levels : ["off"];

/**
 * 换供应商或模型后要落到的取值：保留当前模型（若仍在），否则第一个；级别不在声明里取第一项。
 * fresh = 刚换了模型 / 供应商（或还没有取值）：先落在模型自己声明的默认档位。
 */
export function settleModel(
  cat: Catalog,
  provider: string,
  prefer: { model?: string; reasoning?: string; fresh?: boolean },
): { provider: string; model: string; reasoning: string } {
  const p = connectedProviders(cat).find((x) => x.id === provider);
  const spec =
    p?.models.find((m) => m.id === prefer.model) ?? p?.models[0] ?? undefined;
  const levels = levelsOf(spec);
  // 当前级别仍在声明里就保留；换模型后不在了取第一项；还没有取值时起点用「中」
  const start = spec?.defaultLevel;
  const reasoning =
    (prefer.fresh || !prefer.reasoning) && start && levels.includes(start)
      ? start
      : levels.includes(prefer.reasoning ?? "")
        ? (prefer.reasoning as string)
        : !prefer.reasoning && levels.includes("medium")
          ? "medium"
          : (levels[0] ?? "off");
  return { provider: p?.id ?? "", model: spec?.id ?? "", reasoning };
}

// ---- 能力 ----

export type CapKind = "tool" | "unit" | "skill" | "mcp";

export interface CapItem {
  id: string;
  kind: CapKind;
  name: string;
  desc: string;
  /** 库里是否还有这一项 */
  known: boolean;
}

const PREFIX: Record<CapKind, string> = {
  tool: "tool:",
  unit: "unit:",
  skill: "skill:",
  mcp: "mcp:",
};

export const capIdOf = (kind: CapKind, name: string): string =>
  `${PREFIX[kind]}${name}`;

export const parseCapId = (id: string): { kind: CapKind; name: string } => {
  const i = id.indexOf(":");
  const p = id.slice(0, i);
  return {
    kind:
      p === "mcp"
        ? "mcp"
        : p === "skill"
          ? "skill"
          : p === "unit"
            ? "unit"
            : "tool",
    name: id.slice(i + 1),
  };
};

const kindOfId = (id: string): CapKind => parseCapId(id).kind;

const mcpDesc = (m: McpServerInfo): string =>
  `${m.config.transport === "http" ? "HTTP" : "stdio"} · ${
    m.tools ? `${m.tools.length} 个工具` : "工具未探测"
  }`;

/** 库里全部可勾选的能力：内置工具、技能、MCP */
export const capabilityLibrary = (cat: Catalog): CapItem[] => [
  // 能力单元里的工具不单列（与 Studio 一致）
  ...cat.tools
    .filter((t) => !UNIT_TOOLS.has(t.name))
    .map(
      (t): CapItem => ({
        id: capIdOf("tool", t.name),
        kind: "tool",
        name: t.name,
        desc: t.description,
        known: true,
      }),
    ),
  ...CAPABILITY_UNITS.map(
    (u): CapItem => ({
      id: u.id,
      kind: "unit",
      name: u.name,
      desc: u.desc,
      known: true,
    }),
  ),
  ...cat.skills.map(
    (s): CapItem => ({
      id: capIdOf("skill", s.name),
      kind: "skill",
      name: s.name,
      desc: s.description,
      known: true,
    }),
  ),
  ...cat.mcp.map(
    (m): CapItem => ({
      id: capIdOf("mcp", m.name),
      kind: "mcp",
      name: m.name,
      desc: mcpDesc(m),
      known: true,
    }),
  ),
];

export const capItemOf = (cat: Catalog, id: string): CapItem =>
  capabilityLibrary(cat).find((c) => c.id === id) ?? {
    id,
    kind: kindOfId(id),
    name: parseCapId(id).name,
    desc: "库中已不存在这一项",
    known: false,
  };

/** 「不限制」时展开成显式勾选清单用：全部已知能力，默认关闭的单元除外（与服务端的「不限制」一致） */
export const allCapabilityIds = (cat: Catalog): string[] =>
  capabilityLibrary(cat)
    .map((c) => c.id)
    .filter((id) => !DEFAULT_OFF_UNITS.has(id));

/** 与服务端 selectPresets 同一套规则：能力取自 agent 预设（模式不参与，运行时才起作用）；权限不跟预设走 */
export function presetDefaults(
  cat: Catalog,
  promptPresetId: string,
): { capabilities: string[] | null } {
  const agent = agentPresetOf(cat, promptPresetId);
  return { capabilities: agent?.capabilities ?? null };
}
