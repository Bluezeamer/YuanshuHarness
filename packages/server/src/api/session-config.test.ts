import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
  testPresets,
} from "../../test/support/stub.js";
import type { ModelResolver } from "../provider/resolve.js";
import type {
  FactoryOptions,
  SessionFactory,
  SessionPool,
} from "../session/pool.js";
import { SessionConfigService } from "../session/session-config.js";
import { TOOL_NAMES } from "../session/tool-catalog.js";
import { type ModelEntry, ModelStore } from "../store/models.js";
import { SessionConfigStore } from "../store/session-configs.js";
import { DEFAULTS, sessionsApi } from "./sessions.js";

const stub = await startStub(() => "ok");
afterAll(() => stub.close());

let app: FastifyInstance | undefined;
let pool: SessionPool;
let data: TestData | undefined;
let captured: FactoryOptions[] = [];
let models: ModelStore;
let presets: ReturnType<typeof testPresets>;

afterEach(async () => {
  await app?.close();
  pool?.dispose();
  data?.close();
  app = undefined;
  data = undefined;
});

const entry = (id: string, modelId: string): ModelEntry => ({
  id,
  name: id,
  api: "openai-completions",
  baseUrl: stub.url,
  modelId,
  contextWindow: null,
  maxTokens: null,
  reasoning: true,
  input: ["text"],
  thinkingLevelMap: null,
  compat: null,
  secretId: null,
  isDefault: false,
});

async function boot() {
  data = testData();
  presets = testPresets(data);
  models = new ModelStore(data.dir);
  models.save(entry("m1", "model-one"));
  models.save(entry("m2", "model-two"));
  const configs = new SessionConfigService({
    store: new SessionConfigStore(data.db),
    defaults: data.defaults,
    // 这里只关心模型登记；供应商那一路由 provider/resolve.test.ts 覆盖
    resolver: {
      has: (provider: string, model: string) =>
        models.get(provider)?.modelId === model,
    } as ModelResolver,
  });
  const base = stubSessionFactory(stub);
  const factory: SessionFactory = async (o) => {
    captured.push(o);
    return base(o);
  };
  captured = [];
  pool = testPool(factory, data, {
    configs,
    presetView: presets.view,
    modeView: presets.modeView,
  }).pool;
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(sessionsApi, { ...DEFAULTS, pool });
  await app.ready();
}

