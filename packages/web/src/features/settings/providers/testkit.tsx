// 仅测试使用：供应商视图的构造器 + 带状态的假 fetch（模拟服务端的合并与校验语义）。
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type {
  CreateProviderInput,
  LoginState,
  ModelSpec,
  ProviderView,
  TestResult,
  UpdateProviderInput,
} from "../../../api/providers";
import { ToastHost } from "../../../ui";

import { ProvidersPage } from "./ProvidersPage";

export const reply = (status: number, body: unknown = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

export const model = (
  id: string,
  over: Partial<ModelSpec> = {},
): ModelSpec => ({
  id,
  name: id,
  reasoning: false,
  levels: [],
  input: ["text"],
  ctx: 200000,
  out: 8192,
  source: "catalog",
  ...over,
});

const CHAIN = (hit: string | null) =>
  (["--api-key", "auth.json", "models.json", "env"] as const).map((source) => ({
    source,
    hit: source === hit,
  }));

export const builtin = (
  id: string,
  over: Partial<ProviderView> = {},
): ProviderView => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  custom: false,
  added: false,
  methods: ["oauth", "key", "env", "cmd"],
  method: "key",
  status: "off",
  api: "anthropic-messages",
  probeable: true,
  maxConcurrent: 50,
  keyStorage: "auth",
  hasKey: false,
  credential: { source: null, chain: CHAIN(null) },
  models: [],
  ...over,
});

export const custom = (
  id: string,
  over: Partial<ProviderView> = {},
): ProviderView => ({
  id,
  name: `自建 ${id}`,
  custom: true,
  added: true,
  methods: ["key", "env", "cmd"],
  method: "key",
  status: "warn",
  api: "openai-completions",
  baseUrl: "http://10.0.0.9:8000/v1",
  probeable: true,
  slug: id,
  maxConcurrent: 50,
  keyStorage: "auth",
  hasKey: true,
  credential: { source: "auth.json", chain: CHAIN("auth.json") },
  models: [],
  ...over,
});

export const okResult = (over: Partial<TestResult> = {}): TestResult => ({
  ok: true,
  failedStage: null,
  errorCode: null,
  stages: {
    credential: { state: "ok", ms: 2 },
    endpoint: { state: "ok", ms: 41 },
    models: { state: "ok", ms: 180 },
    token: { state: "ok", ms: 1240 },
  },
  lastTest: {
    at: "2026-10-25T06:03:00.000Z",
    ok: true,
    ttft: 1240,
    total: 1463,
    stage: "token",
  },
  ...over,
});

export const loginState = (over: Partial<LoginState> = {}): LoginState => ({
  loginId: "L1",
  status: "running",
  link: null,
  device: null,
  message: null,
  prompt: null,
  error: null,
  ...over,
});

// 返回 Promise 可以把响应挂起，用来测“进行中”的状态。
export type Handler = (
  body: unknown,
  match: RegExpExecArray,
) => Response | Promise<Response> | undefined;

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * 假服务端：GET/POST/PATCH/DELETE /api/v1/providers，probe / test / models-json。
 * `on()` 注册的覆盖优先于默认行为（返回 undefined = 落回默认）。
 */
