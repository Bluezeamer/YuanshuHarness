import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../server.js";
import { createSessionFactory } from "../session/factory.js";
import { builtinIdsOf } from "./providers.js";

const TOKEN = "t".repeat(40);
const KEY = "sk-super-secret-1234";

let base: string;
let server: YuanshuServer | null = null;
let fake: Server | null = null;
let fakePort = 0;
const sockets = new Set<import("node:net").Socket>();

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-providers-"));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
  fake = null;
  rmSync(base, { recursive: true, force: true });
});

const sse = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
};
const chunk = (delta: object, finish: string | null = null) => ({
  id: "c1",
  object: "chat.completion.chunk",
  created: 1,
  model: "m1",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

// 假上游：路径第一段决定场景。不访问外网。
function handler(req: IncomingMessage, res: ServerResponse) {
  const [, scene = "", ...rest] = (req.url ?? "").split("/");
  const tail = `/${rest.join("/")}`;
  const auth = req.headers.authorization === `Bearer ${KEY}`;
  if (scene === "slow") return; // 永不应答，等客户端超时
  if (tail.endsWith("/models") && req.method === "GET") {
    if (scene === "anth") {
      if (req.headers["x-api-key"] !== KEY) {
        res.writeHead(401).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ data: [{ id: "claude-x" }, { id: "claude-y" }] }),
      );
      return;
    }
    if (scene === "needkey" && !auth) {
      res.writeHead(401).end("");
      return;
    }
    if (scene === "gwkey" && req.headers["x-gw-key"] !== KEY) {
      res.writeHead(401).end("");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: scene === "empty" ? [] : [{ id: "m1" }, { id: "m2" }],
      }),
    );
    return;
  }
  if (tail.endsWith("/chat/completions") && req.method === "POST") {
    if (scene === "gwkey" && req.headers["x-gw-key"] !== KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "need x-gw-key" } }));
      return;
    }
    if (scene === "badtoken") {
      // 上游回显了请求里的密钥：响应里必须被遮罩。
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `boom ${KEY}` } }));
      return;
    }
    sse(res, [
      chunk({ role: "assistant", content: "pong" }),
      chunk({}, "stop"),
    ]);
    return;
  }
  res.writeHead(404).end();
}

async function launch() {
  fake = createHttp(handler);
  fake.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => fake?.listen(0, "127.0.0.1", r));
  fakePort = (fake.address() as AddressInfo).port;
  const dataDir = path.join(base, "data");
  const start = path.join(base, "start");
  const webRoot = path.join(base, "web");
  mkdirSync(dataDir);
  mkdirSync(start);
  mkdirSync(webRoot);
  writeFileSync(path.join(webRoot, "index.html"), "<html></html>");
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      token: TOKEN,
      allowCidrs: [],
      // 建会话会读全局 AGENTS.md：不碰开发机真实的 ~/.ys
      ysHome: path.join(base, "ys"),
    },
    {
      startDir: start,
      webRoot,
      providerTimeoutMs: 400,
      makeSessionFactory: createSessionFactory,
    },
  );
  const addr = await server.start();
  const call = (method: string, url: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${addr.port}/api/v1${url}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const json = async (method: string, url: string, body?: unknown) => {
    const r = await call(method, url, body);
    const raw = await r.text();
    // 任何响应都不得含密钥。
    expect(raw).not.toContain(KEY);
    return { status: r.status, body: raw ? JSON.parse(raw) : null };
  };
  return { call, json };
}

const custom = (scene: string, over: Record<string, unknown> = {}) => ({
  name: `上游 ${scene}`,
  slug: `up-${scene}`,
  api: "openai-completions",
  baseUrl: `http://127.0.0.1:${fakePort}/${scene}/v1`,
  method: "key",
  apiKey: KEY,
  models: [
    { id: "m1", reasoning: false, input: ["text"], ctx: 8000, out: 1000 },
  ],
  ...over,
});

