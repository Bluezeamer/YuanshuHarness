// 「提示词与能力」接口客户端。
import { call, enc, loadToken, request } from "./http";

export interface StudioCard {
  id: string;
  group: string;
  title: string;
  body: string;
  builtin: boolean;
  origin: "pi" | "ours" | "user";
  copyOf: string | null;
  /** 有几份预设在用 */
  usedBy: number;
}

export interface StudioCardGroup {
  group: string;
  cards: StudioCard[];
}

export type PresetKind =
  | "global-agentsmd"
  | "project-agentsmd"
  | "global-extra"
  | "agent"
  | "mode";

/** 分组条件：现在只有「模型」一种；providers = 整个供应商，models = "供应商id/模型id" */
export interface StudioCond {
  kind: "model";
  providers: string[];
  models: string[];
}

/** 分组里的一张卡片；when 为 null = 否则（保底） */
export interface StudioCase {
  cardId: string;
  when: StudioCond | null;
}

export type StudioItem =
  | { kind: "card"; cardId: string }
  | { kind: "group"; id: string; name: string; cards: StudioCase[] };

/** 预设里的一段：直接挂的卡片与分组按顺序放在 items 里 */
export interface StudioNode {
  id: string;
  /** 段名；null = 头部（identity，裸文本） */
  tag: string | null;
  title: string;
  slotKind: "custom" | "system" | "system_content";
  channel: "system" | "user";
  /** 由 pi 渲染或我们生成，不可编辑 */
  builtin: boolean;
  items: StudioItem[];
}

export interface StudioPreset {
  id: string;
  kind: PresetKind;
  name: string;
  description: string;
  active: boolean;
  /** 默认能力集合；null = 不限制。对模式即「限定为」 */
  capabilities: string[] | null;
  /** 模式的「增加」「减少」；其他预设恒为空 */
  capsAdd: string[];
  capsRemove: string[];
  updatedAt: string;
  /** 引用它的会话数（含已归档），只有 Agent 带；大于 0 时不能删 */
  refCount?: number;
}

export interface StudioPresetDetail extends StudioPreset {
  nodes: StudioNode[];
}

const token = () => loadToken();

export const listCards = () =>
  call(
    "GET",
    "/api/v1/studio/cards",
    token(),
    undefined,
    (b: { groups: StudioCardGroup[] }) => b.groups,
  );

export const createCard = (input: {
  group: string;
  title: string;
  body: string;
}) =>
  call("POST", "/api/v1/studio/cards", token(), input, (b: StudioCard) => b);

export const patchCard = (
  id: string,
  patch: Partial<Pick<StudioCard, "group" | "title" | "body">>,
) =>
  call(
    "PATCH",
    `/api/v1/studio/cards/${enc(id)}`,
    token(),
    patch,
    (b: StudioCard) => b,
  );

export const copyCard = (id: string) =>
  call(
    "POST",
    `/api/v1/studio/cards/${enc(id)}/copy`,
    token(),
    {},
    (b: StudioCard) => b,
  );

export const deleteCard = (id: string) =>
  call(
    "DELETE",
    `/api/v1/studio/cards/${enc(id)}`,
    token(),
    undefined,
    (b: null) => b,
  );

/** 新建一个空分组；重名 409（ApiError，code 为 exists） */
export const createCardGroup = (name: string) =>
  request<{ group: string }>("POST", "/api/v1/studio/card-groups", token(), {
    name,
  });

/** 删分组：里面还有卡片 409（code 为 not_empty） */
export const deleteCardGroup = (name: string) =>
  request("DELETE", `/api/v1/studio/card-groups/${enc(name)}`, token());

export const listPresets = (kind?: PresetKind) =>
  call(
    "GET",
    `/api/v1/studio/presets${kind ? `?kind=${enc(kind)}` : ""}`,
    token(),
    undefined,
    (b: { presets: StudioPreset[] }) => b.presets,
  );

export const getPreset = (id: string) =>
  call(
    "GET",
    `/api/v1/studio/presets/${enc(id)}`,
    token(),
    undefined,
    (b: { preset: StudioPresetDetail }) => b.preset,
  );

export const createPreset = (input: {
  kind: PresetKind;
  name: string;
  description?: string;
}) =>
  call(
    "POST",
    "/api/v1/studio/presets",
    token(),
    input,
    (b: StudioPreset) => b,
  );

export const patchPreset = (
  id: string,
  patch: {
    name?: string;
    description?: string;
    capabilities?: string[] | null;
    capsAdd?: string[];
    capsRemove?: string[];
  },
) =>
  call(
    "PATCH",
    `/api/v1/studio/presets/${enc(id)}`,
    token(),
    patch,
    (b: unknown) => b,
  );

/** 设为生效。全局 AGENTS.md 版本会写文件：磁盘上的文件被手改过且没带 overwrite 时抛 ApiError（code 为 disk_modified） */
export const activatePreset = (id: string, overwrite = false) =>
  request<{ ok: true }>(
    "POST",
    `/api/v1/studio/presets/${enc(id)}/activate`,
    token(),
    overwrite ? { overwrite: true } : {},
  );

export const deletePreset = (id: string) =>
  call(
    "DELETE",
    `/api/v1/studio/presets/${enc(id)}`,
    token(),
    undefined,
    (b: null) => b,
  );

export const copyPreset = (id: string) =>
  call(
    "POST",
    `/api/v1/studio/presets/${enc(id)}/copy`,
    token(),
    {},
    (b: StudioPreset) => b,
  );

/** 整份替换预设的段（含分组与条件）；不合法时 400 的 detail 是一句可以直接给用户看的话 */
export const saveNodes = (
  presetId: string,
  nodes: StudioNode[],
  overwrite = false,
) =>
  request<{ preset: StudioPresetDetail }>(
    "PUT",
    `/api/v1/studio/presets/${enc(presetId)}/nodes${overwrite ? "?overwrite=1" : ""}`,
    token(),
    { nodes },
  );

// ---- 工具描述覆盖 ----

export interface ToolDescriptionOverride {
  name: string;
  description: string;
  updatedAt: string;
}

/** overrides 是调优覆盖；originals 是模型实际收到的原文（会话创建时记下，没有会话跑过就是空）。 */
export const listToolDescriptions = () =>
  call(
    "GET",
    "/api/v1/studio/tool-descriptions",
    token(),
    undefined,
    (b: {
      descriptions: ToolDescriptionOverride[];
      originals: Record<string, string>;
    }) => ({ overrides: b.descriptions, originals: b.originals }),
  );

export const setToolDescription = (name: string, description: string) =>
  call(
    "PUT",
    `/api/v1/studio/tool-descriptions/${enc(name)}`,
    token(),
    { description },
    (b: ToolDescriptionOverride) => b,
  );

export const removeToolDescription = (name: string) =>
  call(
    "DELETE",
    `/api/v1/studio/tool-descriptions/${enc(name)}`,
    token(),
    undefined,
    () => {},
  );
