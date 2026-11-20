// 模型选单与推理强度的纯逻辑：分组、搜索、档位回落、会话当前模型的解析。

import type { DefaultModel } from "../../../api/defaultModel";
import type {
  AuthMethod,
  ModelSpec,
  ProviderView,
  ThinkingLevelName,
} from "../../../api/providers";
import { THINKING_LEVELS } from "../../../api/providers";
import type { ConfigModel } from "../../../api/sessionConfig";

export const LEVEL_LABEL: Record<string, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

export const levelLabel = (l: string): string => LEVEL_LABEL[l] ?? l;

const AUTH_LABEL: Record<AuthMethod, string> = {
  oauth: "订阅",
  key: "API Key",
  env: "环境变量",
  cmd: "命令",
  ambient: "环境凭据",
};

export const authLabel = (p: ProviderView): string => AUTH_LABEL[p.method];

/** 200000 -> 200K，1000000 -> 1M；窗口未知为 — */
export function fmtCtx(n: number): string {
  if (!n || n <= 0) return "—";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}

/**
 * 会话可以指定的供应商：已配置凭据，且最近一次测试没有失败。
 * 自定义端点没点过「测试连接」时状态是 warn（待核验），但它没有失败记录，不应被挡在选单外。
 */
export const selectableProviders = (ps: readonly ProviderView[]) =>
  ps.filter((p) => p.status !== "off" && p.lastTest?.ok !== false);

/** 模型声明的思考级别；不支持思考的模型只有「关」 */
export const levelsOf = (spec: ModelSpec | undefined): ThinkingLevelName[] =>
  spec && spec.levels.length > 0 ? spec.levels : ["off"];

const rank = (l: string) => THINKING_LEVELS.indexOf(l as ThinkingLevelName);

/** 想要的档位若被声明就沿用；否则落到声明里最近的一档，同距取低，绝不用未声明的级别 */
export function nearestLevel(levels: readonly string[], want: string): string {
  if (levels.includes(want)) return want;
  const w = rank(want);
  const ranked = levels.filter((l) => rank(l) >= 0);
  if (w < 0 || ranked.length === 0) return levels[0] ?? "off";
  let best = ranked[0] as string;
  for (const l of ranked) {
    const d = Math.abs(rank(l) - w);
    const bd = Math.abs(rank(best) - w);
    if (d < bd || (d === bd && rank(l) < rank(best))) best = l;
  }
  return best;
}

/**
 * 换到一个模型时的思考档位：模型声明了默认档位就用它；否则沿用当前档位，
 * 不支持就落到声明里最近的一档。同一个模型里只改档位不走这里。
 */
export function levelOnSwitch(
  spec: ModelSpec | undefined,
  current: string | null | undefined,
): string {
  const levels = levelsOf(spec);
  const start = spec?.defaultLevel;
  return start && levels.includes(start)
    ? start
    : nearestLevel(levels, current ?? "medium");
}

/** 档位选项；有映射的标 `high → xhigh` */
export const levelOptions = (spec: ModelSpec | undefined) =>
  levelsOf(spec).map((level) => {
    const to = spec?.map?.[level];
    return {
      level,
      label: levelLabel(level),
      map: to && to !== level ? `${level} → ${to}` : null,
    };
  });

export interface ModelRow {
  provider: ProviderView;
  spec: ModelSpec;
}

export interface ModelGroup {
  provider: ProviderView;
  auth: string;
  rows: ModelRow[];
}

/** 可选供应商按组列出；搜索匹配名称 / id / 供应商 / 认证方式，只保留命中的组 */
export function groupModels(
  providers: readonly ProviderView[],
  query: string,
): ModelGroup[] {
  const q = query.trim().toLowerCase();
  return selectableProviders(providers).flatMap((provider) => {
    const auth = authLabel(provider);
    const rows = provider.models
      .filter(
        (spec) =>
          !q ||
          [spec.name, spec.id, provider.name, provider.id, auth].some((s) =>
            s.toLowerCase().includes(q),
          ),
      )
      .map((spec) => ({ provider, spec }));
    return rows.length ? [{ provider, auth, rows }] : [];
  });
}

export const countModels = (providers: readonly ProviderView[]): number =>
  selectableProviders(providers).reduce((n, p) => n + p.models.length, 0);

export interface CurrentModel {
  provider: string;
  model: string;
  /** 当前思考档位；没有声明时为 null */
  reasoning: string | null;
  /** 取自 agent（会话没有显式指定） */
  followsDefault: boolean;
}

/**
 * 会话当前用哪个模型：显式指定 > agent 显式模型 > 全局默认模型（agent 也跟随默认时）。
 * agent 还没读到、或读不到全局默认时返回 null（界面如实显示「默认模型」，不猜）。
 */
export function currentModel(
  model: ConfigModel | undefined,
  globalDefault: DefaultModel | null,
): CurrentModel | null {
  if (!model) return null;
  if (model.mode === "explicit")
    return {
      provider: model.provider,
      model: model.model,
      reasoning: model.reasoning,
      followsDefault: false,
    };
  if (!globalDefault) return null;
  // thinking 为 null = 沿用模型自己的默认档，界面显示「默认」
  return {
    provider: globalDefault.provider,
    model: globalDefault.model,
    reasoning: globalDefault.thinking,
    followsDefault: true,
  };
}

export const specOf = (
  providers: readonly ProviderView[],
  provider: string,
  model: string,
): ModelSpec | undefined =>
  providers.find((p) => p.id === provider)?.models.find((m) => m.id === model);