describe("供应商列表与登记", () => {
  test("内置供应商来自 pi 目录，带四档凭据链且不含密钥", async () => {
    const { json } = await launch();
    const r = await json("GET", "/providers");
    expect(r.status).toBe(200);
    const list = r.body.providers as any[];
    const builtin = list.filter((p) => !p.custom);
    expect(builtin.length).toBeGreaterThan(5);
    const a = list.find((p) => p.id === "anthropic");
    expect(a.methods).toContain("oauth");
    // 内置供应商不自带全部目录模型：没添加过就是空的，目录另有接口
    expect(a.models).toEqual([]);
    const cat = await json("GET", "/providers/anthropic/catalog-models");
    expect(cat.status).toBe(200);
    expect(cat.body.models.length).toBeGreaterThan(0);
    expect(cat.body.models[0].source).toBe("catalog");
    expect(cat.body.models[0]).not.toHaveProperty("cost");
    expect(a.credential.chain.map((t: any) => t.source)).toEqual([
      "--api-key",
      "auth.json",
      "models.json",
      "env",
    ]);
  });

  test("目录模型接口：内置给 pi 的目录规格；自定义端点是空表；未知 404", async () => {
    const { json } = await launch();
    const made = await json("POST", "/providers", custom("ok"));
    expect(
      (await json("GET", `/providers/${made.body.id}/catalog-models`)).body,
    ).toEqual({ models: [] });
    expect((await json("GET", "/providers/nope/catalog-models")).status).toBe(
      404,
    );
  });

  test("内置供应商：只列用户添加的模型；添加的目录模型原样带着规格；移除后不再列出", async () => {
    const { json } = await launch();
    const cat = (await json("GET", "/providers/anthropic/catalog-models")).body
      .models as any[];
    const pick = cat.find((m) => m.reasoning) ?? cat[0];
    const added = await json("PATCH", "/providers/anthropic", {
      models: [{ ...pick, source: "catalog" }],
    });
    expect(added.status).toBe(200);
    expect(added.body.models.map((m: any) => m.id)).toEqual([pick.id]);
    expect(added.body.models[0]).toMatchObject({
      ctx: pick.ctx,
      out: pick.out,
      levels: pick.levels,
    });
    const gone = await json("PATCH", "/providers/anthropic", { models: [] });
    expect(gone.body.models).toEqual([]);
  });

  test("自定义供应商：登记后回显 hasKey 不回显 key，未测前是 warn", async () => {
    const { json } = await launch();
    const r = await json("POST", "/providers", custom("ok"));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      custom: true,
      slug: "up-ok",
      method: "key",
      keyStorage: "auth",
      hasKey: true,
      status: "warn",
    });
    expect(r.body.credential.source).toBe("auth.json");
    expect(r.body).not.toHaveProperty("apiKey");
    const dup = await json("POST", "/providers", custom("ok"));
    expect(dup.status).toBe(409);
    const list = await json("GET", "/providers");
    expect(list.body.providers.some((p: any) => p.id === r.body.id)).toBe(true);
  });

  test("字段校验：slug、协议、地址、认证方式", async () => {
    const { json } = await launch();
    for (const over of [
      { slug: "Bad Slug" },
      { slug: "anthropic" },
      { api: "grpc" },
      { baseUrl: "ftp://x" },
      { method: "oauth" },
      { method: "env" },
      { method: "cmd" },
      { models: [{ id: "x", reasoning: false, levels: ["low"] }] },
    ]) {
      const r = await json("POST", "/providers", custom("ok", over));
      expect(r.status, JSON.stringify(over)).toBeGreaterThanOrEqual(400);
    }
    const g = await json(
      "POST",
      "/providers",
      custom("ok", { api: "google-generative-ai" }),
    );
    expect(g.status).toBe(201);
  });

  test("PATCH：换保存位置会搬家，session 档重启即失之外照常可用", async () => {
    const { json } = await launch();
    const c = (await json("POST", "/providers", custom("ok"))).body;
    const r = await json("PATCH", `/providers/${c.id}`, {
      keyStorage: "session",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ keyStorage: "session", hasKey: true });
    expect(r.body.credential.source).toBe("--api-key");
    const cleared = await json("PATCH", `/providers/${c.id}`, { apiKey: null });
    expect(cleared.body.hasKey).toBe(false);
    expect((await json("PATCH", "/providers/nope", {})).status).toBe(404);
  });

  test("内置供应商：只存用户配置；名称、协议、slug 不可改", async () => {
    const { json } = await launch();
    const r = await json("PATCH", "/providers/deepseek", {
      method: "env",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ custom: false, method: "env" });
    for (const f of [
      { name: "x" },
      { slug: "x" },
      { api: "openai-responses" },
    ]) {
      expect((await json("PATCH", "/providers/deepseek", f)).status).toBe(400);
    }
    // 内置供应商删不掉，「删除」只是清掉元枢里保存的配置（细节见 provider-login.test）
    const del = await json("DELETE", "/providers/deepseek");
    expect(del.status).toBe(204);
    expect(
      (await json("GET", "/providers")).body.providers.find(
        (p: any) => p.id === "deepseek",
      ),
    ).toMatchObject({ custom: false, method: "key" });
  });

  test("added：内置供应商只有库里有记录才算添加过（环境凭据不算），删除后回到未添加；自定义恒为 true", async () => {
    const { json } = await launch();
    const find = async (id: string) =>
      (await json("GET", "/providers")).body.providers.find(
        (p: { id: string }) => p.id === id,
      );
    expect((await find("deepseek")).added).toBe(false);
    await json("PATCH", "/providers/deepseek", { maxConcurrent: 3 });
    expect((await find("deepseek")).added).toBe(true);
    expect((await json("DELETE", "/providers/deepseek")).status).toBe(204);
    expect((await find("deepseek")).added).toBe(false);

    const c = await json("POST", "/providers", {
      name: "本地",
      slug: "local",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      method: "key",
    });
    expect((await find(c.body.id)).added).toBe(true);
  });

  // 补自 provider-settings.flows 核对：内置供应商保存密钥后状态变已连接，移除后回到未配置。
  test("内置供应商：保存密钥 → ok（凭据来自 auth.json）；移除密钥 → off", async () => {
    // 测试环境里有 DEEPSEEK_API_KEY 时「未配置」的前提不成立。
    if (process.env.DEEPSEEK_API_KEY) return;
    const { json } = await launch();
    const before = (await json("GET", "/providers")).body.providers.find(
      (p: any) => p.id === "deepseek",
    );
    expect(before).toMatchObject({ status: "off", hasKey: false });
    const saved = await json("PATCH", "/providers/deepseek", { apiKey: KEY });
    expect(saved.body).toMatchObject({ status: "ok", hasKey: true });
    expect(saved.body.credential.source).toBe("auth.json");
    const cleared = await json("PATCH", "/providers/deepseek", {
      apiKey: null,
    });
    expect(cleared.body).toMatchObject({ status: "off", hasKey: false });
  });

  test("删除：有会话在用 409；删除后密码库条目随之清掉", async () => {
    const { json, call } = await launch();
    const c = (await json("POST", "/providers", custom("ok"))).body;
    // 会话把模型显式指定成这家供应商的模型，就算在用
    const s = await json("POST", "/sessions", {
      config: {
        model: {
          mode: "explicit",
          provider: c.id,
          model: "m1",
          reasoning: "off",
        },
      },
    });
    expect(s.status).toBe(201);
    expect(JSON.stringify((await json("GET", "/secrets")).body)).toContain(
      "provider:",
    );
    expect((await json("DELETE", `/providers/${c.id}`)).status).toBe(409);
    const cfg = await json("GET", `/sessions/${s.body.id}/config`);
    await json("PATCH", `/sessions/${s.body.id}/config`, {
      baseRev: cfg.body.rev,
      patch: { model: { mode: "follow-default" } },
    });
    expect((await call("DELETE", `/providers/${c.id}`)).status).toBe(204);
    const secrets = await json("GET", "/secrets");
    expect(JSON.stringify(secrets.body)).not.toContain("provider:");
  });
});