export function fakeApi(initial: ProviderView[]) {
  let list = structuredClone(initial);
  const calls: Call[] = [];
  const cancelled: string[] = [];
  const overrides: { key: string; re: RegExp; fn: Handler }[] = [];
  let probeIds = ["m-a", "m-b", "m-c"];
  let catalogList: ModelSpec[] = [];
  let def: { provider: string; model: string; thinking: string | null } | null =
    null;
  let testResult: TestResult = okResult();
  // 登录：start 返回第一帧，之后每次 GET 依次返回下一帧（用完停在最后一帧）；走到 done 时把供应商记成已登录
  let loginFrames: LoginState[] = [loginState()];
  let loginAt = 0;
  const answers: { promptId: string; value: string }[] = [];

  const patch = (cur: ProviderView, b: UpdateProviderInput): Response => {
    if (!cur.custom && (b.name || b.slug || b.api || b.envVariable))
      return reply(400, { error: "builtin_immutable" });
    const next: ProviderView = { ...cur };
    for (const [k, v] of Object.entries(b)) {
      if (k === "apiKey") next.hasKey = v !== null;
      else if (k === "models") next.models = v as ModelSpec[];
      else if (v === null)
        delete (next as unknown as Record<string, unknown>)[k];
      else (next as unknown as Record<string, unknown>)[k] = v;
    }
    // 连通性相关字段变了：旧测试结果作废（服务端同样处理），自定义端点回到“待核验”
    if (Object.keys(b).some((k) => k !== "models" && k !== "name")) {
      delete next.lastTest;
      if (next.custom) next.status = "warn";
    }
    list = list.map((p) => (p.id === cur.id ? next : p));
    return reply(200, next);
  };

  const route = (
    method: string,
    path: string,
    body: unknown,
  ): Response | Promise<Response> => {
    for (const o of overrides) {
      const m = o.re.exec(`${method} ${path}`);
      const r = m && o.fn(body, m);
      if (r) return r;
    }
    if (method === "GET" && path === "/api/v1/providers")
      return reply(200, { providers: list });
    if (method === "POST" && path === "/api/v1/providers") {
      const b = body as CreateProviderInput;
      if (list.some((p) => p.id === b.slug))
        return reply(409, { error: "slug_taken" });
      const v = custom(b.slug, {
        name: b.name,
        api: b.api,
        baseUrl: b.baseUrl,
        keyStorage: b.keyStorage ?? "auth",
        hasKey: Boolean(b.apiKey),
        status: "warn", // 自定义端点没测通之前一律是“待核验”（无密钥的本地端点也是）
      });
      list = [...list, v];
      return reply(201, v);
    }
    const one = /^\/api\/v1\/providers\/([^/]+)(\/.*)?$/.exec(path);
    const cur = one && list.find((p) => p.id === one[1]);
    if (one && !cur) return reply(404, { error: "not_found" });
    if (cur && !one?.[2]) {
      if (method === "PATCH") return patch(cur, body as UpdateProviderInput);
      if (method === "DELETE") {
        // 与服务端一致：自定义端点删掉；内置供应商清掉保存的配置，回到没配置过的样子
        list = cur.custom
          ? list.filter((p) => p.id !== cur.id)
          : list.map((p) =>
              p.id === cur.id
                ? builtin(cur.id, {
                    name: cur.name,
                    api: cur.api,
                    // 环境变量里的凭据不归元枢管，删完状态与凭据不变
                    status: cur.credential.chain.some(
                      (t) => t.source === "env" && t.hit,
                    )
                      ? "ok"
                      : "off",
                    credential: cur.credential.chain.some(
                      (t) => t.source === "env" && t.hit,
                    )
                      ? cur.credential
                      : { source: null, chain: CHAIN(null) },
                  })
                : p,
            );
        return reply(204);
      }
    }
    if (cur && one?.[2] === "/login" && method === "POST") {
      loginAt = 0;
      return reply(201, loginFrames[0]);
    }
    const lg = one && /^\/login\/([^/]+)(\/answer)?$/.exec(one[2] ?? "");
    if (cur && lg && method === "GET") {
      loginAt = Math.min(loginAt + 1, loginFrames.length - 1);
      const f = loginFrames[loginAt] as LoginState;
      if (f.status === "done") {
        list = list.map((p) =>
          p.id === cur.id
            ? {
                ...p,
                method: "oauth",
                status: "ok",
                credential: { source: "auth.json", chain: CHAIN("auth.json") },
              }
            : p,
        );
      }
      return reply(200, f);
    }
    if (cur && lg?.[2] && method === "POST") {
      answers.push(body as { promptId: string; value: string });
      return reply(204);
    }
    if (cur && lg && method === "DELETE") {
      cancelled.push(cur.id);
      return reply(204);
    }
    if (cur && one?.[2] === "/logout" && method === "POST") {
      const next: ProviderView = {
        ...cur,
        method: "key",
        status: "off",
        credential: { source: null, chain: CHAIN(null) },
      };
      list = list.map((p) => (p.id === cur.id ? next : p));
      return reply(200, next);
    }
    if (cur && one?.[2] === "/catalog-models")
      return reply(200, { models: cur.custom ? [] : catalogList });
    if (cur && one?.[2] === "/models/probe")
      return reply(200, { ids: probeIds });
    if (cur && one?.[2] === "/test") return reply(200, testResult);
    if (path === "/api/v1/default-model") {
      if (method === "PUT") {
        const b = body as {
          provider: string;
          model: string;
          thinking?: string;
        };
        if (
          !list.some(
            (p) =>
              p.id === b.provider && p.models.some((m) => m.id === b.model),
          )
        )
          return reply(404, { error: "unknown_model" });
        def = {
          provider: b.provider,
          model: b.model,
          thinking: b.thinking ?? null,
        };
      }
      // 与服务端一致：没人显式设置时，回落到第一个带模型的供应商的第一个模型
      const first = list.find((p) => p.models.length > 0);
      return reply(200, {
        default:
          def ??
          (first
            ? { provider: first.id, model: first.models[0]?.id, thinking: null }
            : null),
      });
    }
    if (path === "/api/v1/models-json")
      return reply(200, {
        path: "/data/models.json",
        exists: false,
        current: null,
        live: { providers: {} },
        diff: [],
      });
    return reply(404, { error: "not_found" });
  };

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: input, body });
    return route(method, input, body);
  });

  return {
    fetchMock,
    calls,
    /** 某个方法+路径正则（如 "PATCH /api/v1/providers/x"）的覆盖响应。 */
    on(key: string, fn: Handler) {
      overrides.push({ key, re: new RegExp(`^${key}$`), fn });
    },
    setProbe(ids: string[]) {
      probeIds = ids;
    },
    /** 内置供应商的目录模型（GET …/catalog-models 返回）。 */
    setCatalog(models: ModelSpec[]) {
      catalogList = models;
    },
    setTest(r: TestResult) {
      testResult = r;
    },
    setLogin(frames: LoginState[]) {
      loginFrames = frames;
    },
    answers,
    cancelled,
    /** 只看写请求（非 GET）。 */
    writes: () => calls.filter((c) => c.method !== "GET"),
    get list() {
      return list;
    },
  };
}

export type FakeApi = ReturnType<typeof fakeApi>;

/** 挂载供应商页并等到首屏出现。 */
export const ready = (id: string, over: Partial<ProviderView> = {}) =>
  builtin(id, {
    added: true,
    status: "ok",
    hasKey: true,
    credential: { source: "auth.json", chain: CHAIN("auth.json") },
    ...over,
  });

export async function mount(
  list: ProviderView[] = [custom("vllm"), ready("anthropic")],
): Promise<FakeApi> {
  const api = fakeApi(list);
  vi.stubGlobal("fetch", api.fetchMock);
  render(
    <>
      <ProvidersPage />
      <ToastHost />
    </>,
  );
  await screen.findByRole("article");
  return api;
}

export const patchesOf = (api: FakeApi) =>
  api.writes().filter((c) => c.method === "PATCH");

/** 第 n 个 PATCH 里发出的 models（即“我的模型”全集）。 */
export const sentModelsOf = (api: FakeApi, n: number) =>
  (
    patchesOf(api)[n]?.body as
      | { models?: Record<string, unknown>[] }
      | undefined
  )?.models ?? [];
