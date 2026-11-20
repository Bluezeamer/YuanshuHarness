import { expect, test } from "vitest";
import type { CallTokens } from "../../../api";
import type { UsageStat } from "./conversation";
import {
  computeMetrics,
  emptyMetrics,
  fmtDuration,
  fmtTokens,
} from "./metrics";

const usage: UsageStat = {
  turns: 2,
  steps: 11,
  tokensPerSecond: 64.2,
  modelMs: 51_700,
  toolMs: null,
  ttftMs: null,
  tokens: {
    input: 1_000_000,
    output: 200_000,
    cacheRead: 940_000,
    cacheWrite: 0,
  },
  cacheHitRate: 0.94,
  context: {
    used: 76_000,
    window: 200_000,
    messages: 70_000,
    system: 2000,
    tools: 4000,
  },
};

const last: CallTokens = {
  system: 100,
  tools: 300,
  history: 400,
  current: 200,
  out: 50,
  cacheRead: 0,
  cacheWrite: 0,
  estimated: true,
};

test("没有 usage：指标行全空，三个弹层数据都是 null", () => {
  const v = computeMetrics(null);
  expect(v.line).toEqual(emptyMetrics);
  expect(v.session).toBeNull();
  expect(v.tokens).toBeNull();
  expect(v.context).toBeNull();
});

test("指标行：轮次步数、TPS、累计 token、缓存命中与上下文占用", () => {
  const { line } = computeMetrics(usage);
  expect(line).toMatchObject({
    turns: 2,
    steps: 11,
    tps: 64.2,
    tokensTotal: 1_200_000,
    cacheHitPct: 94,
    ctxPct: 38,
    ctxUsed: 76_000,
    ctxWindow: 200_000,
  });
});

test("百分比一律带绝对值", () => {
  const { line } = computeMetrics(usage);
  expect(line.ctxLabel).toBe("38% 76k/200k");
  expect(line.cacheLabel).toBe("94% 940k/1M");
});

test("窗口未知：不给上下文百分比，只留绝对占用", () => {
  const { line, context } = computeMetrics({
    ...usage,
    context: { used: 76_000, window: null, messages: 70_000 },
  });
  expect(line.ctxPct).toBeNull();
  expect(line.ctxLabel).toBe("76k/—");
  expect(context?.pct).toBeNull();
});

test("没有输入：命中率为 null，不除零", () => {
  const { line, tokens } = computeMetrics({
    ...usage,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    context: null,
  });
  expect(line.cacheHitPct).toBeNull();
  expect(line.cacheLabel).toBeNull();
  expect(tokens).toMatchObject({ total: 0, uncachedInput: 0, hitPct: null });
});

test("Token 用量自洽：未缓存输入 = 输入 - 缓存读取，总量 = 输入 + 输出", () => {
  const { tokens } = computeMetrics(usage);
  expect(tokens).toEqual({
    total: 1_200_000,
    input: 1_000_000,
    output: 200_000,
    cacheRead: 940_000,
    uncachedInput: 60_000,
    hitPct: 94,
  });
});

test("会话统计：服务端没给的工具用时与 TTFT 为 null，不编造", () => {
  const { session } = computeMetrics(usage);
  expect(session).toEqual({
    turns: 2,
    steps: 11,
    modelMs: 51_700,
    toolMs: null,
    ttftMs: null,
    tps: 64.2,
  });
  expect(
    computeMetrics({ ...usage, toolMs: 42_600, ttftMs: 1400 }).session,
  ).toMatchObject({ toolMs: 42_600, ttftMs: 1400 });
});

test("模型用时缺失：由 输出 ÷ TPS 反推；TPS 也缺则 null", () => {
  expect(computeMetrics({ ...usage, modelMs: null }).session?.modelMs).toBe(
    Math.round((200_000 / 64.2) * 1000),
  );
  expect(
    computeMetrics({ ...usage, modelMs: null, tokensPerSecond: null }).session
      ?.modelMs,
  ).toBeNull();
});

test("上下文构成：最近一次调用的比例摊到当前占用，三段之和等于占用", () => {
  const { context } = computeMetrics(usage, last);
  expect(context?.estimated).toBe(true);
  const parts = context?.parts ?? [];
  expect(parts.map((p) => p.key)).toEqual(["system", "tools", "messages"]);
  // 权重 100 : 300 : 600（history + current）
  expect(parts.map((p) => p.tokens)).toEqual([7600, 22_800, 45_600]);
  expect(parts.reduce((a, p) => a + p.tokens, 0)).toBe(76_000);
  expect(parts.map((p) => p.pct)).toEqual([10, 30, 60]);
  expect(parts.map((p) => p.label)).toEqual([
    "系统提示词",
    "工具定义",
    "对话消息",
  ]);
});

test("上下文构成：最大余数法保证取整后之和不变", () => {
  const { context } = computeMetrics(
    { ...usage, context: { used: 100, window: 1000, messages: 0 } },
    { ...last, system: 1, tools: 1, history: 1, current: 0 },
  );
  const parts = context?.parts ?? [];
  expect(parts.reduce((a, p) => a + p.tokens, 0)).toBe(100);
  expect(parts.reduce((a, p) => a + p.pct, 0)).toBe(100);
});

test("estimated 透出：调用记录标明不是估算时为 false", () => {
  expect(
    computeMetrics(usage, { ...last, estimated: false }).context?.estimated,
  ).toBe(false);
});

test("没有最近调用时退回 /usage 自带的分段，仍标估算；分段也没有则只剩总占用", () => {
  const { context } = computeMetrics(usage);
  expect(context?.estimated).toBe(true);
  expect(context?.parts?.map((p) => p.tokens)).toEqual([2000, 4000, 70_000]);
  const bare = computeMetrics({
    ...usage,
    context: { used: 5000, window: 100_000, messages: 5000 },
  }).context;
  expect(bare?.parts).toBeNull();
  expect(bare?.label).toBe("5% 5k/100k");
});

test("结果里没有任何成本字段", () => {
  const text = JSON.stringify(computeMetrics(usage, last));
  expect(text).not.toMatch(/cost|price|usd|费用|成本|\$/i);
});

test("fmtTokens / fmtDuration", () => {
  expect(fmtTokens(842)).toBe("842");
  expect(fmtTokens(1234)).toBe("1.2k");
  expect(fmtTokens(76_000)).toBe("76k");
  expect(fmtTokens(150_000)).toBe("150k");
  expect(fmtTokens(1_500_000)).toBe("1.5M");
  expect(fmtDuration(820)).toBe("820 ms");
  expect(fmtDuration(51_700)).toBe("51.7 秒");
  expect(fmtDuration(125_000)).toBe("2 分 5 秒");
});
