import { expect, test } from "vitest";
import { ApiError } from "../../../api/http";
import type { StageName } from "../../../api/providers";
import { explainFailure, summarizeLastTest } from "./diagnose";
import { describeError } from "./errors";
import {
  fetchBlock,
  fmtTokens,
  loggedIn,
  monogram,
  needsFill,
  parseCount,
  primariesOf,
  primaryOf,
  railOf,
  slugOf,
  statusInfo,
} from "./model";
import { builtin, custom, model } from "./testkit";

test("状态点：ok 绿 / warn 琥珀 / off 灰 / 上次测试失败为红", () => {
  expect(statusInfo(builtin("a", { status: "ok" }))).toMatchObject({
    tone: "live",
    label: "已连接",
  });
  expect(statusInfo(builtin("a", { status: "off" })).tone).toBe("idle");
  expect(statusInfo(builtin("a", { status: "warn" })).label).toBe("待核验");
  const failed = builtin("a", {
    status: "warn",
    lastTest: {
      at: "t",
      ok: false,
      ttft: 0,
      total: 0,
      stage: "endpoint",
      errorCode: "unreachable",
    },
  });
  expect(statusInfo(failed)).toMatchObject({
    tone: "danger",
    label: "连接失败",
  });
});

test("左侧列表：自定义全部在列；内置只有添加过或刚挑出来的，按名称排序；只有环境凭据的不上架", () => {
  const list = [
    builtin("zeta", { added: true, status: "ok" }),
    builtin("alpha", { added: true, status: "warn" }),
    builtin("idle"),
    builtin("fresh"),
    builtin("envonly", { status: "ok" }),
    custom("vllm"),
  ];
  const ids = (picked: string[]) =>
    railOf(list, new Set(picked)).map((p) => p.id);
  expect(ids([])).toEqual(["vllm", "alpha", "zeta"]);
  expect(ids(["fresh"])).toEqual(["vllm", "alpha", "fresh", "zeta"]);
});

test("登录方式三大类：env 与 cmd 归在 API Key；一个类别只出现一次", () => {
  expect(primaryOf("oauth")).toBe("oauth");
  expect(primaryOf("ambient")).toBe("ambient");
  for (const m of ["key", "env", "cmd"] as const)
    expect(primaryOf(m)).toBe("key");
  expect(
    primariesOf(builtin("a", { methods: ["oauth", "key", "env", "cmd"] })),
  ).toEqual(["oauth", "key"]);
  expect(primariesOf(custom("c"))).toEqual(["key"]);
  expect(primariesOf(builtin("b", { methods: ["ambient", "key"] }))).toEqual([
    "ambient",
    "key",
  ]);
});

test("订阅是否已登录：看 auth.json 那一层有没有命中", () => {
  const hit = (h: boolean) =>
    builtin("a", {
      method: "oauth",
      credential: {
        source: h ? "auth.json" : null,
        chain: [{ source: "auth.json", hit: h }],
      },
    });
  expect(loggedIn(hit(true))).toBe(true);
  expect(loggedIn(hit(false))).toBe(false);
});

test("订阅方式没登录时状态叫「未登录」，其余方式叫「未配置」", () => {
  expect(statusInfo(builtin("a", { method: "oauth" })).label).toBe("未登录");
  expect(statusInfo(builtin("a", { method: "key" })).label).toBe("未配置");
});

test("fetchBlock：只有没有 Base URL 的自定义端点被挡；内置供应商探测不了时改列目录，不挡", () => {
  expect(fetchBlock(custom("c"))).toBeNull();
  expect(fetchBlock(custom("c", { probeable: false }))).toMatch(
    /没有可用的 Base URL/,
  );
  expect(fetchBlock(builtin("b", { probeable: false }))).toBeNull();
});

