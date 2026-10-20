import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../server.js";
import { buildRuntime } from "../store/models.js";
import type { SecretStore } from "../store/secrets.js";

const TOKEN = "t".repeat(40);
let base: string;
let server: YuanshuServer | null = null;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-models-"));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  rmSync(base, { recursive: true, force: true });
});

async function launch() {
  const dataDir = path.join(base, "data");
  const start = path.join(base, "start");
  mkdirSync(dataDir);
  mkdirSync(start);
  server = createServer(
    { host: "127.0.0.1", port: 0, dataDir, token: TOKEN, allowCidrs: [] },
    { startDir: start },
  );
  const addr = await server.start();
  const call = (method: string, url: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${addr.port}/api/v1/models${url}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const json = async (method: string, url: string, body?: unknown) =>
    (await call(method, url, body)).json() as Promise<any>;
  return { call, json, dataDir };
}

const body = (over: Record<string, unknown> = {}) => ({
  name: "本地",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1/v1",
  modelId: "m1",
  apiKey: "sk-super-secret",
  ...over,
});

describe("模型登记", () => {
  test("登记成功：首条自动成为默认，响应与落盘文件都不含密钥", async () => {
    const { call, dataDir } = await launch();
    const res = await call("POST", "", body());
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({
      name: "本地",
      isDefault: true,
      hasKey: true,
    });
    expect(JSON.stringify(created)).not.toContain("sk-super-secret");
    for (const f of readdirSync(path.join(dataDir, "models"))) {
      expect(
        readFileSync(path.join(dataDir, "models", f), "utf8"),
      ).not.toContain("sk-super-secret");
    }
  });

  test("切换默认只留一个；删除默认后另一条顶上", async () => {
    const { call, json } = await launch();
    const a = await json("POST", "", body({ name: "a" }));
    const b = await json("POST", "", body({ name: "b" }));
    await call("PATCH", `/${b.id}`, { isDefault: true });
    let list = (await json("GET", "")).models;
    expect(
      list.filter((m: { isDefault: boolean }) => m.isDefault),
    ).toHaveLength(1);
    expect(list.find((m: { id: string }) => m.id === b.id).isDefault).toBe(
      true,
    );
    expect((await call("DELETE", `/${b.id}`)).status).toBe(204);
    list = (await json("GET", "")).models;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.id, isDefault: true });
  });

  test("字段非法返回 400；不存在的 id 返回 404", async () => {
    const { call } = await launch();
    expect((await call("POST", "", body({ baseUrl: "ftp://x" }))).status).toBe(
      400,
    );
    expect((await call("POST", "", body({ api: "nope" }))).status).toBe(400);
    expect((await call("DELETE", "/missing")).status).toBe(404);
  });

  test("连接测试：不可达的地址返回 ok:false 与原因，且不落盘", async () => {
    const { call, dataDir } = await launch();
    const res = await call("POST", "/test", body());
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; error: unknown };
    expect(out.ok).toBe(false);
    expect(typeof out.error).toBe("string");
    expect(readdirSync(path.join(dataDir, "models"))).toEqual([]);
  });
});

// 与真实 pi models.json 同形状的 provider（值全是假的）：向导登记后生成的配置应与之等价。
const PI_SHAPE = {
  providers: {
    fake: {
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      apiKey: "sk-fake",
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      models: [
        {
          id: "m-fake",
          name: "Fake",
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            low: "low",
            medium: null,
            high: "xhigh",
            xhigh: null,
            max: null,
          },
          input: ["text", "image"],
          contextWindow: 210000,
          maxTokens: 131072,
        },
      ],
    },
  },
};

describe("模型向导的 compat / thinkingLevelMap", () => {
  test("按 pi models.json 的形状登记，解析出的模型与手写配置等价", async () => {
    const { json, dataDir } = await launch();
    const p = PI_SHAPE.providers.fake;
    const m = p.models[0] as (typeof p.models)[0];
    const created = await json("POST", "", {
      name: "Fake",
      api: p.api,
      baseUrl: p.baseUrl,
      modelId: m.id,
      apiKey: p.apiKey,
      compat: p.compat,
      reasoning: m.reasoning,
      thinkingLevelMap: m.thinkingLevelMap,
      input: m.input,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    });
    expect(created).toMatchObject({
      compat: p.compat,
      thinkingLevelMap: m.thinkingLevelMap,
      input: ["text", "image"],
      maxTokens: 131072,
    });

    // 手写：直接把 PI_SHAPE 当 models.json 让 SDK 解析
    const handDir = path.join(base, "hand");
    mkdirSync(handDir);
    const handFile = path.join(handDir, "models.json");
    writeFileSync(handFile, JSON.stringify(PI_SHAPE));
    const hand = (
      await ModelRuntime.create({
        authPath: path.join(handDir, "auth.json"),
        modelsPath: handFile,
      })
    ).getModel("fake", "m-fake");

    const stored = JSON.parse(
      readFileSync(path.join(dataDir, "models", `${created.id}.json`), "utf8"),
    );
    const { runtime, model } = await buildRuntime(
      path.join(base, "agent"),
      stored,
      { reveal: () => null } as unknown as SecretStore,
      "sk-fake",
    );
    expect(runtime).toBeDefined();
    const pick = (x: NonNullable<typeof hand>) => ({
      reasoning: x.reasoning,
      input: x.input,
      thinkingLevelMap: x.thinkingLevelMap,
      contextWindow: x.contextWindow,
      maxTokens: x.maxTokens,
      compat: x.compat,
      api: x.api,
    });
    expect(pick(model)).toEqual(pick(hand as NonNullable<typeof hand>));
  });

  test("非法 compat / thinkingLevelMap / input 返回 400", async () => {
    const { call } = await launch();
    for (const bad of [
      { compat: { nope: true } },
      { compat: { supportsDeveloperRole: "yes" } },
      { compat: { maxTokensField: "x" } },
      { thinkingLevelMap: { turbo: "x" } },
      { thinkingLevelMap: { low: 3 } },
      { input: ["audio"] },
      { maxTokens: -1 },
    ])
      expect((await call("POST", "", body(bad))).status).toBe(400);
  });
});
