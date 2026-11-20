import type { AgentSettingsView } from "../../../api/agentSettings";
import type { DefaultModel } from "../../../api/defaultModel";
import type { Defaults, Tier } from "../../../api/defaults";
import type {
  ModelSpec,
  ProviderView,
  ThinkingLevelName,
} from "../../../api/providers";
import { LEVEL_ORDER } from "../providers/model";

export const LEVEL_CN: Record<ThinkingLevelName, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

/** 设为默认时的启动档位：不能思考为 off，否则取 low，没有 low 取第二档（与 mock 一致）。 */
export function startupLevel(m: ModelSpec): ThinkingLevelName {
  if (m.levels.length < 2) return "off";
  return m.levels.includes("low") ? "low" : (m.levels[1] as ThinkingLevelName);
}

/** 该模型能选的档位：「关闭」永远有，其余按模型声明。 */
export const levelOptions = (m: ModelSpec | undefined): ThinkingLevelName[] =>
  LEVEL_ORDER.filter((l) => !m || l === "off" || m.levels.includes(l));

export interface DefaultPick {
  provider: string;
  model: string;
  thinking: ThinkingLevelName;
}

/**
 * 换供应商或模型后要落到的取值：模型优先用 prefer.model（不在该供应商里取第一个）；
 * 当前档位仍被该模型支持就保留，否则回到启动档位。provider 必须在 list 里且带模型。
 */
export function settle(
  list: readonly ProviderView[],
  provider: string,
  prefer: {
    model?: string;
    thinking: ThinkingLevelName | null;
    /** 刚换了供应商 / 模型：先落在模型声明的默认档位 */
    fresh?: boolean;
  },
): DefaultPick {
  const p = list.find((x) => x.id === provider);
  const spec = p?.models.find((m) => m.id === prefer.model) ?? p?.models[0];
  if (!p || !spec) throw new Error(`provider ${provider} has no model`);
  const keep = prefer.thinking && levelOptions(spec).includes(prefer.thinking);
  const start = spec.defaultLevel;
  if (prefer.fresh && start && spec.levels.includes(start))
    return { provider: p.id, model: spec.id, thinking: start };
  return {
    provider: p.id,
    model: spec.id,
    thinking: keep
      ? (prefer.thinking as ThinkingLevelName)
      : startupLevel(spec),
  };
}

/**
 * 默认值页的草稿：页面上每一项都是一个字段，数字先存成用户敲的文字，保存时再校验、转换。
 * 默认模型走 /default-model，压缩与重试走 /agent-settings，其余走 /defaults，三处的值在这里合成一份。
 */
export interface DefaultsForm {
  model: DefaultModel | null;
  review: DefaultModel | null;
  aux: DefaultModel | null;
  tier: Tier;
  compress: boolean;
  maxWidth: string;
  maxHeight: string;
  maxKiB: string;
  jpegQuality: string;
  thumbSide: string;
  thumbQuality: string;
  gifMB: string;
  sourceMB: string;
  assetGitMB: string;
  uploadMB: string;
  remindMin: string;
  /** 目标续跑不限轮数；为真时 goalRounds 不校验、不保存 */
  goalUnlimited: boolean;
  goalRounds: string;
  maxDepth: string;
  perCaller: string;
  perTree: string;
  start: string;
  compactOn: boolean;
  compactReserve: string;
  compactKeep: string;
  retryOn: boolean;
  retryMax: string;
}

type AgentKey =
  | "compactOn"
  | "compactReserve"
  | "compactKeep"
  | "retryOn"
  | "retryMax";

export const fromDefaults = (
  d: Defaults,
): Omit<DefaultsForm, "model" | AgentKey> => ({
  review: d.reviewModel,
  aux: d.auxModel,
  tier: d.permissionTier,
  compress: d.imageCompression.enabled,
  maxWidth: String(d.imageCompression.maxWidth),
  maxHeight: String(d.imageCompression.maxHeight),
  maxKiB: String(Math.round(d.imageCompression.maxBytes / 1024)),
  jpegQuality: String(d.imageCompression.jpegQuality),
  thumbSide: String(d.canvasMedia.thumbMaxSide),
  thumbQuality: String(d.canvasMedia.thumbQuality),
  gifMB: String(d.canvasMedia.gifMaxMB),
  sourceMB: String(d.canvasMedia.sourceMaxMB),
  assetGitMB: String(d.canvasMedia.assetGitMaxMB),
  uploadMB: String(d.canvasMedia.uploadMaxMB),
  remindMin: String(Math.round(d.jobRemindSeconds / 60)),
  goalUnlimited: d.goalMaxRounds === null,
  goalRounds: String(d.goalMaxRounds ?? 50),
  maxDepth: String(d.subagentLimits.maxDepth),
  perCaller: String(d.subagentLimits.perCaller),
  perTree: String(d.subagentLimits.perTree),
  start: d.directoryStart,
});

/** 文件里没写的项显示 pi 自己的值（它们就是实际生效的值）。 */
export const fromAgent = (
  a: AgentSettingsView,
): Pick<DefaultsForm, AgentKey> => {
  const { compaction: c, retry: r } = a.values;
  const base = a.defaults;
  return {
    compactOn: c.enabled ?? base.compaction.enabled,
    compactReserve: String(c.reserveTokens ?? base.compaction.reserveTokens),
    compactKeep: String(c.keepRecentTokens ?? base.compaction.keepRecentTokens),
    retryOn: r.enabled ?? base.retry.enabled,
    retryMax: String(r.maxRetries ?? base.retry.maxRetries),
  };
};

export const formOf = (
  model: DefaultModel | null,
  d: Defaults,
  a: AgentSettingsView,
): DefaultsForm => ({ model, ...fromDefaults(d), ...fromAgent(a) });

