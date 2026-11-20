import type {
  AuthMethod,
  CredentialTier,
  KeyStorage,
  ModelSource,
  ModelSpec,
  ProviderApi,
  ProviderView,
  ThinkingLevelName,
} from "../../../api/providers";
import type { DotProps } from "../../../ui";
import { summarizeLastTest } from "./diagnose";

// 登录方式分三大类：订阅登录、云凭据、API Key（环境变量与命令也是取得 API Key 的方式，归在这一类）。
export type Primary = "oauth" | "ambient" | "key";
export const PRIMARY_LABEL: Record<Primary, string> = {
  oauth: "订阅登录",
  ambient: "环境凭据",
  key: "API Key",
};
export const primaryOf = (m: AuthMethod): Primary =>
  m === "oauth" || m === "ambient" ? m : "key";
export const primariesOf = (p: ProviderView): Primary[] => [
  ...new Set(p.methods.map(primaryOf)),
];

// 值 auth 是历史命名：密钥实际存在服务端密码库，并不在 pi 的 auth.json 里。
// models.json 目前只出现在预览里（服务端不写盘），所以不提供这个保存位置。
export const STORAGE_LABEL: Partial<Record<KeyStorage, string>> = {
  auth: "密码库",
  session: "仅本次运行",
};

/** 订阅登录时：pi 的凭据里有没有这个供应商（auth.json 那一层命中） */
export const loggedIn = (p: ProviderView): boolean =>
  p.credential.chain.some((t) => t.source === "auth.json" && t.hit);

export const API_LABEL: Record<ProviderApi, string> = {
  "openai-completions": "OpenAI 兼容（Chat Completions）",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Generative AI",
};

export const isProviderApi = (v: string | undefined): v is ProviderApi =>
  v !== undefined && v in API_LABEL;

/** 内置供应商的协议可能不在四种里：没有中文标签就如实显示协议名。 */
export const apiLabel = (api: string): string =>
  isProviderApi(api) ? API_LABEL[api] : api;

/**
 * 「从端点获取」不可用的原因；可用返回 null。
 * 内置供应商探测不了端点时改列目录里的模型，所以只有没有 Base URL 的自定义端点会被挡。
 */
export function fetchBlock(p: ProviderView): string | null {
  return p.probeable || !p.custom
    ? null
    : "没有可用的 Base URL，无法从端点获取模型。先在「连接」里填写地址，或手动添加。";
}

// 占位只描述形状，不写完整地址：源码里不出现任何 http(s) 字面量（见 tokens.test.ts 的 R2）。
export const API_PLACEHOLDER: Record<ProviderApi, string> = {
  "openai-completions": "端点地址，如 host/v1",
  "openai-responses": "端点地址，如 host/v1",
  "anthropic-messages": "端点地址，如 host/v1",
  "google-generative-ai": "端点地址，如 host/v1beta",
};

// 解析链四层，顺序即优先级（高→低）。
export const TIER_LABEL: Record<CredentialTier["source"], string> = {
  "--api-key": "运行时 --api-key",
  // 这一层既包括 pi 自己存的凭据（auth.json，含订阅登录），也包括保存位置选「密码库」的密钥
  "auth.json": "auth.json / 密码库",
  "models.json": "models.json",
  env: "环境变量 / 云凭据",
};

export const LEVEL_ORDER: readonly ThinkingLevelName[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// pi 默认支持的五档；新开启思考时先勾这五档，由用户取消不支持的。
export const DEFAULT_LEVELS: ThinkingLevelName[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

export interface StatusInfo {
  tone: NonNullable<DotProps["tone"]>;
  label: string;
}

/** 状态点：绿=已连接，琥珀=待核验，红=上次测试失败，灰=未配置（订阅登录方式下叫「未登录」）。 */
export function statusInfo(p: ProviderView): StatusInfo {
  if (p.status === "ok") return { tone: "live", label: "已连接" };
  if (p.status === "off")
    return { tone: "idle", label: p.method === "oauth" ? "未登录" : "未配置" };
  if (p.lastTest && !p.lastTest.ok)
    return { tone: "danger", label: "连接失败" };
  return { tone: "warn", label: "待核验" };
}

/**
 * 左侧只列用户添加过的：自定义端点全部；内置的要么库里有记录，要么是这次刚挑出来的。
 * 只有环境变量凭据的内置供应商不上架，否则用户删不掉它。自定义在前，内置按名称排序。
 */
export function railOf(
  list: readonly ProviderView[],
  picked: ReadonlySet<string>,
): ProviderView[] {
  const byName = (a: ProviderView, b: ProviderView) =>
    a.name.localeCompare(b.name);
  return [
    ...list.filter((p) => p.custom),
    ...list
      .filter((p) => !p.custom && (p.added || picked.has(p.id)))
      .sort(byName),
  ];
}

/** 列表里的 26px 字母标记。 */
export const monogram = (name: string): string =>
  Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "?";

/** 由名称推出标识：小写字母/数字/连字符；纯中文名会得到空串，由用户自己填。 */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const needsFill = (m: ModelSpec): boolean => m.ctx <= 0 || m.out <= 0;
export const hasVision = (m: ModelSpec): boolean => m.input.includes("image");

export function blankModel(id: string, source: ModelSource): ModelSpec {
  return {
    id,
    name: id,
    reasoning: false,
    levels: [],
    input: ["text"],
    ctx: 0,
    out: 0,
    source,
  };
}

/** 15000 → 15k，200000 → 200k，1048576 → 1.0M。 */
export function fmtTokens(n: number): string {
  if (n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const COUNT_UNIT = { k: 1024, m: 1024 * 1024 } as const;

/**
 * token 数输入：空串 = 0（未填）；纯数字，或带 K / M 单位（不分大小写，可带小数）。
 * K、M 按 1024 算，和模型厂商说的「256K」「1M」一致：256K = 262144，1M = 1048576。非法返回 null。
 */
export function parseCount(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (t === "") return 0;
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(t);
  if (!m) return null;
  const n = Math.round(
    Number(m[1]) * (m[2] ? COUNT_UNIT[m[2] as "k" | "m"] : 1),
  );
  return n <= 999_999_999 ? n : null;
}

export const levelsInOrder = (levels: readonly ThinkingLevelName[]) =>
  LEVEL_ORDER.filter((l) => levels.includes(l));

/** 左列表的搜索：名称、标识、协议。 */
export function matchesProvider(p: ProviderView, q: string): boolean {
  const s = q.trim().toLowerCase();
  return (
    s === "" ||
    `${p.name} ${p.id} ${p.api ? apiLabel(p.api) : ""}`
      .toLowerCase()
      .includes(s)
  );
}

/** 悬停卡片里的事实：行里放不下的协议、地址、凭据来源、模型数、上次测试。 */
export function peekFacts(p: ProviderView): [string, string][] {
  const src = p.credential.source;
  const last = p.lastTest;
  return [
    ["协议", p.api ? apiLabel(p.api) : "—"],
    ["地址", p.baseUrl ?? "内置端点"],
    ["凭据", src ? TIER_LABEL[src] : "没有找到可用凭据"],
    ["模型", `${p.models.length} 个`],
    ["上次测试", last ? summarizeLastTest(last) : "还没测过"],
  ];
}