const call = async (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
) => {
  const res = await (app as FastifyInstance).inject({
    method,
    url: `/api/v1${url}`,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
};

const ok = async (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
) => {
  const r = await call(method, url, body);
  if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status}`);
  return r.body;
};

describe("GET /sessions/:id/config", () => {
  test("没选预设时：配置来自预设默认值（不限制能力、权限没覆盖即跟随全局），rev=1", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {});
    const cfg = await ok("GET", `/sessions/${s.id}/config`);
    expect(cfg).toMatchObject({
      sessionId: s.id,
      model: { mode: "follow-default" },
      capabilities: null,
      permissionTier: null,
      rev: 1,
    });
  });

  test("会话不存在 404", async () => {
    await boot();
    expect((await call("GET", "/sessions/nope/config")).status).toBe(404);
  });
});

describe("PATCH /sessions/:id/config", () => {
  test("写入并 rev+1；baseRev 过期 409 带当前值", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {});
    const r = await ok("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 1,
      patch: {
        model: {
          mode: "explicit",
          provider: "m1",
          model: "model-one",
          reasoning: "medium",
        },
      },
    });
    expect(r.config.rev).toBe(2);
    const stale = await call("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 1,
      patch: { capabilities: null },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.current.rev).toBe(2);
  });

  test("空 patch / 未知字段 / 非法引用各 400", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {});
    expect(
      (
        await call("PATCH", `/sessions/${s.id}/config`, {
          baseRev: 1,
          patch: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PATCH", `/sessions/${s.id}/config`, {
          baseRev: 1,
          patch: { agentId: "x" },
        })
      ).body.error,
    ).toBe("unknown_field");
    expect(
      (
        await call("PATCH", `/sessions/${s.id}/config`, {
          baseRev: 1,
          patch: {
            model: {
              mode: "explicit",
              provider: "nope",
              model: "x",
              reasoning: "medium",
            },
          },
        })
      ).body.error,
    ).toBe("unknown_model");
    expect(
      (
        await call("PATCH", `/sessions/${s.id}/config`, {
          baseRev: 1,
          patch: { capabilities: ["tool:read", "tool:nope"] },
        })
      ).body.error,
    ).toBe("unknown_tool");
    expect(
      (
        await call("PATCH", `/sessions/${s.id}/config`, {
          baseRev: 1,
          patch: { permissionTier: "standard" },
        })
      ).status,
    ).toBe(400);
  });

  test("选「模型」档要先配审批模型：没配 400 review_model_missing，配好后可写", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {});
    const r = await call("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 1,
      patch: { permissionTier: "auto" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("review_model_missing");
    data?.defaults.setReviewModel({
      provider: "m1",
      model: "model-one",
      thinking: null,
    });
    const okRes = await ok("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 1,
      patch: { permissionTier: "auto" },
    });
    expect(okRes.config.permissionTier).toBe("auto");
    // null = 清掉覆盖，回到跟随全局
    const back = await ok("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 2,
      patch: { permissionTier: null },
    });
    expect(back.config.permissionTier).toBeNull();
  });

  test("能力 / 权限档位写入；能力要等重新装载（next-run），档位即时", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {});
    const caps = await ok("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 1,
      patch: { capabilities: ["tool:read", "tool:grep"] },
    });
    expect(caps.appliedAt).toBe("next-run");
    expect(caps.config.capabilities).toEqual(["tool:read", "tool:grep"]);
    const tier = await ok("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 2,
      patch: { permissionTier: "full" },
    });
    expect(tier.appliedAt).toBe("now");
    expect(tier.config.permissionTier).toBe("full");
  });
});

describe("POST /sessions 的预设默认值与覆盖", () => {
  test("选 reviewer 预设：默认能力来自预设，权限不带（预设不带权限），工厂拿到收窄后的工具", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {
      promptPresetId: presets.reviewer.id,
    });
    const cfg = await ok("GET", `/sessions/${s.id}/config`);
    expect(cfg.capabilities).toEqual(presets.reviewer.capabilities);
    expect(cfg.permissionTier).toBeNull();
    // 工厂拿到的是「全部可用工具」的白名单；能力靠运行时的启用集合开关
    const opts = captured.find((o) => o.id === s.id);
    expect(opts?.agent?.tools).toEqual(
      expect.arrayContaining([...TOOL_NAMES, "call_tool", "ask_user"]),
    );
    const enabled = pool.enabledTools(s.id);
    expect(enabled).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls", "call_tool"]),
    );
    expect(enabled).not.toContain("write");
    expect(enabled).not.toContain("bash");
  });

  test("不选预设：coder-full 不限制能力，工具是全部内置工具", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {});
    const cfg = await ok("GET", `/sessions/${s.id}/config`);
    expect(cfg.capabilities).toBeNull();
    const opts = captured.find((o) => o.id === s.id);
    expect(opts?.agent?.tools).toEqual(
      expect.arrayContaining([...TOOL_NAMES, "ask_user", "todo_write"]),
    );
  });

  test("面板可覆盖预设能力：配置里的能力优先", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {
      promptPresetId: presets.coder.id,
      config: { capabilities: ["tool:read"] },
    });
    const cfg = await ok("GET", `/sessions/${s.id}/config`);
    expect(cfg.capabilities).toEqual(["tool:read"]);
    expect(pool.enabledTools(s.id)).not.toContain("write");
  });

  test("选模式预设只进会话的可切换清单：不改默认能力与权限，激活之后才限制工具", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {
      modePresetIds: [presets.mode.id],
    });
    const cfg = await ok("GET", `/sessions/${s.id}/config`);
    // 模式不参与创建时的能力 / 权限默认值
    expect(cfg.capabilities).toBeNull();
    expect(cfg.permissionTier).toBeNull();
    expect(pool.enabledTools(s.id)).toContain("write");
    expect(pool.modeChoices(s.id).map((m) => m.id)).toEqual([presets.mode.id]);
    pool.setActiveMode(s.id, presets.mode.id);
    expect(pool.enabledTools(s.id)).not.toContain("write");
    expect(pool.enabledTools(s.id)).toContain("read");
  });

  test("config 非法 400 且不建会话", async () => {
    await boot();
    const r = await call("POST", "/sessions", {
      config: { capabilities: ["tool:nope"] },
    });
    expect(r.status).toBe(400);
    expect(pool.list()).toHaveLength(0);
  });
});

describe("刷新上下文与删除", () => {
  test("刷新上下文原地进行，不动 config（rev 不变）", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {});
    await ok("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 1,
      patch: { capabilities: ["tool:read"] },
    });
    const same = await ok("POST", `/sessions/${s.id}/refresh-context`);
    expect(same.id).toBe(s.id);
    const cfg = await ok("GET", `/sessions/${s.id}/config`);
    expect(cfg.capabilities).toEqual(["tool:read"]);
    expect(cfg.rev).toBe(2);
  });

  test("删除会话顺带删 config", async () => {
    await boot();
    const s = await ok("POST", "/sessions", {});
    await ok("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 1,
      patch: { capabilities: null },
    });
    expect((await call("DELETE", `/sessions/${s.id}`)).status).toBe(204);
    expect(new SessionConfigStore(data?.db as never).get(s.id)).toBeNull();
  });
});

describe("Agent 引用计数", () => {
  test("刚建好、还没跑过的会话也算引用（E4：此时删 Agent 会留下悬空引用）", async () => {
    await boot();
    expect(pool.agentRefCounts().get(presets.reviewer.id)).toBeUndefined();
    await ok("POST", "/sessions", { promptPresetId: presets.reviewer.id });
    await ok("POST", "/sessions", { promptPresetId: presets.reviewer.id });
    await ok("POST", "/sessions", {});
    expect(pool.agentRefCounts().get(presets.reviewer.id)).toBe(2);
  });
});

describe("提示词分组按会话的模型求值", () => {
  test("建会话时按所选模型选卡片；换模型后重建基线，选中的卡片跟着变", async () => {
    await boot();
    presets.cards.create({
      id: "k-a",
      group: "t",
      title: "a",
      body: "给 m1 的话",
    });
    presets.cards.create({
      id: "k-b",
      group: "t",
      title: "b",
      body: "给其他的话",
    });
    presets.presets.replaceNodes(presets.coder.id, [
      {
        id: "n-body",
        tag: "rules",
        title: "规则",
        slotKind: "custom",
        channel: "system",
        builtin: false,
        items: [
          {
            kind: "group",
            id: "g",
            name: "按模型",
            cards: [
              {
                cardId: "k-a",
                when: { kind: "model", providers: ["m1"], models: [] },
              },
              { cardId: "k-b", when: null },
            ],
          },
        ],
      },
    ]);
    const explicit = (provider: string, model: string) => ({
      mode: "explicit",
      provider,
      model,
      reasoning: "medium",
    });
    const s = await ok("POST", "/sessions", {
      promptPresetId: presets.coder.id,
      config: { model: explicit("m1", "model-one") },
    });
    const text = () =>
      captured.find((o) => o.id === s.id)?.agent?.promptText() ?? "";
    expect(text()).toContain("给 m1 的话");
    expect(text()).not.toContain("给其他的话");

    await ok("PATCH", `/sessions/${s.id}/config`, {
      baseRev: 1,
      patch: { model: explicit("m2", "model-two") },
    });
    expect(await pool.rebase(s.id)).toBe("synced");
    expect(text()).toContain("给其他的话");
    expect(text()).not.toContain("给 m1 的话");
  });
});