type NumKey =
  | "maxWidth"
  | "maxHeight"
  | "maxKiB"
  | "jpegQuality"
  | "thumbSide"
  | "thumbQuality"
  | "gifMB"
  | "sourceMB"
  | "assetGitMB"
  | "uploadMB"
  | "remindMin"
  | "goalRounds"
  | "maxDepth"
  | "perCaller"
  | "perTree"
  | "compactReserve"
  | "compactKeep"
  | "retryMax";
export type FieldKey = NumKey | "start";
export type Errors = Partial<Record<FieldKey, string>>;

// 范围与服务端 store/defaults.ts、session/agent-settings.ts 一致；图片尺寸与体积的上限取 pi 的默认值（只能收得更紧）。
export const RANGE: Record<
  NumKey,
  { min: number; max: number; label: string }
> = {
  maxWidth: { min: 256, max: 2000, label: "最大宽度" },
  maxHeight: { min: 256, max: 2000, label: "最大高度" },
  maxKiB: { min: 64, max: 4608, label: "编码上限" },
  jpegQuality: { min: 10, max: 100, label: "JPEG 质量" },
  thumbSide: { min: 256, max: 4096, label: "缩略图最长边" },
  thumbQuality: { min: 10, max: 100, label: "缩略图质量" },
  gifMB: { min: 1, max: 200, label: "GIF 原样上限" },
  sourceMB: { min: 1, max: 200, label: "原图上限" },
  assetGitMB: { min: 1, max: 1000, label: "进历史的资源上限" },
  uploadMB: { min: 1, max: 4096, label: "单个文件上限" },
  remindMin: { min: 1, max: 1440, label: "提醒间隔" },
  goalRounds: { min: 1, max: 10000, label: "轮数上限" },
  maxDepth: { min: 1, max: 10, label: "最大深度" },
  perCaller: { min: 1, max: 100, label: "每个调用方同时存活" },
  perTree: { min: 1, max: 500, label: "整棵树同时存活" },
  compactReserve: { min: 4096, max: 65536, label: "预留余量" },
  compactKeep: { min: 4000, max: 200000, label: "保留最近" },
  retryMax: { min: 0, max: 10, label: "重试次数" },
};

const NUM_KEYS = Object.keys(RANGE) as NumKey[];

const intOf = (raw: string, k: NumKey): number | null => {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= RANGE[k].min && n <= RANGE[k].max ? n : null;
};

export function errorsOf(f: DefaultsForm): Errors {
  const out: Errors = {};
  for (const k of NUM_KEYS) {
    if (k === "goalRounds" && f.goalUnlimited) continue;
    if (intOf(f[k], k) === null)
      out[k] = `${RANGE[k].label}要是 ${RANGE[k].min}–${RANGE[k].max} 的整数`;
  }
  if (f.start.trim() === "") out.start = "起点不能为空";
  return out;
}

const samePick = (a: DefaultModel | null, b: DefaultModel | null) =>
  a?.provider === b?.provider &&
  a?.model === b?.model &&
  a?.thinking === b?.thinking;

const COMPRESS_KEYS = [
  "compress",
  "maxWidth",
  "maxHeight",
  "maxKiB",
  "jpegQuality",
] as const;
const LIMIT_KEYS = ["maxDepth", "perCaller", "perTree"] as const;
const MEDIA_KEYS = [
  "thumbSide",
  "thumbQuality",
  "gifMB",
  "sourceMB",
  "assetGitMB",
  "uploadMB",
] as const;

/** 与已保存值不同的项，按接口拆开：保存时只发这些（压缩与重试的补丁见 agent.ts）。调用前要先过 errorsOf。 */
export function changesOf(
  d: DefaultsForm,
  s: DefaultsForm,
): { model: DefaultModel | null; defaults: Partial<Defaults> } {
  const n = (k: NumKey) => intOf(d[k], k) as number;
  const defaults: Partial<Defaults> = {};
  if (d.tier !== s.tier) defaults.permissionTier = d.tier;
  if (!samePick(d.review, s.review)) defaults.reviewModel = d.review;
  if (!samePick(d.aux, s.aux)) defaults.auxModel = d.aux;
  if (d.start !== s.start) defaults.directoryStart = d.start.trim();
  if (d.remindMin !== s.remindMin)
    defaults.jobRemindSeconds = n("remindMin") * 60;
  if (
    d.goalUnlimited !== s.goalUnlimited ||
    (!d.goalUnlimited && d.goalRounds !== s.goalRounds)
  )
    defaults.goalMaxRounds = d.goalUnlimited ? null : n("goalRounds");
  if (COMPRESS_KEYS.some((k) => d[k] !== s[k]))
    defaults.imageCompression = {
      enabled: d.compress,
      maxWidth: n("maxWidth"),
      maxHeight: n("maxHeight"),
      maxBytes: n("maxKiB") * 1024,
      jpegQuality: n("jpegQuality"),
    };
  if (MEDIA_KEYS.some((k) => d[k] !== s[k]))
    defaults.canvasMedia = {
      thumbMaxSide: n("thumbSide"),
      thumbQuality: n("thumbQuality"),
      gifMaxMB: n("gifMB"),
      sourceMaxMB: n("sourceMB"),
      assetGitMaxMB: n("assetGitMB"),
      uploadMaxMB: n("uploadMB"),
    };
  if (LIMIT_KEYS.some((k) => d[k] !== s[k]))
    defaults.subagentLimits = {
      maxDepth: n("maxDepth"),
      perCaller: n("perCaller"),
      perTree: n("perTree"),
    };
  return { model: samePick(d.model, s.model) ? null : d.model, defaults };
}