test("parseCount：K / M 单位不分大小写、按 1024 算、可带小数；其余写法与超大值都不合法", () => {
  expect(parseCount("256K")).toBe(262144);
  expect(parseCount("256k")).toBe(262144);
  expect(parseCount(" 1M ")).toBe(1048576);
  expect(parseCount("1m")).toBe(1048576);
  expect(parseCount("1.5M")).toBe(1572864);
  expect(parseCount("0.5k")).toBe(512);
  expect(parseCount("128")).toBe(128);
  for (const bad of ["k", "M", "1 K", "1kb", "1.5.2M", ".5k", "1e3", "-1k"])
    expect(parseCount(bad), bad).toBeNull();
  expect(parseCount("999999999")).toBe(999_999_999);
  expect(parseCount("1000000000")).toBeNull();
  expect(parseCount("999999M")).toBeNull();
});

test("待补全、数字与 token 格式化、标识推导", () => {
  expect(needsFill(model("a", { ctx: 0 }))).toBe(true);
  expect(needsFill(model("a"))).toBe(false);
  expect(parseCount("")).toBe(0);
  expect(parseCount(" 262144 ")).toBe(262144);
  expect(parseCount("-1")).toBeNull();
  expect(parseCount("abc")).toBeNull();
  expect(fmtTokens(0)).toBe("—");
  expect(fmtTokens(200000)).toBe("200k");
  expect(fmtTokens(1048576)).toBe("1.0M");
  expect(slugOf("团队 vLLM 网关")).toBe("vllm");
  expect(slugOf("Local Ollama")).toBe("local-ollama");
  expect(monogram("团队 vLLM")).toBe("团队");
});

const STAGES: StageName[] = ["credential", "endpoint", "models", "token"];

test("各失败阶段 + 错误码都有可读说明", () => {
  const cases: [StageName, string | null, string][] = [
    ["credential", "no_credential", "没有可用凭据"],
    ["endpoint", "unreachable", "无法连接端点"],
    ["endpoint", "timeout", "请求超时"],
    ["models", "unauthorized", "密钥被拒绝"],
    ["models", "http_error", "端点返回了错误状态"],
    ["models", "bad_response", "响应不是模型列表"],
    ["models", "empty_model_list", "端点返回了空的模型列表"],
    ["token", "no_model", "没有可用于测试的模型"],
    ["token", "timeout", "首 token 超时"],
    ["token", "completion_failed", "补全请求失败"],
    ["token", "no_token", "模型没有返回内容"],
  ];
  for (const [stage, code, title] of cases)
    expect(explainFailure(stage, code).title).toBe(title);
  // 未知码按阶段兜底，且附带服务端 detail
  for (const s of STAGES)
    expect(explainFailure(s, "weird", "boom")).toMatchObject({
      hint: "boom",
    });
});

test("上次测试摘要", () => {
  expect(
    summarizeLastTest({
      at: "t",
      ok: true,
      ttft: 320,
      total: 1200,
      stage: "token",
    }),
  ).toBe("通过 · 首 token 320 ms · 共 1.2 s");
  expect(
    summarizeLastTest({
      at: "t",
      ok: false,
      ttft: 0,
      total: 0,
      stage: "models",
      errorCode: "unauthorized",
    }),
  ).toBe("失败于模型列表阶段 · 密钥被拒绝");
});

test("describeError：校验码、409、403、网络失败、502 上游、no_credential 带 message", () => {
  const e = (status: number, body: unknown) =>
    describeError(new ApiError(status, body));
  expect(e(400, { error: "invalid_slug" }).message).toContain("小写字母");
  expect(e(409, { error: "slug_taken" }).message).toContain(
    "已被其他供应商占用",
  );
  expect(e(409, { error: "in_use" }).message).toContain("Agent");
  expect(e(403, { error: "builtin_provider" }).message).toContain("不能删除");
  expect(e(0, null).message).toContain("连不上");
  expect(e(502, { error: "unauthorized" }).message).toContain("401/403");
  expect(
    e(400, { error: "no_credential", message: "先去配置密钥" }).message,
  ).toBe("先去配置密钥");
  expect(e(500, null).message).toBe("操作失败（HTTP 500）");
  expect(describeError(new Error("x")).code).toBeNull();
});