describe("内置供应商的协议", () => {
  test("混合协议的聚合端点取目录里最多的协议，探测与测试带 Bearer 而不是 x-api-key", async () => {
    const { json } = await launch();
    const list = (await json("GET", "/providers")).body.providers as any[];
    // pi 目录里 openrouter 的第一个模型是 anthropic-messages，但 openai-completions 占绝大多数
    expect(list.find((p) => p.id === "openrouter")).toMatchObject({
      api: "openai-completions",
      probeable: true,
    });

    // 把端点指到假上游（needkey 场景只认 Bearer）：协议取错就会发 x-api-key 而被 401
    await json("PATCH", "/providers/openrouter", {
      baseUrl: `http://127.0.0.1:${fakePort}/needkey/v1`,
      apiKey: KEY,
    });
    const probe = await json("POST", "/providers/openrouter/models/probe");
    expect(probe).toMatchObject({ status: 200, body: { ids: ["m1", "m2"] } });
    const test = await json("POST", "/providers/openrouter/test");
    expect(test.body.stages.models.state).toBe("ok");
  });

  test("pi 目录协议不在四种探测协议里的，如实给出协议名并标明不可探测", async () => {
    const { json } = await launch();
    const list = (await json("GET", "/providers")).body.providers as any[];
    expect(list.find((p) => p.id === "mistral")).toMatchObject({
      api: "mistral-conversations",
      probeable: false,
    });
    // 目录里没有任何模型的供应商没有协议可言
    const bare = list.find((p) => p.id === "typesafe");
    expect(bare.probeable).toBe(false);
    expect(bare).not.toHaveProperty("api");
  });
});

