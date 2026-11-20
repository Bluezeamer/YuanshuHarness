import { mkdirSync } from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance, FastifyReply } from "fastify";
import { uuidv7 } from "../id.js";
import { isObject, str } from "../lib/validate.js";
import {
  AUTH_HEADER_MAX,
  formatAuthHeader,
  parseAuthHeader,
} from "../provider/auth-header.js";
import type { Catalog } from "../provider/catalog.js";
import {
  type CredentialDeps,
  inspectCredential,
  type ResolvedAuth,
  resolveAuth,
} from "../provider/credentials.js";
import { diagnose } from "../provider/diagnose.js";
import { MAX_CONCURRENT_RANGE } from "../provider/limiter.js";
import {
  diffJson,
  liveModelsJson,
  maskKeys,
  readModelsJson,
} from "../provider/models-json.js";
import { canProbeApi, fetchModelIds, StageError } from "../provider/probe.js";
import { customProviderConfig } from "../provider/resolve.js";
import { buildView, CUSTOM_METHODS, isKeyless } from "../provider/view.js";
import {
  AUTH_METHODS,
  type AuthMethod,
  KEY_STORAGES,
  MODEL_INPUTS,
  MODEL_SOURCES,
  type ModelSpec,
  PROVIDER_APIS,
  type ProviderApi,
  type ProviderCompat,
  type ProviderRecord,
  type ProviderStore,
  THINKING_FORMATS,
  THINKING_LEVELS,
} from "../store/providers.js";
import type { SecretStore } from "../store/secrets.js";

const bad = (reply: FastifyReply, error: string) =>
  reply.code(error === "slug_taken" ? 409 : 400).send({ error });

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  list.includes(v as T);

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_MAX = 16 * 1024; // 与 SecretStore 的值上限一致
const MODELS_MAX = 1000;

const nonNegInt = (v: unknown): number | null =>
  v === undefined || v === null
    ? 0
    : typeof v === "number" && Number.isInteger(v) && v >= 0
      ? v
      : null;

// compat 三态：键缺省 = 自动，有值 = 显式。只收白名单键。
const COMPAT_BOOLS = [
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "requiresThinkingAsText",
] as const;

function parseCompat(v: unknown): ProviderCompat | null | string {
  if (v === undefined || v === null) return null;
  if (!isObject(v)) return "invalid_compat";
  const out: ProviderCompat = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null) continue;
    if (
      (COMPAT_BOOLS as readonly string[]).includes(k) &&
      typeof val === "boolean"
    )
      out[k as (typeof COMPAT_BOOLS)[number]] = val;
    else if (
      k === "maxTokensField" &&
      (val === "max_completion_tokens" || val === "max_tokens")
    )
      out.maxTokensField = val;
    else if (k === "thinkingFormat" && oneOf(THINKING_FORMATS, val))
      out.thinkingFormat = val;
    else return "invalid_compat";
  }
  return Object.keys(out).length ? out : null;
}

