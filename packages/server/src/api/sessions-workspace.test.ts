import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
import { DirectoryResolver } from "../session/directory-resolver.js";
import type { SessionPool } from "../session/pool.js";
import { SessionConfigService } from "../session/session-config.js";
import { WorkspaceService } from "../session/workspaces.js";
import { SessionConfigStore } from "../store/session-configs.js";
import { DEFAULTS, sessionsApi } from "./sessions.js";

const stub = await startStub(() => "好的");
afterAll(() => stub.close());

let app: FastifyInstance | undefined;
let pool: SessionPool | undefined;
let data: TestData | undefined;
let presets: ReturnType<typeof testPresets>;
let service: WorkspaceService;

afterEach(async () => {
  await app?.close();
  pool?.dispose();
  data?.close();
  app = undefined;
  pool = undefined;
  data = undefined;
});

// 真实库 + 真实目录；本机目录解析，模型校验看 configs 里登记的那一个。
async function boot() {
  data = testData();
  presets = testPresets(data);
  const configs = new SessionConfigService({
    store: new SessionConfigStore(data.db),
    defaults: data.defaults,
    resolver: {
      has: (p: string, m: string) => p === "m1" && m === "one",
    } as never,
  });
  pool = testPool(stubSessionFactory(stub), data, {
    configs,
    presetView: presets.view,
    modeView: presets.modeView,
  }).pool;
  service = new WorkspaceService({
    workspaces: data.workspaces,
    mounts: data.workspaceDirectories,
    groups: data.workspaceGroups,
    layouts: data.workspaceLayouts,
    directories: data.directories,
    pool,
    resolver: new DirectoryResolver({
      hub: { getSsh: () => null },
      directories: data.directories,
    } as never),
    presets: presets.presets,
    modelCheck: (p, m) => p === "m1" && m === "one",
  });
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(sessionsApi, {
    ...DEFAULTS,
    pool,
    workspaceDefaults: (id: string) => service.defaultsFor(id),
  });
  await app.ready();
  return data;
}

const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
  const res = await (app as FastifyInstance).inject({
    method,
    url: `/api/v1${url}`,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
};

const dir = (d: TestData, name: string) => {
  mkdirSync(join(d.dir, name), { recursive: true });
  return { path: join(d.dir, name) };
};

type Created = { id: string; workspaceId: string | null; directoryId: string };
type Config = {
  model: Record<string, unknown>;
  capabilities: string[] | null;
  permissionTier: string | null;
};

describe("POST /sessions 带 workspaceId", () => {
  test("加入该工作区；默认配置（Agent、模式、模型、权限档）被拷贝进新会话", async () => {
    const d = await boot();
    const ws = await service.create({
      directories: [dir(d, "alpha")],
      defaults: {
        agentPresetId: presets.reviewer.id,
        modePresetIds: [presets.mode.id],
        model: { provider: "m1", model: "one", reasoning: "low" },
        permissionTier: "full",
      },
    });
    const r = await call("POST", "/sessions", { workspaceId: ws.workspace.id });
    expect(r.status).toBe(201);
    const created = r.body as Created;
    expect(created.workspaceId).toBe(ws.workspace.id);
    expect(created.directoryId).toBe(ws.workspace.directories[0]?.id);
    expect(pool?.workspaceIdOf(created.id)).toBe(ws.workspace.id);

    const cfg = (await call("GET", `/sessions/${created.id}/config`))
      .body as Config;
    expect(cfg.model).toEqual({
      mode: "explicit",
      provider: "m1",
      model: "one",
      reasoning: "low",
    });
    expect(cfg.capabilities).toEqual(presets.reviewer.capabilities);
    expect(cfg.permissionTier).toBe("full");
    const info = pool?.info(created.id);
    expect(info?.promptPresetId).toBe(presets.reviewer.id);
    expect(info?.modePresetIds).toEqual([presets.mode.id]);
  });

  test("body 里显式给的字段覆盖工作区默认", async () => {
    const d = await boot();
    const ws = await service.create({
      directories: [dir(d, "alpha")],
      defaults: {
        agentPresetId: presets.reviewer.id,
        permissionTier: "full",
        model: { provider: "m1", model: "one", reasoning: "low" },
      },
    });
    const r = await call("POST", "/sessions", {
      workspaceId: ws.workspace.id,
      promptPresetId: presets.coder.id,
      modePresetIds: [presets.mode.id],
      config: {
        model: { mode: "follow-default" },
        permissionTier: "rules",
        capabilities: ["tool:read"],
      },
    });
    expect(r.status).toBe(201);
    const created = r.body as Created;
    const cfg = (await call("GET", `/sessions/${created.id}/config`))
      .body as Config;
    expect(cfg.model).toEqual({ mode: "follow-default" });
    expect(cfg.permissionTier).toBe("rules");
    expect(cfg.capabilities).toEqual(["tool:read"]);
    const info = pool?.info(created.id);
    expect(info?.promptPresetId).toBe(presets.coder.id);
    expect(info?.modePresetIds).toEqual([presets.mode.id]);
  });

  test("不给 workspaceId 时行为不变：配置跟随默认、响应里 workspaceId 是自动建出来的那个", async () => {
    await boot();
    const r = await call("POST", "/sessions", {});
    expect(r.status).toBe(201);
    const created = r.body as Created;
    // 没给工作区时池里按主目录自动建一个；配置仍是「跟随默认 + 不带权限」
    expect(created.workspaceId).toEqual(expect.any(String));
    const cfg = (await call("GET", `/sessions/${created.id}/config`))
      .body as Config;
    expect(cfg).toMatchObject({
      model: { mode: "follow-default" },
      permissionTier: null,
    });
  });

  test("工作区不存在或类型不对是 400", async () => {
    await boot();
    expect(
      (await call("POST", "/sessions", { workspaceId: "nope" })).status,
    ).toBe(400);
    expect((await call("POST", "/sessions", { workspaceId: 5 })).status).toBe(
      400,
    );
  });

  test("默认配置引用的预设已被删：套用时当作没覆盖，不让创建失败", async () => {
    const d = await boot();
    const ws = await service.create({
      directories: [dir(d, "alpha")],
      defaults: {
        agentPresetId: presets.reviewer.id,
        modePresetIds: [presets.mode.id],
      },
    });
    presets.presets.remove(presets.reviewer.id);
    presets.presets.remove(presets.mode.id);
    const r = await call("POST", "/sessions", { workspaceId: ws.workspace.id });
    expect(r.status).toBe(201);
    const created = r.body as Created;
    const info = pool?.info(created.id);
    expect(info?.promptPresetId).toBeNull();
    expect(info?.modePresetIds).toEqual([]);
  });
});
