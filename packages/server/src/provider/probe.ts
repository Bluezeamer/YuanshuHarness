// 探测只取模型 id 列表；能力（上下文、模态、思考档位）不可探测，由用户补全。
import { PROVIDER_APIS } from "../store/providers.js";
import { authHeaderValue, parseAuthHeader } from "./auth-header.js";

export class StageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ProbeTarget {
  api: string;
  baseUrl: string;
  /** 完整的鉴权头；空对象表示不带鉴权（本地端点）。 */
  headers: Record<string, string>;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

// 能按 GET {baseUrl}/models 探测的协议：与 ProviderApi 同一组，pi 目录里其余协议（bedrock、mistral 等）没有统一的列表端点。
// 不可探测的供应商仍可测凭据与首 token，只是端点与模型列表两个阶段跳过。
export const canProbeApi = (api: string | null | undefined): boolean =>
  (PROVIDER_APIS as readonly string[]).includes(api ?? "");

/**
 * 各协议约定的鉴权头；自定义鉴权头（见 auth-header.ts）覆盖同名的默认头、并追加其余。
 * pi 发真实请求时也是这样：它自己的默认头仍会发，自定义头只在同名时取代它。
 */
export function authHeaders(
  api: string,
  key: string | null,
  custom?: string | null,
): Record<string, string> {
  if (!key) return {};
  let out: Record<string, string>;
  if (api === "anthropic-messages")
    out = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  else if (api === "google-generative-ai") out = { "x-goog-api-key": key };
  else out = { authorization: `Bearer ${key}` };
  const h = custom ? parseAuthHeader(custom) : null;
  if (!h) return out;
  const same = h.name.toLowerCase();
  out = Object.fromEntries(
    Object.entries(out).filter(([k]) => k.toLowerCase() !== same),
  );
  return { ...out, [h.name]: authHeaderValue(h, key) };
}

// pi 内置的 Anthropic / Gemini baseUrl 不带版本段（SDK 自己补），列表端点却在版本段下面。
function modelsUrl(api: string, baseUrl: string): string {
  let base = trimSlash(baseUrl);
  if (!/\/v\d+(beta)?$/.test(base)) {
    if (api === "anthropic-messages") base += "/v1";
    else if (api === "google-generative-ai") base += "/v1beta";
  }
  return `${base}/models`;
}

// fetch 失败归为超时或不可达；cause.code 是 undici 给出的系统错误码。
function classify(err: unknown): StageError {
  const e = err as { name?: string; cause?: { code?: string } };
  if (e.name === "TimeoutError" || e.name === "AbortError")
    return new StageError("timeout", "请求超时");
  return new StageError(
    "unreachable",
    `无法连接端点${e.cause?.code ? `（${e.cause.code}）` : ""}`,
  );
}

async function get(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  try {
    // manual：不跟随重定向，避免 x-api-key 这类自定义鉴权头被带去别的主机。
    return await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw classify(err);
  }
}

/** 端点是否可达：不带任何凭据请求 baseUrl，任何 HTTP 应答都算可达。 */
export async function pingEndpoint(
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const res = await get(baseUrl, { accept: "*/*" }, timeoutMs);
  await res.body?.cancel();
}

// OpenAI / Anthropic：{data:[{id}]}；Gemini：{models:[{name:"models/x"}]}。
function parseIds(json: unknown): string[] {
  const o = json as { data?: unknown; models?: unknown } | unknown[] | null;
  const list = Array.isArray(o) ? o : (o?.data ?? o?.models);
  if (!Array.isArray(list))
    throw new StageError("bad_response", "响应不是模型列表");
  const ids = list.flatMap((x) => {
    const raw =
      typeof x === "string"
        ? x
        : ((x as { id?: unknown; name?: unknown })?.id ??
          (x as { name?: unknown })?.name);
    return typeof raw === "string" && raw ? [raw.replace(/^models\//, "")] : [];
  });
  return [...new Set(ids)];
}

/** GET {baseUrl}/models，只回 id。空列表由调用方决定算不算失败。 */
export async function fetchModelIds(
  t: ProbeTarget,
  timeoutMs: number,
): Promise<string[]> {
  const res = await get(
    modelsUrl(t.api, t.baseUrl),
    { accept: "application/json", ...t.headers },
    timeoutMs,
  );
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new StageError("unauthorized", `${res.status}：密钥无效或没有权限`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new StageError("http_error", `HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    // 读 body 时超时与 JSON 语法错误走的是同一个 catch。
    if (err instanceof SyntaxError)
      throw new StageError("bad_response", "响应不是 JSON");
    throw classify(err);
  }
  return parseIds(json);
}
