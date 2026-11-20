import { expect, test } from "vitest";
import { type CredentialDeps, inspectCredential } from "./credentials.js";

// 只有内置供应商走 pi 的 checkAuth；其余依赖在这些用例里不会被碰到。
function depsFor(auth: { source: string; type?: string }): CredentialDeps {
  return {
    catalog: { runtime: { checkAuth: async () => auth } },
  } as unknown as CredentialDeps;
}

const hit = (info: Awaited<ReturnType<typeof inspectCredential>>) =>
  info.chain.filter((t) => t.hit).map((t) => t.source);

test("订阅登录的 OAuth 凭据算 auth.json 命中，不是环境变量", async () => {
  const info = await inspectCredential(
    depsFor({ source: "OAuth", type: "oauth" }),
    "anthropic",
    null,
    false,
  );
  expect(info.source).toBe("auth.json");
  expect(hit(info)).toEqual(["auth.json"]);
});

test("pi 里存的 API Key 也是 auth.json 命中", async () => {
  const info = await inspectCredential(
    depsFor({ source: "stored credential", type: "api_key" }),
    "deepseek",
    null,
    false,
  );
  expect(hit(info)).toEqual(["auth.json"]);
});

test("环境变量来的凭据落在 env 层并记下变量名", async () => {
  const info = await inspectCredential(
    depsFor({ source: "DEEPSEEK_API_KEY" }),
    "deepseek",
    null,
    false,
  );
  expect(info).toMatchObject({ source: "env", detail: "DEEPSEEK_API_KEY" });
  expect(hit(info)).toEqual(["env"]);
});