describe("协议兼容与鉴权头", () => {
  test("五项兼容与鉴权头都能保存并回显，鉴权头不含密钥", async () => {
    const { json } = await launch();
    const compat = {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      supportsReasoningEffort: false,
      requiresThinkingAsText: true,
      thinkingFormat: "qwen",
    };
    const r = await json(
      "POST",
      "/providers",
      custom("ok", { compat, authHeader: "  Authorization :  Token " }),
    );
    expect(r.status).toBe(201);
    expect(r.body.compat).toEqual(compat);
    // 规范化：去掉多余空白
    expect(r.body.authHeader).toBe("Authorization: Token");
    // 清除：三态里的「自动」= 键缺省；authHeader null = 回到协议默认
    const p = await json("PATCH", `/providers/${r.body.id}`, {
      compat: { supportsReasoningEffort: true },
      authHeader: null,
    });
    expect(p.body.compat).toEqual({ supportsReasoningEffort: true });
    expect(p.body).not.toHaveProperty("authHeader");
  });

  test("非法的兼容项与鉴权头被拒，内置供应商不能设鉴权头", async () => {
    const { json } = await launch();
    for (const over of [
      { compat: { thinkingFormat: "nope" } },
      { compat: { supportsReasoningEffort: "yes" } },
      { compat: { requiresThinkingAsText: 1 } },
      { compat: { unknownKey: true } },
      { authHeader: "Bad Header: x" },
      { authHeader: "X-Key\r\nInjected: 1" },
      { authHeader: "X-Key: a\nb" },
      { authHeader: "" },
      { authHeader: 5 },
    ]) {
      const r = await json("POST", "/providers", custom("ok", over));
      expect(r.status, JSON.stringify(over)).toBe(400);
    }
    const b = await json("PATCH", "/providers/deepseek", {
      authHeader: "X-Key",
    });
    expect(b).toMatchObject({
      status: 400,
      body: { error: "builtin_immutable" },
    });
  });

  test("自定义鉴权头：探测与测试连接发的是它（覆盖协议默认的 Bearer）", async () => {
    const { json } = await launch();
    const c = (
      await json(
        "POST",
        "/providers",
        custom("gwkey", { authHeader: "X-Gw-Key" }),
      )
    ).body;
    const probe = await json("POST", `/providers/${c.id}/models/probe`);
    expect(probe).toMatchObject({ status: 200, body: { ids: ["m1", "m2"] } });
    const t = await json("POST", `/providers/${c.id}/test`);
    expect(t.body).toMatchObject({ ok: true });

    // 没填鉴权头时同一上游被 401：证明上面的成功来自 X-Gw-Key
    const plain = (
      await json("POST", "/providers", custom("gwkey", { slug: "up-plain" }))
    ).body;
    const bad = await json("POST", `/providers/${plain.id}/models/probe`);
    expect(bad).toMatchObject({ status: 502, body: { error: "unauthorized" } });
  });

  test("models.json 视图：兼容项与鉴权头进 headers，密钥只出现占位", async () => {
    const { json } = await launch();
    await json(
      "POST",
      "/providers",
      custom("ok", {
        authHeader: "X-Gw-Key: Token",
        compat: { requiresThinkingAsText: true, thinkingFormat: "qwen" },
      }),
    );
    const r = await json("GET", "/models-json");
    expect(r.body.live.providers["up-ok"]).toMatchObject({
      headers: { "X-Gw-Key": "Token ••••" },
      compat: { requiresThinkingAsText: true, thinkingFormat: "qwen" },
    });
  });
});

