// 会话表单：创建 / 编辑 / 以此配置新建共用一份。目录、项目约定不在这里（归工作区与目录）。

import type { Tier } from "../../../../api/defaults";
import type {
  ConfigBody,
  ConfigPatch,
  SessionConfig,
} from "../../../../api/sessionConfig";
import type { Workspace } from "../../../../api/workspaces";
import {
  type Catalog,
  connectedProviders,
  defaultAgentPreset,
  presetDefaults,
  settleModel,
} from "./catalog";

export type SessionMode = "create" | "edit" | "from";

export interface ModelValue {
  mode: "follow" | "pick";
  provider: string;
  model: string;
  reasoning: string;
}

export interface SessionForm {
  title: string;
  /** agent 预设 id；空 = 默认预设 */
  promptPresetId: string;
  modePresetIds: string[];
  model: ModelValue;
  /** 生效能力 id（tool:/skill:/mcp:）；null = 不限制 */
  capabilities: string[] | null;
  /** 审批档位的会话覆盖；null = 跟随全局默认 */
  permissionTier: Tier | null;
}

export const TITLE_MAX = 48;

/** 「指定」型取值的起点：第一个已连接供应商的第一个模型 */
export const pickStart = (cat: Catalog): Omit<ModelValue, "mode"> =>
  settleModel(cat, connectedProviders(cat)[0]?.id ?? "", {});

/** 新会话的起点：工作区的默认配置盖在全局之上（只取库里还在的预设） */
export function formForWorkspace(cat: Catalog, ws: Workspace): SessionForm {
  const d = ws.defaults;
  const agent =
    cat.agentPresets.find((p) => p.id === d.agentPresetId) ??
    defaultAgentPreset(cat);
  const start = pickStart(cat);
  return {
    title: "",
    promptPresetId: agent?.id ?? "",
    modePresetIds: (d.modePresetIds ?? []).filter((id) =>
      cat.modePresets.some((p) => p.id === id),
    ),
    model: d.model
      ? {
          mode: "pick",
          provider: d.model.provider,
          model: d.model.model,
          reasoning: d.model.reasoning,
        }
      : { mode: "follow", ...start },
    capabilities: presetDefaults(cat, agent?.id ?? "").capabilities,
    permissionTier: (d.permissionTier as Tier | undefined) ?? null,
  };
}

/** 换提示词预设：能力回到新预设的默认值（权限不跟预设，不动） */
export const withPromptPreset = (
  form: SessionForm,
  cat: Catalog,
  presetId: string,
): SessionForm => ({
  ...form,
  promptPresetId: presetId,
  capabilities: presetDefaults(cat, presetId).capabilities,
});

export interface SessionPresetChoice {
  promptPresetId?: string | null;
  modePresetIds?: string[] | null;
}

/** 已有会话的配置 → 表单（编辑，或以此配置新建） */
export function formFromConfig(
  cfg: SessionConfig,
  choice: SessionPresetChoice,
  cat: Catalog,
  title: string,
): SessionForm {
  const explicit = cfg.model.mode === "explicit" ? cfg.model : null;
  const agent = choice.promptPresetId ?? defaultAgentPreset(cat)?.id ?? "";
  return {
    title,
    promptPresetId: agent,
    modePresetIds: choice.modePresetIds ?? [],
    model: explicit
      ? {
          mode: "pick",
          provider: explicit.provider,
          model: explicit.model,
          reasoning: explicit.reasoning,
        }
      : { mode: "follow", ...pickStart(cat) },
    // 没落库的配置（rev 0）沿用预设默认值才符合「跟随预设」
    capabilities:
      cfg.rev === 0
        ? presetDefaults(cat, agent).capabilities
        : cfg.capabilities,
    permissionTier: cfg.permissionTier,
  };
}

export function toBody(form: SessionForm): ConfigBody {
  const { model } = form;
  return {
    model:
      model.mode === "pick"
        ? {
            mode: "explicit",
            provider: model.provider,
            model: model.model,
            reasoning: model.reasoning || "off",
          }
        : { mode: "follow-default" },
    capabilities: form.capabilities,
    permissionTier: form.permissionTier,
  };
}

const SECTION_KEYS = ["model", "capabilities", "permissionTier"] as const;

/** 相对 orig 有变化的配置分区（Agent 创建后不可改，不进 patch） */
export function toPatch(form: SessionForm, orig: SessionForm): ConfigPatch {
  const a = toBody(form);
  const b = toBody(orig);
  const patch: Record<string, unknown> = {};
  for (const k of SECTION_KEYS)
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) patch[k] = a[k];
  return patch as ConfigPatch;
}

/** 指定模型没选完或已不在已连接的供应商里；返回说明，没问题返回 null */
export function modelIssue(form: SessionForm, cat: Catalog): string | null {
  const m = form.model;
  if (m.mode !== "pick") return null;
  if (!m.provider || !m.model) return "指定模型还没选完";
  const ok = connectedProviders(cat).some(
    (p) => p.id === m.provider && p.models.some((x) => x.id === m.model),
  );
  return ok ? null : "指定的模型不在已连接的供应商里";
}
