// 会话的预设选择：把「agent 预设 + 全局附加提示词」解析成运行时需要的东西。
//
// 规则：
//   能力、权限档位：取自 agent 预设（模式不参与：模式对能力的操作在运行时求值，见 capabilities.ts）。
//   提示词：agent 预设（身份 + 各段）、全局附加提示词。模式的提示词不进系统提示词，
//          进入模式时作为状态通知发给模型（delivery.ts）。
import { composePreset, presetCardIds } from "../prompt/compose.js";
import type { ModelRef } from "../prompt/items.js";
import type { PromptCardStore } from "../store/prompt-cards.js";
import type {
  PresetKind,
  PromptPreset,
  PromptPresetStore,
} from "../store/prompt-presets.js";
import type { AgentsFiles } from "./agents-md.js";
import type { ModeView } from "./delivery.js";
import type { SessionPrompt } from "./prompt-source.js";

/** 全局 AGENTS.md 的段落名（落在 system prompt 里，与 pi 的 project_context 分开） */
export const GLOBAL_AGENTSMD_TAG = "global_agentsmd";
/** 项目约定的段落名 */
export const PROJECT_AGENTSMD_TAG = "project_agentsmd";
/** 全局附加提示词（预设渲染结果）的段落名 */
export const GLOBAL_EXTRA_TAG = "global_extra";

export interface PresetSelection {
  prompt: SessionPrompt;
  /** 预设默认能力；null = 不限制 */
  capabilities: string[] | null;
  sources: SessionPrompt["sources"];
}

export interface PresetChoice {
  agentPresetId?: string | null;
  /** 分组条件的输入：会话此刻用的模型；缺省 = 还没有可用模型（只有「否则」成立） */
  model?: ModelRef | null;
  /** 两份 AGENTS.md 文件（基线时刻读到的原文）；缺省 = 都没有 */
  agentsFiles?: AgentsFiles;
}

export function composeOne(
  presets: PromptPresetStore,
  cards: PromptCardStore,
  preset: PromptPreset,
  model: ModelRef | null,
): { preamble: string; sections: Record<string, string>; userText: string } {
  const detail = presets.detail(preset.id);
  if (!detail) return { preamble: "", sections: {}, userText: "" };
  const cs = cards.getMany(presetCardIds(detail));
  const composed = composePreset(detail, cs, model);
  return {
    preamble: composed.preamble,
    sections: composed.sections,
    userText: composed.userText,
  };
}

/** 预设的「正文」：identity 有就用，否则把各段拼起来（AGENTS.md / 模式这类单段预设）。 */
export const bodyOf = (p: {
  preamble: string;
  sections: Record<string, string>;
}): string => p.preamble || Object.values(p.sections).join("\n\n");

/**
 * 解析一次会话的预设选择。缺省 agent 预设 = 第一张 agent 预设。
 */
export function selectPresets(
  presets: PromptPresetStore,
  cards: PromptCardStore,
  choice: PresetChoice = {},
): PresetSelection {
  const agent =
    (choice.agentPresetId ? presets.get(choice.agentPresetId) : undefined) ??
    presets.list("agent")[0];

  const model = choice.model ?? null;
  const prompt: SessionPrompt = {
    preamble: "",
    sections: {},
    userText: "",
    sources: [],
  };
  let capabilities: string[] | null = null;

  if (agent) {
    const composed = composeOne(presets, cards, agent, model);
    prompt.preamble = composed.preamble;
    Object.assign(prompt.sections, composed.sections);
    prompt.userText = composed.userText;
    capabilities = agent.capabilities;
    prompt.sources.push({ kind: agent.kind, id: agent.id, name: agent.name });
  }

  // 两份固定文件不进 sources（它们不是预设）；顺序固定在 agent 各段之后。
  const agentsFiles = choice.agentsFiles;
  if (agentsFiles?.global)
    prompt.sections[GLOBAL_AGENTSMD_TAG] = agentsFiles.global;

  // 全局附加提示词：按会话此刻的模型求值后注入；不加进能力（它是纯提示词）。
  const extra = presets.activeExtra() ?? presets.list("global-extra")[0];
  if (extra && extra.id !== agent?.id) {
    const body = bodyOf(composeOne(presets, cards, extra, model));
    if (body.trim()) prompt.sections[GLOBAL_EXTRA_TAG] = body;
    prompt.sources.push({
      kind: extra.kind,
      id: extra.id,
      name: extra.name,
    });
  }

  if (agentsFiles?.project)
    prompt.sections[PROJECT_AGENTSMD_TAG] = agentsFiles.project;

  return { prompt, capabilities, sources: prompt.sources };
}

/** 模式的运行时视图；不存在或不是模式预设返回 null。 */
export function modeViewOf(
  presets: PromptPresetStore,
  cards: PromptCardStore,
  id: string,
  model: ModelRef | null = null,
): ModeView | null {
  const preset = presets.get(id);
  if (!preset || preset.kind !== "mode") return null;
  const composed = composeOne(presets, cards, preset, model);
  return {
    id: preset.id,
    name: preset.name,
    text: bodyOf(composed),
    userText: composed.userText,
    ops: {
      limit: preset.capabilities,
      add: preset.capsAdd,
      remove: preset.capsRemove,
    },
  };
}

/** 只取默认能力（创建会话时当配置默认值用）。 */
export function presetDefaults(
  presets: PromptPresetStore,
  cards: PromptCardStore,
  choice: PresetChoice = {},
): { capabilities: string[] | null } {
  const { capabilities } = selectPresets(presets, cards, choice);
  return { capabilities };
}

/** 供依赖注入用的一行封装（服务端与池之间只传函数）。 */
export function makePresetSelector(
  presets: PromptPresetStore,
  cards: PromptCardStore,
): (choice: PresetChoice) => PresetSelection {
  return (choice) => selectPresets(presets, cards, choice);
}

export type { PresetKind };
