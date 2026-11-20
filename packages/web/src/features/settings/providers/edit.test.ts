import { expect, test } from "vitest";
import type { ProviderView } from "../../../api/providers";
import { editableOf, patchOf, validateEdit, withPrimary } from "./edit";
import { builtin, custom } from "./testkit";

const mine = custom("mine", { name: "我的端点", baseUrl: "host/v1" });

test("editableOf：缺省项变成空串，并发变文字", () => {
  expect(editableOf(builtin("anthropic"))).toMatchObject({
    baseUrl: "",
    envVariable: "",
    slug: "",
    maxConcurrent: "50",
  });
});

test("patchOf：没改什么就是空；只带改过的项；清空鉴权头发 null", () => {
  const p = mine;
  const s = editableOf(p);
  expect(patchOf(s, p, "")).toEqual({});
  expect(
    patchOf({ ...s, name: " 新名字 ", authHeader: "X-Key" }, p, ""),
  ).toEqual({ name: "新名字", authHeader: "X-Key" });
  const withHeader: ProviderView = { ...p, authHeader: "X-Key" };
  expect(
    patchOf({ ...editableOf(withHeader), authHeader: " " }, withHeader, ""),
  ).toEqual({ authHeader: null });
  expect(patchOf({ ...s, maxConcurrent: "8" }, p, "")).toEqual({
    maxConcurrent: 8,
  });
});

test("patchOf：键入的 API Key 非空才发；内置供应商清空地址 = 清除覆盖（null），自定义发空串由服务端拒绝", () => {
  const b: ProviderView = { ...builtin("anthropic"), baseUrl: "proxy/v1" };
  expect(patchOf(editableOf(b), b, "sk-1")).toEqual({ apiKey: "sk-1" });
  expect(patchOf({ ...editableOf(b), baseUrl: "" }, b, "")).toEqual({
    baseUrl: null,
  });
  expect(patchOf({ ...editableOf(mine), baseUrl: "" }, mine, "")).toEqual({
    baseUrl: "",
  });
});

test("validateEdit：自定义端点的名称、标识、环境变量名；cmd 必须有命令；并发范围", () => {
  const s = editableOf(mine);
  expect(validateEdit(s, mine)).toEqual({});
  expect(
    validateEdit({ ...s, maxConcurrent: " " }, mine).maxConcurrent,
  ).toBeTruthy();
  expect(
    validateEdit(
      { ...s, name: " ", slug: "Bad Slug", method: "env", maxConcurrent: "0" },
      mine,
    ),
  ).toMatchObject({
    name: expect.any(String),
    slug: expect.any(String),
    envVariable: expect.any(String),
    maxConcurrent: expect.any(String),
  });
  const b = builtin("anthropic");
  // 内置供应商的名称与标识不是它能改的，不校验；cmd 仍要命令
  expect(validateEdit({ ...editableOf(b), name: "" }, b)).toEqual({});
  expect(
    validateEdit({ ...editableOf(b), method: "cmd" }, b).command,
  ).toBeTruthy();
});

test("withPrimary：切到订阅 / 云凭据直接换；切回 API Key 时原来是 env 就回到 env", () => {
  const p: ProviderView = {
    ...builtin("anthropic"),
    method: "env",
    methods: ["oauth", "key", "env"],
  };
  const s = editableOf(p);
  const oauth = withPrimary(s, p, "oauth");
  expect(oauth.method).toBe("oauth");
  expect(withPrimary(oauth, p, "key").method).toBe("env");
  expect(withPrimary(s, p, "key")).toBe(s);
  const q: ProviderView = { ...p, method: "oauth" };
  expect(withPrimary(editableOf(q), q, "key").method).toBe("key");
});
