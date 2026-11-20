// 一次模型调用的 token 拆分：system / tools / history / current / out。
// 估算方式：按各段在请求体里的字符数占比分摊供应商上报的总 input；没有上报时按约 3 字符 / token 估。

export interface ReportedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CallTokens {
  system: number;
  tools: number;
  history: number;
  current: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  estimated: boolean;
}

const CHARS_PER_TOKEN = 3;

const len = (v: unknown): number =>
  v === undefined || v === null
    ? 0
    : typeof v === "string"
      ? v.length
      : JSON.stringify(v).length;

type Item = { role?: unknown; type?: unknown };
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

// 对话项在不同协议里的字段不同：messages（chat / anthropic / bedrock）、input（responses）、contents（google）。
function conversation(p: Record<string, unknown>): Item[] {
  for (const k of ["messages", "input", "contents"]) {
    const v = p[k];
    if (Array.isArray(v)) return v.filter(isObj);
  }
  return [];
}

const isSystem = (m: Item) => m.role === "system" || m.role === "developer";
// 模型这一侧的项：它之后的内容才是「本轮」新增的输入。
const isModelSide = (m: Item) =>
  m.role === "assistant" ||
  m.role === "model" ||
  m.type === "function_call" ||
  m.type === "reasoning";

/** 请求里的对话项数（非 system / developer）；审计按它给每次调用划新增区间。 */
export function messageCount(payload: unknown): number {
  const p = isObj(payload) ? payload : {};
  return conversation(p).filter((m) => !isSystem(m)).length;
}

/** 把请求体切成四段的字符数。 */
export function segmentChars(payload: unknown): {
  system: number;
  tools: number;
  history: number;
  current: number;
} {
  const p = isObj(payload) ? payload : {};
  const items = conversation(p);
  const sys = items.filter(isSystem);
  const rest = items.filter((m) => !isSystem(m));
  let cut = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i] && isModelSide(rest[i] as Item)) {
      cut = i + 1;
      break;
    }
  }
  const sum = (xs: Item[]) => xs.reduce((n, m) => n + len(m), 0);
  return {
    system:
      len(p.system) + len(p.instructions) + len(p.systemInstruction) + sum(sys),
    tools: len(p.tools) + len(p.toolConfig),
    history: sum(rest.slice(0, cut)),
    current: sum(rest.slice(cut)),
  };
}

// 最大余数法：整数份额之和恰好等于 total。
function apportion(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0)
    return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  const exact = weights.map((w) => (w * total) / sum);
  const out = exact.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => [x - Math.floor(x), i] as const)
    .sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    rest -= 1;
  }
  return out;
}

/**
 * 供应商的 input 不含缓存读写（pi 统一了口径），所以整次请求的输入量 = input + cacheRead + cacheWrite；
 * 四段之和等于它，cacheRead / cacheWrite 另列。
 */
export function splitTokens(
  payload: unknown,
  usage: ReportedUsage,
  responseChars: number,
): CallTokens {
  const c = segmentChars(payload);
  const weights = [c.system, c.tools, c.history, c.current];
  const reported = usage.input + usage.cacheRead + usage.cacheWrite;
  const parts =
    reported > 0
      ? apportion(weights, reported)
      : weights.map((w) => Math.ceil(w / CHARS_PER_TOKEN));
  const outReported = usage.output > 0;
  return {
    system: parts[0] ?? 0,
    tools: parts[1] ?? 0,
    history: parts[2] ?? 0,
    current: parts[3] ?? 0,
    out: outReported
      ? usage.output
      : Math.ceil(responseChars / CHARS_PER_TOKEN),
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    estimated: reported === 0 || (!outReported && responseChars > 0),
  };
}