describe("模型探测", () => {
  test("OpenAI 风格：带密钥取 id 列表", async () => {
    const { json } = await launch();
    const c = (await json("POST", "/providers", custom("needkey"))).body;
    const r = await json("POST", `/providers/${c.id}/models/probe`);
    expect(r).toMatchObject({ status: 200, body: { ids: ["m1", "m2"] } });
  });

  test("Anthropic 风格：x-api-key 头，基址补 /v1 之外的版本段不重复", async () => {
    const { json } = await launch();
    const c = (
      await json(
        "POST",
        "/providers",
        custom("anth", { api: "anthropic-messages" }),
      )
    ).body;
    const r = await json("POST", `/providers/${c.id}/models/probe`);
    expect(r.body).toEqual({ ids: ["claude-x", "claude-y"] });
  });

  test("密钥无效 502 unauthorized；没有凭据时不给列表而是指路", async () => {
    const { json } = await launch();
    const wrong = (
      await json(
        "POST",
        "/providers",
        custom("needkey", { apiKey: "wrong-key" }),
      )
    ).body;
    const r = await json("POST", `/providers/${wrong.id}/models/probe`);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("unauthorized");

    const env = (
      await json(
        "POST",
        "/providers",
        custom("ok", {
          slug: "up-env",
          method: "env",
          envVariable: "YUANSHU_TEST_UNSET_KEY",
          apiKey: undefined,
        }),
      )
    ).body;
    const none = await json("POST", `/providers/${env.id}/models/probe`);
    expect(none.status).toBe(400);
    expect(none.body.error).toBe("no_credential");
    expect(none.body.message).toContain("401");
    expect(none.body).not.toHaveProperty("ids");
  });
});

describe("四阶段连接测试", () => {
  test("全部通过：每阶段 ok，lastTest 落库，状态变 ok", async () => {
    const { json } = await launch();
    const c = (await json("POST", "/providers", custom("needkey"))).body;
    const r = await json("POST", `/providers/${c.id}/test`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      failedStage: null,
      errorCode: null,
      lastTest: { ok: true, stage: "token" },
    });
    for (const s of ["credential", "endpoint", "models", "token"])
      expect(r.body.stages[s]).toMatchObject({ state: "ok" });
    expect(typeof r.body.lastTest.ttft).toBe("number");
    expect(r.body.lastTest.total).toBeGreaterThanOrEqual(r.body.lastTest.ttft);

    const list = (await json("GET", "/providers")).body.providers as any[];
    const got = list.find((p) => p.id === c.id);
    expect(got.status).toBe("ok");
    expect(got.lastTest.ok).toBe(true);
  });

  test("401：失败在模型列表阶段，首 token 标 skip，状态 warn", async () => {
    const { json } = await launch();
    const c = (
      await json(
        "POST",
        "/providers",
        custom("needkey", { apiKey: "wrong-key" }),
      )
    ).body;
    const r = await json("POST", `/providers/${c.id}/test`);
    expect(r.body).toMatchObject({
      ok: false,
      failedStage: "models",
      errorCode: "unauthorized",
    });
    expect(r.body.stages.endpoint.state).toBe("ok");
    expect(r.body.stages.models.state).toBe("fail");
    expect(r.body.stages.token.state).toBe("skip");
    const got = (await json("GET", "/providers")).body.providers.find(
      (p: any) => p.id === c.id,
    );
    expect(got.status).toBe("warn");
    expect(got.lastTest).toMatchObject({ ok: false, stage: "models" });
  });

  test("超时：端点阶段失败", async () => {
    const { json } = await launch();
    const c = (await json("POST", "/providers", custom("slow"))).body;
    const r = await json("POST", `/providers/${c.id}/test`);
    expect(r.body).toMatchObject({
      ok: false,
      failedStage: "endpoint",
      errorCode: "timeout",
    });
    expect(r.body.stages.models.state).toBe("skip");
  });

  test("模型列表为空：模型列表阶段失败", async () => {
    const { json } = await launch();
    const c = (await json("POST", "/providers", custom("empty"))).body;
    const r = await json("POST", `/providers/${c.id}/test`);
    expect(r.body).toMatchObject({
      failedStage: "models",
      errorCode: "empty_model_list",
    });
  });

  test("首 token 失败：错误文本里的密钥被遮罩", async () => {
    const { json } = await launch();
    const c = (await json("POST", "/providers", custom("badtoken"))).body;
    const r = await json("POST", `/providers/${c.id}/test`);
    expect(r.body).toMatchObject({
      ok: false,
      failedStage: "token",
      errorCode: "completion_failed",
    });
    expect(r.body.stages.models.state).toBe("ok");
    expect(r.body.stages.token.error).toContain("••••");
    expect(r.body.lastTest).toMatchObject({
      ok: false,
      ttft: 0,
      stage: "token",
    });
  });

  test("没有凭据：第一阶段失败并指路，后面全部 skip", async () => {
    const { json } = await launch();
    const c = (
      await json(
        "POST",
        "/providers",
        custom("ok", {
          slug: "up-cmd",
          method: "env",
          envVariable: "YUANSHU_TEST_UNSET_KEY",
          apiKey: undefined,
        }),
      )
    ).body;
    const r = await json("POST", `/providers/${c.id}/test`);
    expect(r.body).toMatchObject({
      failedStage: "credential",
      errorCode: "no_credential",
    });
    expect(r.body.stages.credential.error).toContain("401");
    expect(r.body.stages.endpoint.state).toBe("skip");
  });

  test("内置供应商也能测：没配凭据时停在第一阶段，不访问外网", async () => {
    const { json } = await launch();
    const r = await json("POST", "/providers/deepseek/test");
    // 测试环境没有 DEEPSEEK_API_KEY；有的话这条用例的前提不成立。
    if (!process.env.DEEPSEEK_API_KEY) {
      expect(r.body.failedStage).toBe("credential");
      expect(r.body.stages.endpoint.state).toBe("skip");
    }
    expect((await json("POST", "/providers/nope/test")).status).toBe(404);
  });
});

