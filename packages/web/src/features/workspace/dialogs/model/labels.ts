// 摘要行上的文字：值 + 灰色备注（X02：跟随 / 覆盖）。
import { TIER_LABEL, type Tier } from "../../../../api/defaults";
import type { WorkspaceCapabilities } from "../../../../api/workspaceCapabilities";
import type { WorkspaceReviewPolicy } from "../../../../api/workspaces";
import type { CapabilityPick } from "../api";
import {
  agentPresetOf,
  type Catalog,
  LEVEL_LABEL,
  modelSpecOf,
  modePresetsOf,
  presetDefaults,
} from "./catalog";
import type { ModelValue } from "./session";

export const levelLabel = (level: string): string =>
  LEVEL_LABEL[level] ?? level;

export const modelValueLabel = (cat: Catalog, m: ModelValue): string => {
  if (m.mode !== "pick") return "全局默认模型";
  const spec = modelSpecOf(cat, m.provider, m.model);
  return `${spec ? spec.name : m.model || "未选择"} · 思考${levelLabel(m.reasoning)}`;
};

export const tierValueLabel = (cat: Catalog, tier: Tier | null): string =>
  TIER_LABEL[tier ?? cat.globalTier];

export const capsLabel = (caps: string[] | null): string => {
  if (caps === null) return "不限制";
  const n = (p: string) => caps.filter((c) => c.startsWith(p)).length;
  return `工具 ${n("tool:") + n("unit:")} · 技能 ${n("skill:")} · MCP ${n("mcp:")}`;
};

/** 工作区弹窗里「审核要求」摘要行的值：没写文字就是跟随全局 */
export const reviewValue = (p: WorkspaceReviewPolicy): string => {
  const text = p.text.trim();
  if (text === "") return "跟随全局";
  const first = text.split("\n")[0] ?? "";
  return `${p.mode === "override" ? "覆盖" : "追加"} · ${first.length > 24 ? `${first.slice(0, 24)}…` : first}`;
};

/** 能力是否偏离了所选 Agent 的基线 */
export const capsChanged = (
  cat: Catalog,
  agentId: string,
  caps: string[] | null,
): boolean =>
  JSON.stringify(caps) !==
  JSON.stringify(presetDefaults(cat, agentId).capabilities);

export const modesLabel = (cat: Catalog, ids: readonly string[]): string =>
  ids.length === 0
    ? "无"
    : modePresetsOf(cat, ids)
        .map((p) => p.name)
        .join("、");

export const agentLabel = (cat: Catalog, id: string): string =>
  agentPresetOf(cat, id)?.name ?? "默认";

/** 工作区弹窗里「技能与 MCP」摘要行的值：只数这个工作区额外勾选的，全局的另走备注。 */
export const capsValue = (
  pick: CapabilityPick,
  picked: WorkspaceCapabilities,
): string => {
  if (pick.skills.length + pick.mcp.length === 0) return "还没有技能或 MCP";
  const n = picked.skill.length + picked.mcp.length;
  return n === 0 ? "都不额外启用" : `已勾选 ${n} 项`;
};

export const capsNote = (pick: CapabilityPick): string | undefined => {
  const n =
    pick.skills.filter((k) => k.global).length +
    pick.mcp.filter((m) => m.global).length;
  return n === 0 ? undefined : `另有 ${n} 项全局`;
};
