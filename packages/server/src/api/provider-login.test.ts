import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { LoginRuntime } from "../provider/login.js";
import { createServer, type YuanshuServer } from "../server.js";

const TOKEN = "t".repeat(40);

// 假订阅登录：不发任何请求，按场景吐出事件或直接失败。
type Scene = "manual" | "device" | "fail" | "hang";

function fakeRuntime(scene: Scene) {
  const calls = { login: [] as string[], logout: [] as string[] };
  const runtime: LoginRuntime = {
    async login(providerId: string, _type, i: AuthInteraction) {
      calls.login.push(providerId);
      if (scene === "manual") {
        i.notify({ type: "auth_url", url: "https://example.com/auth" });
        await i.prompt({ type: "manual_code", message: "把授权码贴进来" });
        return;
      }
      if (scene === "device") {
        i.notify({
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://example.com/device",
          expiresInSeconds: 900,
        });
        return;
      }
      if (scene === "fail") throw new Error("授权被拒绝");
      await new Promise(() => {});
    },
    async logout(providerId: string) {
      calls.logout.push(providerId);
    },
  };
  return { runtime, calls };
}

let base: string;
let server: YuanshuServer | null = null;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-provider-login-"));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  rmSync(base, { recursive: true, force: true });
});

async function launch(
  scene: Scene = "manual",
  seedAuth?: Record<string, unknown>,
) {
  const dataDir = path.join(base, "data");
  const start = path.join(base, "start");
  const webRoot = path.join(base, "web");
  mkdirSync(dataDir);
  mkdirSync(start);
  mkdirSync(webRoot);
  writeFileSync(path.join(webRoot, "index.html"), "<html></html>");
  if (seedAuth) {
    mkdirSync(path.join(dataDir, "agent"));
    writeFileSync(
      path.join(dataDir, "agent", "auth.json"),
      JSON.stringify(seedAuth),
    );
  }
  const fake = fakeRuntime(scene);
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      token: TOKEN,
      allowCidrs: [],
      // 不碰开发机真实的 ~/.ys
      ysHome: path.join(base, "ys"),
    },
    {
      startDir: start,
      webRoot,
      loginRuntime: fake.runtime,
    },
  );
  const addr = await server.start();
  const call = (
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${addr.port}/api/v1${url}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (method: string, url: string, body?: unknown) => {
    const r = await call(method, url, body);
    const raw = await r.text();
    return { status: r.status, body: raw ? JSON.parse(raw) : null };
  };
  return { call, json, calls: fake.calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 登录在后台跑：轮询到不再 running 为止。
async function settled(
  json: Awaited<ReturnType<typeof launch>>["json"],
  id: string,
  loginId: string,
) {
  for (let i = 0; i < 100; i++) {
    const r = await json("GET", `/providers/${id}/login/${loginId}`);
    expect(r.status).toBe(200);
    if (r.body.status !== "running") return r.body;
    await sleep(10);
  }
  throw new Error("登录没有在预期时间内结束");
}

const providerOf = async (
  json: Awaited<ReturnType<typeof launch>>["json"],
  id: string,
) =>
  (await json("GET", "/providers")).body.providers.find(
    (p: { id: string }) => p.id === id,
  );

describe("订阅登录接口", () => {
  test("start → get → answer → get(done)，成功后认证方式变 oauth", async () => {
    const { json, calls } = await launch("manual");
    const start = await json("POST", "/providers/anthropic/login");
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({
      status: "running",
      link: { url: "https://example.com/auth" },
    });
    const id = start.body.loginId;
    expect(calls.login).toEqual(["anthropic"]);

    const got = await json("GET", `/providers/anthropic/login/${id}`);
    expect(got.body.prompt).toMatchObject({ type: "manual_code" });
    const answer = await json(
      "POST",
      `/providers/anthropic/login/${id}/answer`,
      { promptId: got.body.prompt.id, value: "code-123" },
    );
    expect(answer.status).toBe(204);

    const done = await settled(json, "anthropic", id);
    expect(done).toMatchObject({ status: "done", prompt: null, error: null });
    expect((await providerOf(json, "anthropic")).method).toBe("oauth");
  });

  test("device_code 流程：不答题也走到 done", async () => {
    const { json } = await launch("device");
    const start = await json("POST", "/providers/github-copilot/login");
    expect(start.status).toBe(201);
    const done = await settled(json, "github-copilot", start.body.loginId);
    expect(done).toMatchObject({
      status: "done",
      device: { userCode: "ABCD-1234" },
      prompt: null,
    });
    expect((await providerOf(json, "github-copilot")).method).toBe("oauth");
  });

  test("登录失败记 failed，错误文本不含凭据", async () => {
    const { json } = await launch("fail");
    const start = await json("POST", "/providers/anthropic/login");
    const failed = await settled(json, "anthropic", start.body.loginId);
    expect(failed).toMatchObject({
      status: "failed",
      error: "授权被拒绝",
    });
    // 失败不该改认证方式，也不该新建记录（默认仍是 key）
    expect((await providerOf(json, "anthropic")).method).toBe("key");
  });

  test("不支持订阅登录的供应商 400，未知供应商 404", async () => {
    const { json } = await launch();
    // deepseek 目录里没有 oauth
    expect((await json("POST", "/providers/deepseek/login")).body).toEqual({
      error: "oauth_unsupported",
    });
    expect((await json("POST", "/providers/nope/login")).status).toBe(404);
    expect((await json("POST", "/providers/nope/logout")).status).toBe(404);
    expect((await json("GET", "/providers/anthropic/login/nope")).status).toBe(
      404,
    );
    // 自定义供应商一律没有订阅登录
    const custom = await json("POST", "/providers", {
      name: "本地",
      slug: "local",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      method: "key",
    });
    expect(custom.status).toBe(201);
    expect(
      (await json("POST", `/providers/${custom.body.id}/login`)).body,
    ).toEqual({ error: "oauth_unsupported" });
  });

  test("answer 非法体 400，提示不存在 404", async () => {
    const { json } = await launch("manual");
    const start = await json("POST", "/providers/anthropic/login");
    const id = start.body.loginId;
    for (const body of [{}, { promptId: "x" }, { promptId: 1, value: "v" }]) {
      expect(
        (await json("POST", `/providers/anthropic/login/${id}/answer`, body))
          .status,
      ).toBe(400);
    }
    const got = await json("GET", `/providers/anthropic/login/${id}`);
    const ok = await json("POST", `/providers/anthropic/login/${id}/answer`, {
      promptId: got.body.prompt.id,
      value: "v",
    });
    expect(ok.status).toBe(204);
    // 已经兑现过的提示再用一次就没了
    const again = await json(
      "POST",
      `/providers/anthropic/login/${id}/answer`,
      { promptId: got.body.prompt.id, value: "v" },
    );
    expect(again.status).toBe(404);
    await settled(json, "anthropic", id);
  });

  test("cancel 幂等；不存在的登录 404", async () => {
    const { json } = await launch("hang");
    const start = await json("POST", "/providers/anthropic/login");
    const id = start.body.loginId;
    expect(
      (await json("DELETE", `/providers/anthropic/login/${id}`)).status,
    ).toBe(204);
    expect(
      (await json("GET", `/providers/anthropic/login/${id}`)).body,
    ).toMatchObject({ status: "cancelled" });
    expect(
      (await json("DELETE", `/providers/anthropic/login/${id}`)).status,
    ).toBe(204);
    // 已经结束的登录再取消仍是 204
    expect(
      (await json("DELETE", `/providers/anthropic/login/${id}`)).status,
    ).toBe(204);
    // 从来没有过的登录是 404
    expect(
      (await json("DELETE", "/providers/anthropic/login/nope")).status,
    ).toBe(404);
  });

  test("logout 调用 runtime 并回落到默认认证方式，返回当前视图", async () => {
    const { json, calls } = await launch("device");
    const start = await json("POST", "/providers/anthropic/login");
    await settled(json, "anthropic", start.body.loginId);
    expect((await providerOf(json, "anthropic")).method).toBe("oauth");

    const out = await json("POST", "/providers/anthropic/logout");
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ id: "anthropic", method: "key" });
    expect(calls.logout).toEqual(["anthropic"]);
    expect((await providerOf(json, "anthropic")).method).toBe("key");
  });

  test("auth.json 里已有订阅登录凭据：视图里是已登录，不被当成环境变量", async () => {
    const { json } = await launch("manual", {
      anthropic: {
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: Date.now() + 3_600_000,
      },
    });
    const p = await providerOf(json, "anthropic");
    expect(p.credential.source).toBe("auth.json");
    expect(
      p.credential.chain.filter((t: { hit: boolean }) => t.hit),
    ).toMatchObject([{ source: "auth.json" }]);
  });

  test("未带令牌 401", async () => {
    const { call } = await launch();
    for (const [method, url] of [
      ["POST", "/providers/anthropic/login"],
      ["GET", "/providers/anthropic/login/x"],
      ["POST", "/providers/anthropic/login/x/answer"],
      ["DELETE", "/providers/anthropic/login/x"],
      ["POST", "/providers/anthropic/logout"],
    ] as const) {
      const r = await call(method, url, undefined, { authorization: "" });
      expect(r.status, `${method} ${url}`).toBe(401);
      expect(await r.text()).toBe('{"error":"unauthorized"}');
    }
  });
});