describe("models.json 活视图", () => {
  test("返回活视图与 diff，密钥永不出现", async () => {
    const { json } = await launch();
    await json("POST", "/providers", custom("ok", { keyStorage: "models" }));
    const r = await json("GET", "/models-json");
    expect(r.status).toBe(200);
    expect(r.body.exists).toBe(false);
    expect(Object.keys(r.body.live.providers)).toContain("up-ok");
    expect(Array.isArray(r.body.diff)).toBe(true);
    expect(r.body.diff.length).toBeGreaterThan(0);
  });
});

test("内置供应商列表排除已注册的自定义供应商 id", () => {
  const mine = new Map<string, { custom: boolean }>([
    ["01a1-custom", { custom: true }],
    ["legacy", { custom: false }],
  ]);
  expect(builtinIdsOf(["openai", "01a1-custom", "legacy"], mine)).toEqual([
    "openai",
    "legacy",
  ]);
});

const stored = async (
  json: (
    m: string,
    p: string,
  ) => Promise<{
    body: { providers: Array<{ id: string; maxConcurrent: number }> };
  }>,
  id: string,
) =>
  (await json("GET", "/providers")).body.providers.find((x) => x.id === id)
    ?.maxConcurrent;

describe("最大并发请求数", () => {
  test("缺省 50；可设 1 到 1000 的整数，null 回到缺省；内置供应商也能设", async () => {
    const { json } = await launch();
    const r = await json("POST", "/providers", custom("ok", {}));
    expect(r.status).toBe(201);
    expect(r.body.maxConcurrent).toBe(50);
    const set = await json("PATCH", `/providers/${r.body.id}`, {
      maxConcurrent: 2,
    });
    expect(set.body.maxConcurrent).toBe(2);
    expect(await stored(json, r.body.id)).toBe(2);
    const reset = await json("PATCH", `/providers/${r.body.id}`, {
      maxConcurrent: null,
    });
    expect(reset.body.maxConcurrent).toBe(50);
    const builtin = await json("PATCH", "/providers/anthropic", {
      maxConcurrent: 8,
    });
    expect(builtin.body.maxConcurrent).toBe(8);
  });

  test("非法值被拒且不落库", async () => {
    const { json } = await launch();
    const r = await json("POST", "/providers", custom("ok", {}));
    for (const bad of [0, 1001, 2.5, "3", -1]) {
      const p = await json("PATCH", `/providers/${r.body.id}`, {
        maxConcurrent: bad,
      });
      expect(p.status, String(bad)).toBe(400);
      expect(p.body.error).toBe("invalid_max_concurrent");
    }
    expect(await stored(json, r.body.id)).toBe(50);
  });
});