function parseModel(v: unknown): ModelSpec | null {
  if (!isObject(v)) return null;
  const id = str(v.id, 200);
  if (!id) return null;
  const reasoning = v.reasoning === true;
  const levels = v.levels ?? [];
  if (
    !Array.isArray(levels) ||
    levels.some((l) => !oneOf(THINKING_LEVELS, l)) ||
    (!reasoning && levels.length > 0)
  )
    return null;
  let map: ModelSpec["map"];
  if (v.map !== undefined && v.map !== null) {
    if (!isObject(v.map)) return null;
    map = {};
    for (const [k, val] of Object.entries(v.map)) {
      if (
        !oneOf(THINKING_LEVELS, k) ||
        !levels.includes(k) ||
        typeof val !== "string" ||
        val === ""
      )
        return null;
      map[k] = val;
    }
  }
  // 缺省 / null = 不预填；有值必须是支持的一档（off 总是可选），且模型本身要支持思考。
  const defaultLevel = v.defaultLevel ?? null;
  if (
    defaultLevel !== null &&
    (!reasoning ||
      !oneOf(THINKING_LEVELS, defaultLevel) ||
      (defaultLevel !== "off" && !levels.includes(defaultLevel)))
  )
    return null;
  const input = v.input ?? ["text"];
  if (
    !Array.isArray(input) ||
    input.some((i) => !oneOf(MODEL_INPUTS, i)) ||
    !input.includes("text")
  )
    return null;
  const ctx = nonNegInt(v.ctx);
  const out = nonNegInt(v.out);
  const source = v.source ?? "manual";
  if (ctx === null || out === null || !oneOf(MODEL_SOURCES, source))
    return null;
  return {
    id,
    name: str(v.name, 200) ?? id,
    reasoning,
    levels: [...new Set(levels)] as ModelSpec["levels"],
    ...(defaultLevel ? { defaultLevel } : {}),
    ...(map && Object.keys(map).length ? { map } : {}),
    input: [...new Set(input)] as ModelSpec["input"],
    ctx,
    out,
    source,
  };
}

function parseModels(v: unknown): ModelSpec[] | null {
  if (!Array.isArray(v) || v.length > MODELS_MAX) return null;
  const out: ModelSpec[] = [];
  for (const x of v) {
    const m = parseModel(x);
    if (!m || out.some((o) => o.id === m.id)) return null;
    out.push(m);
  }
  return out;
}

