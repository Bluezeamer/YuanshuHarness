// 迁移自 provider-settings.smoke / schema 脚本：models.json 预览的内容形状，以及产物是否被 pi 接受。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ModelSpec, ProviderRecord } from "../store/providers.js";
import { Catalog } from "./catalog.js";
import { diffJson, liveModelsJson, MASK, maskKeys } from "./models-json.js";

let dir: string;
let catalog: Catalog;
let cat: ModelSpec[];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-modelsjson-"));
  catalog = await Catalog.create(path.join(dir, "agent"));
  cat = catalog.models("anthropic");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rec = (over: Partial<ProviderRecord>): ProviderRecord => ({
  id: "x",
  custom: false,
  name: null,
  slug: null,
  api: null,
  baseUrl: null,
  method: "key",
  keyStorage: "auth",
  envVariable: null,
  command: null,
  secretId: null,
  authHeader: null,
  maxConcurrent: null,
  compat: null,
  models: [],
  lastTest: null,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  ...over,
});

const spec = (id: string, over: Partial<ModelSpec> = {}): ModelSpec => ({
  id,
  name: id,
  reasoning: false,
  levels: [],
  input: ["text"],
  ctx: 0,
  out: 0,
  source: "manual",
  ...over,
});

const EU = "https://eu.example/v1";

// 内置供应商的两类改动：覆盖目录模型规格 + 覆盖端点地址；另加一个目录里没有的模型
const builtinRec = () =>
  rec({
    id: "anthropic",
    baseUrl: EU,
    models: [
      { ...(cat[0] as ModelSpec), ctx: 150000, source: "manual" },
      spec("claude-extra", { ctx: 64000, out: 8000 }),
    ],
  });

// 自定义端点：探测导入（规格未填）+ 手填规格（思考档位、映射、模态）
const customRec = () =>
  rec({
    id: "c1",
    custom: true,
    name: "团队 vLLM 网关",
    slug: "team-vllm",
    api: "openai-completions",
    baseUrl: "http://10.0.0.9:8000/v1",
    keyStorage: "models",
    secretId: "s1",
    compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    models: [
      spec("probed-a", { source: "probe" }),
      spec("thinker", {
        reasoning: true,
        levels: ["off", "low", "xhigh"],
        map: { xhigh: "x-high" },
        input: ["text", "image", "audio"],
        ctx: 262144,
        out: 32768,
      }),
    ],
  });