describe("模型默认思考档位", () => {
  const think = {
    id: "m9",
    reasoning: true,
    levels: ["low", "high"],
    input: ["text"],
    ctx: 1000,
    out: 100,
  };
  type Spec = { id: string; reasoning: boolean; levels: string[] } & Record<
    string,
    unknown
  >;
  type View = { id: string; models: Spec[] };
  const views = (body: unknown) => (body as { providers: View[] }).providers;
  const firstOf = (body: unknown, id: string) =>
    views(body).find((p) => p.id === id)?.models[0];

  test("合法值往返；off 合法；null / 缺省都不预填", async () => {
    const { json } = await launch();
    const created = await json(
      "POST",
      "/providers",
      custom("ok", { models: [{ ...think, defaultLevel: "high" }] }),
    );
    expect(created.status).toBe(201);
    expect(created.body.models[0].defaultLevel).toBe("high");
    expect(
      firstOf((await json("GET", "/providers")).body, created.body.id)
        ?.defaultLevel,
    ).toBe("high");

    const off = await json("PATCH", `/providers/${created.body.id}`, {
      models: [{ ...think, defaultLevel: "off" }],
    });
    expect(off.status).toBe(200);
    expect(off.body.models[0].defaultLevel).toBe("off");

    const nul = await json("PATCH", `/providers/${created.body.id}`, {
      models: [{ ...think, defaultLevel: null }],
    });
    expect(nul.status).toBe(200);
    expect(nul.body.models[0]).not.toHaveProperty("defaultLevel");

    const absent = await json("PATCH", `/providers/${created.body.id}`, {
      models: [think],
    });
    expect(absent.status).toBe(200);
    expect(absent.body.models[0]).not.toHaveProperty("defaultLevel");
  });

  test("不在 levels 里、未知档位、非思考模型给了值都是 invalid_models", async () => {
    const { json } = await launch();
    const created = await json(
      "POST",
      "/providers",
      custom("ok", { models: [{ ...think, defaultLevel: "high" }] }),
    );
    for (const models of [
      [{ ...think, defaultLevel: "max" }],
      [{ ...think, defaultLevel: "off-ish" }],
      [{ ...think, reasoning: false, levels: [], defaultLevel: "high" }],
      [{ ...think, reasoning: false, levels: [], defaultLevel: "off" }],
    ]) {
      const r = await json("PATCH", `/providers/${created.body.id}`, {
        models,
      });
      expect(r.status, JSON.stringify(models)).toBe(400);
      expect(r.body.error).toBe("invalid_models");
    }
    // 被拒的都没落库
    expect(
      firstOf((await json("GET", "/providers")).body, created.body.id)
        ?.defaultLevel,
    ).toBe("high");
  });

  test("内置供应商里添加的目录模型设了 defaultLevel：列表带出它；models.json 预览里没有它", async () => {
    const { json } = await launch();
    const cat = (await json("GET", "/providers/anthropic/catalog-models")).body
      .models as Spec[];
    const base = cat.find((m) => m.reasoning);
    expect(base).toBeDefined();
    const level = base?.levels.find((l) => l !== "off");
    const saved = await json("PATCH", "/providers/anthropic", {
      models: [{ ...base, defaultLevel: level }],
    });
    expect(saved.status).toBe(200);
    const after = views((await json("GET", "/providers")).body);
    const mine = after
      .find((p) => p.id === "anthropic")
      ?.models.find((m) => m.id === base?.id);
    expect(mine?.defaultLevel).toBe(level);

    const preview = await json("GET", "/models-json");
    expect(JSON.stringify(preview.body)).not.toContain("defaultLevel");
  });
});