function parseUrl(v: unknown): string | null {
  const s = str(v, 512);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

// 没有凭据时给出的指路：说明请求会 401，并按当前认证方式告诉怎么配。
const HINTS: Record<AuthMethod, string> = {
  key: "还没有保存 API Key，请求会返回 401。填写密钥，或改用环境变量 / 命令。",
  env: "没有读到环境变量，请求会返回 401。在启动 Server 的环境里设置它，或改用 API Key。",
  cmd: "命令没有输出密钥，请求会返回 401。检查命令能否在 Server 所在主机上单独运行。",
  oauth: "还没有登录订阅账号，请求会返回 401。先完成登录，或改用 API Key。",
  ambient: "没有发现云凭据（AWS / GCP 的环境凭据），请求会被拒绝。",
};

export interface ProvidersApiOpts {
  providers: ProviderStore;
  secrets: SecretStore;
  catalog: Catalog;
  agentDir: string;
  /** 有会话在用该供应商的模型；缺省不检查。只拦自定义端点：内置的目录模型还在。 */
  inUse?: (providerId: string) => boolean;
  /** 清掉 pi 里保存的订阅登录；移除内置供应商的配置时，登录方式是订阅的才调用。 */
  logout?: (providerId: string) => Promise<void>;
  /** 探测与测试每个阶段的超时；仅供测试缩短。 */
  timeoutMs?: number;
}

interface Target {
  id: string;
  custom: boolean;
  rec: ProviderRecord | null;
}

/** 内置列表要排掉那些已被 ModelResolver 注册进 runtime 的自定义供应商（它们由 custom 列表展示）。 */
export const builtinIdsOf = (
  ids: readonly string[],
  custom: ReadonlyMap<string, { custom: boolean }>,
): string[] => ids.filter((id) => !custom.get(id)?.custom);

export const blankRecord = (id: string, now: string): ProviderRecord => ({
  id,
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
  createdAt: now,
  updatedAt: now,
});

const blankSpec = (id: string): ModelSpec => ({
  id,
  name: id,
  reasoning: false,
  levels: [],
  input: ["text"],
  ctx: 0,
  out: 0,
  source: "manual",
});

/** 最小补全请求：收到第一个 token（含思考 token）就算通。 */
async function firstToken(
  runtime: Catalog["runtime"],
  model: NonNullable<ReturnType<Catalog["model"]>>,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const stream = runtime.streamSimple(
    model,
    { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
    { signal, maxTokens: 16, ...(apiKey ? { apiKey } : {}) },
  );
  for await (const ev of stream) {
    if (ev.type === "text_delta" || ev.type === "thinking_delta") return;
    if (ev.type === "error")
      throw new StageError(
        "completion_failed",
        ev.error.errorMessage ?? "补全请求失败",
      );
  }
  throw new StageError("no_token", "模型没有返回任何内容");
}

export async function providersApi(
  app: FastifyInstance,
  opts: ProvidersApiOpts,
): Promise<void> {
  const { providers, secrets, catalog, agentDir } = opts;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deps: CredentialDeps = { catalog, providers, secrets };

  function target(id: string): Target | null {
    const rec = providers.get(id);
    if (rec) return { id, custom: rec.custom, rec };
    return catalog.has(id) ? { id, custom: false, rec: null } : null;
  }

  // 换 key：旧密码库条目在记录保存成功后才删（保存前它仍被引用）。
  function replaceKey(
    rec: ProviderRecord,
    key: string | null,
    label: string,
  ): string | null {
    const old = rec.secretId;
    rec.secretId = null;
    providers.setSessionKey(rec.id, null);
    if (key === null) return old;
    if (rec.keyStorage === "session") providers.setSessionKey(rec.id, key);
    else {
      const meta = secrets.create(
        `provider:${label}:${uuidv7().slice(-8)}`,
        "password",
        key,
      );
      rec.secretId = meta?.id ?? null;
    }
    return old;
  }

  // 现有 key 的明文，仅用于改保存位置时搬家。
  const currentKey = (rec: ProviderRecord): string | null =>
    providers.sessionKey(rec.id) ??
    (rec.secretId ? secrets.reveal(rec.secretId) : null);

  async function prepare(t: Target) {
    const rec = t.rec;
    const method = rec?.method ?? catalog.defaultMethod(t.id);
    const api = t.custom ? rec?.api : catalog.api(t.id);
    const baseUrl = rec?.baseUrl ?? (t.custom ? null : catalog.baseUrl(t.id));
    const cred = await inspectCredential(deps, t.id, rec, t.custom);
    const hasKey = !!rec?.secretId || providers.sessionKey(t.id) !== null;
    const credOk = cred.source !== null || isKeyless(rec, hasKey);
    let auth: ResolvedAuth = { own: null, headers: {}, secrets: [] };
    if (credOk) {
      try {
        auth = await resolveAuth(deps, t.id, rec, t.custom, api ?? "");
      } catch {
        // pi 解析失败（如 OAuth 过期）：按无鉴权继续，端点会给出真实的 401。
      }
    }
    const probe =
      baseUrl && canProbeApi(api)
        ? { api: api as string, baseUrl, headers: auth.headers }
        : undefined;
    return {
      rec,
      method,
      api,
      baseUrl,
      credOk,
      auth,
      probe,
      hint: HINTS[method],
    };
  }

  type Applied =
    | { error: string }
    // key：undefined = 不动，null = 清除，字符串 = 新值。conn：连通性相关字段变了，旧测试结果作废。
    | { key: string | null | undefined; conn: boolean };

  // POST 与 PATCH 共用：把请求体里出现的字段逐个校验后写进 rec。
  function applyFields(
    rec: ProviderRecord,
    b: Record<string, unknown>,
  ): Applied {
    let conn = false;
    for (const f of ["name", "slug", "api"] as const)
      if (b[f] !== undefined && !rec.custom)
        return { error: "builtin_immutable" };
    if (b.envVariable !== undefined && !rec.custom)
      return { error: "builtin_immutable" };
    if (b.authHeader !== undefined && !rec.custom)
      return { error: "builtin_immutable" };
    if (b.name !== undefined) {
      const v = str(b.name, 64);
      if (!v) return { error: "invalid_name" };
      rec.name = v;
    }
    if (b.slug !== undefined) {
      if (typeof b.slug !== "string" || !SLUG.test(b.slug))
        return { error: "invalid_slug" };
      if (catalog.has(b.slug)) return { error: "slug_taken" };
      rec.slug = b.slug;
      conn = true;
    }
    if (b.api !== undefined) {
      if (!oneOf(PROVIDER_APIS, b.api)) return { error: "invalid_api" };
      rec.api = b.api as ProviderApi;
      conn = true;
    }
    if (b.baseUrl !== undefined) {
      if (b.baseUrl === null && !rec.custom)
        rec.baseUrl = null; // 清除内置覆盖
      else {
        const v = parseUrl(b.baseUrl);
        if (!v) return { error: "invalid_base_url" };
        rec.baseUrl = v;
      }
      conn = true;
    }
    if (b.method !== undefined) {
      const methods = rec.custom ? CUSTOM_METHODS : catalog.methods(rec.id);
      if (!oneOf(AUTH_METHODS, b.method) || !methods.includes(b.method))
        return { error: "invalid_method" };
      rec.method = b.method;
      conn = true;
    }
    if (b.keyStorage !== undefined) {
      if (!oneOf(KEY_STORAGES, b.keyStorage))
        return { error: "invalid_key_storage" };
      rec.keyStorage = b.keyStorage;
      conn = true;
    }
    if (b.envVariable !== undefined) {
      const v = b.envVariable === null ? null : str(b.envVariable, 128);
      if (v !== null && !ENV_NAME.test(v ?? ""))
        return { error: "invalid_env_variable" };
      rec.envVariable = v;
      conn = true;
    }
    if (b.command !== undefined) {
      const v = b.command === null ? null : str(b.command, 512);
      if (b.command !== null && !v) return { error: "invalid_command" };
      rec.command = v;
      conn = true;
    }
    if (b.authHeader !== undefined) {
      // null = 清除，回到协议默认
      const h =
        b.authHeader === null
          ? null
          : parseAuthHeader(str(b.authHeader, AUTH_HEADER_MAX) ?? "");
      if (b.authHeader !== null && !h) return { error: "invalid_auth_header" };
      rec.authHeader = h ? formatAuthHeader(h) : null;
      conn = true;
    }
    if (b.maxConcurrent !== undefined) {
      // null = 回到缺省；不影响连接，所以不触发重测
      const n = b.maxConcurrent;
      if (
        n !== null &&
        !(
          typeof n === "number" &&
          Number.isInteger(n) &&
          n >= MAX_CONCURRENT_RANGE.min &&
          n <= MAX_CONCURRENT_RANGE.max
        )
      )
        return { error: "invalid_max_concurrent" };
      rec.maxConcurrent = n;
    }
    if (b.compat !== undefined) {
      const c = parseCompat(b.compat);
      if (typeof c === "string") return { error: c };
      rec.compat = c;
      conn = true;
    }
    if (b.models !== undefined) {
      const m = parseModels(b.models);
      if (!m) return { error: "invalid_models" };
      rec.models = m;
    }
    let key: string | null | undefined;
    if (b.apiKey !== undefined) {
      if (b.apiKey === null) key = null;
      else if (
        typeof b.apiKey === "string" &&
        b.apiKey !== "" &&
        b.apiKey.length <= KEY_MAX
      )
        key = b.apiKey;
      else return { error: "invalid_api_key" };
      conn = true;
    }
    if (rec.method === "env" && rec.custom && !rec.envVariable)
      return { error: "env_variable_required" };
    if (rec.method === "cmd" && !rec.command)
      return { error: "command_required" };
    return { key, conn };
  }

  const slugTaken = (rec: ProviderRecord) =>
    rec.slug !== null &&
    providers.list().some((p) => p.id !== rec.id && p.slug === rec.slug);

  const view = (rec: ProviderRecord) => buildView(deps, rec.id, rec);

  app.get("/api/v1/providers", async () => {
    const mine = new Map(providers.list().map((r) => [r.id, r]));
    // 自定义供应商会被 ModelResolver 注册进 catalog.runtime，catalog.ids() 里会多出这些 id；
    // 它们由下面 custom 列表负责展示，内置列表里要去掉，否则同一个供应商会出现两次。
    const builtin = builtinIdsOf(catalog.ids(), mine).map((id) =>
      buildView(deps, id, mine.get(id) ?? null),
    );
    const custom = [...mine.values()]
      .filter((r) => r.custom)
      .map((r) => buildView(deps, r.id, r));
    return { providers: await Promise.all([...builtin, ...custom]) };
  });

  // 内置供应商的目录模型（pi 自带的模型表）：只读，给「从端点获取」补规格、给不能探测端点的供应商当候选。
  app.get<{ Params: { id: string } }>(
    "/api/v1/providers/:id/catalog-models",
    async (req, reply) => {
      const t = target(req.params.id);
      if (!t) return reply.code(404).send({ error: "not_found" });
      return { models: t.custom ? [] : catalog.models(t.id) };
    },
  );

  app.post("/api/v1/providers", async (req, reply) => {
    if (!isObject(req.body)) return bad(reply, "invalid_body");
    const rec: ProviderRecord = {
      ...blankRecord(uuidv7(), new Date().toISOString()),
      custom: true,
    };
    const r = applyFields(rec, req.body);
    if ("error" in r) return bad(reply, r.error);
    if (!rec.name) return bad(reply, "invalid_name");
    if (!rec.slug) return bad(reply, "invalid_slug");
    if (!rec.api) return bad(reply, "invalid_api");
    if (!rec.baseUrl) return bad(reply, "invalid_base_url");
    if (slugTaken(rec)) return reply.code(409).send({ error: "slug_taken" });
    if (r.key) replaceKey(rec, r.key, rec.slug);
    providers.save(rec); // slug 已预检，唯一约束不会再触发
    return reply.code(201).send(await view(rec));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/providers/:id",
    async (req, reply) => {
      const t = target(req.params.id);
      if (!t) return reply.code(404).send({ error: "not_found" });
      if (!isObject(req.body)) return bad(reply, "invalid_body");
      const now = new Date().toISOString();
      const rec: ProviderRecord = t.rec
        ? structuredClone(t.rec)
        : { ...blankRecord(t.id, now), method: catalog.defaultMethod(t.id) };
      const r = applyFields(rec, req.body);
      if ("error" in r) return bad(reply, r.error);
      if (slugTaken(rec)) return reply.code(409).send({ error: "slug_taken" });
      // 只改保存位置没给新 key：把现有 key 搬到新位置。
      const key =
        r.key === undefined && t.rec && rec.keyStorage !== t.rec.keyStorage
          ? currentKey(t.rec)
          : r.key;
      const old =
        key === undefined ? null : replaceKey(rec, key, rec.slug ?? rec.id);
      if (r.conn) rec.lastTest = null;
      rec.updatedAt = now;
      providers.save(rec);
      if (old) secrets.remove(old);
      return view(rec);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/providers/:id",
    async (req, reply) => {
      const t = target(req.params.id);
      if (!t) return reply.code(404).send({ error: "not_found" });
      // 内置供应商删不掉，「删除」就是清掉元枢里保存的这份配置，回到没配置过的样子（环境变量不受影响）。
      if (t.custom && opts.inUse?.(t.id))
        return reply.code(409).send({ error: "in_use" });
      providers.remove(t.id);
      // 记录先删，密码库条目才不再被引用。
      if (t.rec?.secretId) secrets.remove(t.rec.secretId);
      if (!t.custom && t.rec?.method === "oauth") await opts.logout?.(t.id);
      return reply.code(204).send();
    },
  );

  // 探测只取模型 id：能力（上下文、模态、思考档位）无法探测，由用户补全。
  app.post<{ Params: { id: string } }>(
    "/api/v1/providers/:id/models/probe",
    async (req, reply) => {
      const t = target(req.params.id);
      if (!t) return reply.code(404).send({ error: "not_found" });
      const p = await prepare(t);
      // 没有凭据就不返回任何列表：请求必然 401，按认证方式指路。
      if (!p.credOk)
        return reply
          .code(400)
          .send({ error: "no_credential", message: p.hint });
      if (!p.probe) return reply.code(400).send({ error: "probe_unsupported" });
      try {
        return { ids: await fetchModelIds(p.probe, timeoutMs) };
      } catch (err) {
        if (!(err instanceof StageError)) throw err;
        return reply.code(502).send({ error: err.code, message: err.message });
      }
    },
  );

  // 自定义供应商没注册进 pi：用一个临时运行时登记同一份配置（与会话共用 customProviderConfig），
  // 不碰共享 runtime，免得测试把正在运行的会话用的模型清单换掉。
  async function sendFirstToken(
    t: Target,
    p: Awaited<ReturnType<typeof prepare>>,
    modelId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const key = p.auth.own ?? undefined;
    if (!t.custom) {
      const m = catalog.model(t.id, modelId);
      if (!m) throw new StageError("no_model", `目录里没有模型 ${modelId}`);
      // 端点阶段测的是覆盖后的地址，首 token 也要走同一个地址。
      const model = p.rec?.baseUrl ? { ...m, baseUrl: p.rec.baseUrl } : m;
      return firstToken(catalog.runtime, model, key, signal);
    }
    const rec = t.rec as ProviderRecord;
    // 要测的模型不一定已登记（探测出来的 id）：没有规格就按空规格测。
    const spec = rec.models.find((m) => m.id === modelId) ?? blankSpec(modelId);
    const dir = path.join(agentDir, "test");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const runtime = await ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: null,
    });
    runtime.registerProvider(
      rec.id,
      customProviderConfig(rec, key ?? null, [spec]),
    );
    if (key) await runtime.setRuntimeApiKey(rec.id, key);
    const model = runtime.getModel(rec.id, modelId);
    if (!model) throw new StageError("no_model", `没有模型 ${modelId}`);
    await firstToken(runtime, model, undefined, signal);
  }

  app.post<{ Params: { id: string } }>(
    "/api/v1/providers/:id/test",
    async (req, reply) => {
      const t = target(req.params.id);
      if (!t) return reply.code(404).send({ error: "not_found" });
      const b = isObject(req.body) ? req.body : {};
      const model = b.model === undefined ? undefined : str(b.model, 200);
      if (model === null) return bad(reply, "invalid_model");
      const p = await prepare(t);
      const result = await diagnose({
        ...(p.probe ? { probe: p.probe } : {}),
        credential: { ok: p.credOk, hint: p.hint },
        secrets: p.auth.secrets,
        ...(model ? { modelId: model } : {}),
        preferred: [
          ...(t.rec?.models ?? []).map((m) => m.id),
          ...(t.custom ? [] : catalog.models(t.id).map((m) => m.id)),
        ],
        timeoutMs,
        firstToken: (modelId, signal) => sendFirstToken(t, p, modelId, signal),
      });
      // 测试期间记录可能被改或删：以当前库里的为准再写回结果。
      const now = new Date().toISOString();
      const cur =
        providers.get(t.id) ??
        (t.custom
          ? null
          : { ...blankRecord(t.id, now), method: catalog.defaultMethod(t.id) });
      if (cur) providers.save({ ...cur, lastTest: result.lastTest });
      return result;
    },
  );

  // models.json 页：活视图 + 与磁盘文件的 diff 预览。写入未做（见回报）。
  app.get("/api/v1/models-json", async () => {
    const file = path.join(agentDir, "models.json");
    const live = liveModelsJson(catalog, providers.list());
    const onDisk = readModelsJson(file);
    const current = onDisk ? (maskKeys(onDisk) as typeof live) : null;
    return {
      path: file,
      exists: onDisk !== null,
      current,
      live,
      diff: diffJson(current ?? { providers: {} }, live),
    };
  });
}
