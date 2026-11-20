import type { CallTokens } from "../../../api";
import type { UsageStat } from "./conversation";

// 指标行与三个弹层的纯计算。不输出任何成本；算不出来的一律 null，不编造。
// 百分比一律配绝对值（模型窗口不统一，只看百分比没有意义）。

/** 1234 -> 1.2k，1500000 -> 1.5M。 */
export function fmtTokens(n: number): string {
  const v = Math.round(n);
  if (v >= 1_000_000)
    return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (v >= 1000)
    return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(v);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

const pct1 = (x: number): number => Math.round(x * 10) / 10;

export interface Metrics {
  turns: number | null;
  steps: number | null;
  tps: number | null;
  /** 累计输入 + 输出 */
  tokensTotal: number | null;
  /** 缓存读取占输入的百分比，一位小数 */
  cacheHitPct: number | null;
  /** 形如 `94.2% 1.1M/1.2M`：命中的缓存读取 / 累计输入 */
  cacheLabel: string | null;
  ctxPct: number | null;
  ctxUsed: number | null;
  ctxWindow: number | null;
  /** 形如 `38% 76k/200k`；窗口未知时只有占用 `76k/—` */
  ctxLabel: string | null;
}

export interface SessionStats {
  turns: number;
  steps: number;
  modelMs: number | null;
  /** 服务端统计不到数据时为 null */
  toolMs: number | null;
  ttftMs: number | null;
  tps: number | null;
}

export interface TokenStats {
  /** 输入 + 输出 */
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  /** 输入 - 缓存读取 */
  uncachedInput: number;
  hitPct: number | null;
}

export interface ContextPart {
  key: "system" | "tools" | "messages";
  label: string;
  tokens: number;
  /** 占当前窗口占用的百分比 */
  pct: number;
}

export interface ContextBreakdown {
  used: number;
  window: number | null;
  /** 占用占窗口的百分比；窗口未知为 null */
  pct: number | null;
  label: string;
  /** 三段是服务端按字符数分摊的估算；true 时界面要标「约」 */
  estimated: boolean;
  /** 没有任何分段数据时为 null，只剩总占用 */
  parts: ContextPart[] | null;
}

export interface MetricsView {
  line: Metrics;
  session: SessionStats | null;
  tokens: TokenStats | null;
  context: ContextBreakdown | null;
}

export const emptyMetrics: Metrics = {
  turns: null,
  steps: null,
  tps: null,
  tokensTotal: null,
  cacheHitPct: null,
  cacheLabel: null,
  ctxPct: null,
  ctxUsed: null,
  ctxWindow: null,
  ctxLabel: null,
};

const PART_LABEL = {
  system: "系统提示词",
  tools: "工具定义",
  messages: "对话消息",
} as const;

// 最大余数法：整数份额之和恰好等于 total。
function share(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => [r - Math.floor(r), i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left -= 1;
  }
  return out;
}

const ctxLabel = (used: number, window: number | null): string =>
  window && window > 0
    ? `${Math.round((used / window) * 100)}% ${fmtTokens(used)}/${fmtTokens(window)}`
    : `${fmtTokens(used)}/—`;

// 取最近一次调用的 system / tools / history+current 比例，摊到当前窗口占用上，与审计页同一套比例。
// 没有最近一次调用时退回 /usage 自带的 system / tools 分段（同样是估算）。
function breakdown(
  usage: UsageStat,
  last: CallTokens | null,
): ContextBreakdown | null {
  const c = usage.context;
  if (!c) return null;
  const base = {
    used: c.used,
    window: c.window,
    pct:
      c.window && c.window > 0 ? Math.round((c.used / c.window) * 100) : null,
    label: ctxLabel(c.used, c.window),
  };
  let weights: [number, number, number] | null = null;
  let estimated = true;
  if (last) {
    weights = [last.system, last.tools, last.history + last.current];
    estimated = last.estimated;
  } else if (c.system !== undefined && c.tools !== undefined) {
    weights = [c.system, c.tools, c.messages];
  }
  if (!weights || weights.every((w) => w <= 0))
    return { ...base, estimated, parts: null };
  const tokens = share(weights, c.used);
  const pcts = share(tokens, 100);
  const keys = ["system", "tools", "messages"] as const;
  return {
    ...base,
    estimated,
    parts: keys.map((key, i) => ({
      key,
      label: PART_LABEL[key],
      tokens: tokens[i] ?? 0,
      pct: pcts[i] ?? 0,
    })),
  };
}

// 输出 = 模型用时 × TPS：服务端没给用时、但输出与速度都在时，按 输出 ÷ 速度 反推；否则 null。
function modelMsOf(u: UsageStat): number | null {
  if (u.modelMs !== null) return u.modelMs;
  const tps = u.tokensPerSecond;
  return tps && tps > 0 && u.tokens.output > 0
    ? Math.round((u.tokens.output / tps) * 1000)
    : null;
}

/** usage 为会话累计用量（snapshot 或 /usage），lastCall 为最近一次调用的 tokens；两者都可缺。 */
export function computeMetrics(
  usage: UsageStat | null,
  lastCall: CallTokens | null = null,
): MetricsView {
  if (!usage)
    return { line: emptyMetrics, session: null, tokens: null, context: null };
  const { input, output, cacheRead } = usage.tokens;
  const hitPct = input > 0 ? pct1((cacheRead / input) * 100) : null;
  const context = breakdown(usage, lastCall);
  return {
    line: {
      turns: usage.turns,
      steps: usage.steps,
      tps: usage.tokensPerSecond,
      tokensTotal: input + output,
      cacheHitPct: hitPct,
      cacheLabel:
        hitPct === null
          ? null
          : `${hitPct}% ${fmtTokens(cacheRead)}/${fmtTokens(input)}`,
      ctxPct: context?.pct ?? null,
      ctxUsed: context?.used ?? null,
      ctxWindow: context?.window ?? null,
      ctxLabel: context?.label ?? null,
    },
    session: {
      turns: usage.turns,
      steps: usage.steps,
      modelMs: modelMsOf(usage),
      toolMs: usage.toolMs,
      ttftMs: usage.ttftMs,
      tps: usage.tokensPerSecond,
    },
    tokens: {
      total: input + output,
      input,
      output,
      cacheRead,
      uncachedInput: Math.max(0, input - cacheRead),
      hitPct,
    },
    context,
  };
}