describe("liveModelsJson 内容形状", () => {
  test("内置供应商：只写 baseUrl 覆盖 + modelOverrides + 目录外新增的模型，不重写整段 models", () => {
    const live = liveModelsJson(catalog, [builtinRec()]);
    expect(live.providers.anthropic).toEqual({
      baseUrl: EU,
      modelOverrides: { [(cat[0] as ModelSpec).id]: { contextWindow: 150000 } },
      models: [
        {
          id: "claude-extra",
          name: "claude-extra",
          reasoning: false,
          input: ["text"],
          contextWindow: 64000,
          maxTokens: 8000,
        },
      ],
    });
  });

  test("内置供应商只改了地址、或模型与目录一致：不产生 modelOverrides / models", () => {
    const onlyBase = liveModelsJson(catalog, [
      rec({ id: "anthropic", baseUrl: EU }),
    ]);
    expect(onlyBase.providers.anthropic).toEqual({ baseUrl: EU });
    const same = liveModelsJson(catalog, [
      rec({ id: "anthropic", models: [{ ...(cat[0] as ModelSpec) }] }),
    ]);
    expect(same.providers).toEqual({});
  });

  test("自定义端点：以 slug 为键，带协议、地址、兼容项；规格为 0 的字段不写；audio 丢弃；没有 cost", () => {
    const live = liveModelsJson(catalog, [customRec()]);
    const p = live.providers["team-vllm"] as Record<string, unknown>;
    expect(p).toMatchObject({
      baseUrl: "http://10.0.0.9:8000/v1",
      api: "openai-completions",
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    });
    const [probed, thinker] = p.models as Record<string, unknown>[];
    expect(probed).toEqual({
      id: "probed-a",
      name: "probed-a",
      reasoning: false,
      input: ["text"],
    });
    expect(thinker).toMatchObject({
      id: "thinker",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 32768,
      // 默认档里没勾的写 null；xhigh 必须显式映射才算支持；未勾的 max 不出现
      thinkingLevelMap: {
        minimal: null,
        medium: null,
        high: null,
        xhigh: "x-high",
      },
    });
    expect(JSON.stringify(live)).not.toContain('"cost"');
  });

  test("apiKey：models.json 档只放占位，环境变量写 $VAR，命令写 !cmd；auth.json 档不写", () => {
    const live = liveModelsJson(catalog, [
      customRec(),
      rec({
        id: "c2",
        custom: true,
        slug: "via-env",
        api: "openai-completions",
        baseUrl: "http://h/v1",
        method: "env",
        envVariable: "VLLM_KEY",
      }),
      rec({
        id: "c3",
        custom: true,
        slug: "via-cmd",
        api: "openai-completions",
        baseUrl: "http://h/v1",
        method: "cmd",
        command: "pass show vllm",
      }),
      // auth.json 档：密钥不在 models.json 里
      rec({
        id: "c4",
        custom: true,
        slug: "in-auth",
        api: "openai-completions",
        baseUrl: "http://h/v1",
        secretId: "s4",
      }),
    ]);
    const key = (slug: string) =>
      (live.providers[slug] as Record<string, unknown>).apiKey;
    expect(key("team-vllm")).toBe(MASK);
    expect(key("via-env")).toBe("$VLLM_KEY");
    expect(key("via-cmd")).toBe("!pass show vllm");
    expect(key("in-auth")).toBeUndefined();
  });

  test("maskKeys：磁盘文件里手写的明文 key 被遮掉，$VAR 与 !cmd 保留", () => {
    const masked = maskKeys({
      providers: {
        a: { apiKey: "sk-plain-123" },
        b: { apiKey: "$ENV_KEY" },
        c: { apiKey: "!pass show x", models: [{ id: "m" }] },
      },
    });
    expect(masked).toEqual({
      providers: {
        a: { apiKey: MASK },
        b: { apiKey: "$ENV_KEY" },
        c: { apiKey: "!pass show x", models: [{ id: "m" }] },
      },
    });
  });

  test("diffJson：数组里带 id 的元素按 id 对齐，只列变化的叶子", () => {
    const before = {
      providers: { p: { models: [{ id: "a", maxTokens: 1 }] } },
    };
    const after = {
      providers: {
        p: {
          models: [
            { id: "b", maxTokens: 2 },
            { id: "a", maxTokens: 9 },
          ],
        },
      },
    };
    expect(diffJson(before, after)).toEqual([
      {
        op: "replace",
        path: "/providers/p/models/a/maxTokens",
        before: 1,
        after: 9,
      },
      {
        op: "add",
        path: "/providers/p/models/b",
        after: { id: "b", maxTokens: 2 },
      },
    ]);
  });
});

// pi 加载 models.json 时用同一份 schema（models.schema.json 由它的类型定义生成）校验，
// 校验不过整份文件会被丢弃并报错；所以「pi 能加载且没有 getError」就是 schema 等价校验。
describe("产物被 pi 接受", () => {
  const load = async (name: string, content: unknown) => {
    const file = path.join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(content));
    return ModelRuntime.create({
      authPath: path.join(dir, `${name}-auth.json`),
      modelsPath: file,
      refreshOnCreate: false,
    });
  };

  test("内置覆盖 + 自定义端点（探测导入、思考映射、兼容项、占位 key）通过 schema，且覆盖真的生效", async () => {
    const live = liveModelsJson(catalog, [builtinRec(), customRec()]);
    const rt = await load("both", live);
    expect(rt.getError()).toBeUndefined();
    expect(
      rt.getModel("anthropic", (cat[0] as ModelSpec).id)?.contextWindow,
    ).toBe(150000);
    expect(rt.getModel("anthropic", "claude-extra")?.maxTokens).toBe(8000);
    expect(rt.getModels("team-vllm").map((m) => m.id)).toEqual([
      "probed-a",
      "thinker",
    ]);
    expect(rt.getModel("team-vllm", "thinker")?.input).toEqual([
      "text",
      "image",
    ]);
  });

  test("对照：schema 不接受的内容（contextWindow 为 0）会被 pi 报错——所以规格为 0 必须省略", async () => {
    const rt = await load("bad", {
      providers: {
        x: { models: [{ id: "m", contextWindow: 0 }] },
      },
    });
    expect(rt.getError()).toContain("Invalid models.json schema");
  });
});