describe("移除内置供应商的配置", () => {
  const save = (
    json: Awaited<ReturnType<typeof launch>>["json"],
    body: unknown,
  ) => json("PATCH", "/providers/deepseek", body);

  test("清掉记录与密钥、自己添加的模型、地址覆盖，回到没配置过的样子；204，且不是 403", async () => {
    // 测试环境里有 DEEPSEEK_API_KEY 时「未配置」的前提不成立。
    if (process.env.DEEPSEEK_API_KEY) return;
    const { json } = await launch();
    const before = await providerOf(json, "deepseek");
    await save(json, { apiKey: "sk-test-123456" });
    await save(json, { baseUrl: "https://eu.example/v1", maxConcurrent: 3 });
    await save(json, {
      models: [{ id: "extra-1", reasoning: false, source: "manual" }],
    });
    const set = await providerOf(json, "deepseek");
    expect(set).toMatchObject({ hasKey: true, maxConcurrent: 3, status: "ok" });
    expect(set.models.map((m: { id: string }) => m.id)).toContain("extra-1");

    const del = await json("DELETE", "/providers/deepseek");
    expect(del.status).toBe(204);
    const after = await providerOf(json, "deepseek");
    expect(after).toMatchObject({
      hasKey: false,
      status: "off",
      maxConcurrent: before.maxConcurrent,
      baseUrl: before.baseUrl,
    });
    expect(after.models.map((m: { id: string }) => m.id)).toEqual(
      before.models.map((m: { id: string }) => m.id),
    );
  });

  test("再删一次也是 204（没有可清的配置），未知供应商 404", async () => {
    const { json } = await launch();
    expect((await json("DELETE", "/providers/deepseek")).status).toBe(204);
    expect((await json("DELETE", "/providers/deepseek")).status).toBe(204);
    expect((await json("DELETE", "/providers/nope")).status).toBe(404);
  });

  test("认证方式是订阅登录的，顺带退出登录；不是订阅的不碰 pi 的登录", async () => {
    const { json, calls } = await launch("device");
    const start = await json("POST", "/providers/anthropic/login");
    await settled(json, "anthropic", start.body.loginId);
    expect((await providerOf(json, "anthropic")).method).toBe("oauth");

    expect((await json("DELETE", "/providers/anthropic")).status).toBe(204);
    expect(calls.logout).toEqual(["anthropic"]);
    expect((await providerOf(json, "anthropic")).method).toBe("key");

    // 只存了密钥、没走订阅登录的内置供应商：不去动 pi 的凭据
    await save(json, { apiKey: "sk-test-123456" });
    expect((await json("DELETE", "/providers/deepseek")).status).toBe(204);
    expect(calls.logout).toEqual(["anthropic"]);
  });
});
