import { readFileSync } from "node:fs";
import {
  type ModelSpec,
  type ProviderRecord,
  THINKING_LEVELS,
  type ThinkingLevelName,
} from "../store/providers.js";
import { authHeaderValue, parseAuthHeader } from "./auth-header.js";
import type { Catalog } from "./catalog.js";

// pi models.json 的子集：只覆盖本页会产出的字段。
type Json = Record<string, unknown>;
export interface ModelsJson {
  providers: Record<string, Json>;
}

export const MASK = "••••";

// pi 默认支持的档位；其余（xhigh/max）必须显式映射才算支持。
const DEFAULT_LEVELS = new Set<ThinkingLevelName>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
]);

function levelMap(m: ModelSpec): Json | undefined {
  if (!m.reasoning) return undefined;
  const out: Json = {};
  for (const l of THINKING_LEVELS) {
    const on = m.levels.includes(l);
    if (on && m.map?.[l]) out[l] = m.map[l];
    else if (on && !DEFAULT_LEVELS.has(l)) out[l] = l;
    else if (!on && DEFAULT_LEVELS.has(l)) out[l] = null;
  }
  return Object.keys(out).length ? out : undefined;
}

// ModelSpec → pi 的模型条目。audio/video 在 pi 里没有对应取值，写文件时丢掉。
export function piModel(m: ModelSpec): Json {
  const map = levelMap(m);
  return {
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input.filter((i) => i === "text" || i === "image"),
    ...(m.ctx ? { contextWindow: m.ctx } : {}),
    ...(m.out ? { maxTokens: m.out } : {}),
    ...(map ? { thinkingLevelMap: map } : {}),
  };
}

// 内置供应商：和目录一致的字段不写，只留用户改过的（modelOverrides），不重写整份模型列表。
function overrideOf(m: ModelSpec, base: ModelSpec): Json {
  const a = piModel(m);
  const b = piModel(base);
  const out: Json = {};
  for (const k of Object.keys(a)) {
    if (k !== "id" && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      out[k] = a[k];
  }
  return out;
}

// key 永远不出现：明文存 models.json 的只放占位，由「应用」那一步才会写入真值。
function apiKeyOf(r: ProviderRecord): string | undefined {
  if (r.method === "key" && r.keyStorage === "models" && r.secretId)
    return MASK;
  if (r.method === "env" && r.envVariable) return `$${r.envVariable}`;
  if (r.method === "cmd" && r.command) return `!${r.command}`;
  return undefined;
}

// 自定义鉴权头在 pi 里是 headers 的一项，值里带密钥：写环境变量引用，其余一律是占位（密钥不出现在预览里）。
function authHeadersOf(r: ProviderRecord): Json | undefined {
  const h = r.authHeader ? parseAuthHeader(r.authHeader) : null;
  if (!h) return undefined;
  const key = r.method === "env" && r.envVariable ? `$${r.envVariable}` : MASK;
  return { [h.name]: authHeaderValue(h, key) };
}

/** 按当前登记状态算出 models.json 应有的样子（活视图）。 */
export function liveModelsJson(
  catalog: Catalog,
  records: ProviderRecord[],
): ModelsJson {
  const providers: Record<string, Json> = {};
  for (const r of records) {
    const apiKey = apiKeyOf(r);
    if (r.custom) {
      providers[r.slug as string] = {
        baseUrl: r.baseUrl,
        api: r.api,
        ...(apiKey ? { apiKey } : {}),
        ...(authHeadersOf(r) ? { headers: authHeadersOf(r) } : {}),
        ...(r.compat ? { compat: r.compat } : {}),
        models: r.models.map(piModel),
      };
      continue;
    }
    const base = new Map(catalog.models(r.id).map((m) => [m.id, m]));
    const overrides: Record<string, Json> = {};
    const added: Json[] = [];
    for (const m of r.models) {
      const b = base.get(m.id);
      if (!b) added.push(piModel(m));
      else {
        const o = overrideOf(m, b);
        if (Object.keys(o).length) overrides[m.id] = o;
      }
    }
    const entry: Json = {
      ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(overrides).length ? { modelOverrides: overrides } : {}),
      ...(added.length ? { models: added } : {}),
    };
    if (Object.keys(entry).length) providers[r.id] = entry;
  }
  return { providers };
}

// 磁盘上的文件可能带用户手写的明文 key：回显前先遮掉（环境变量引用与命令不是秘密）。
export function maskKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskKeys);
  if (typeof v !== "object" || v === null) return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      k === "apiKey" && typeof x === "string" && !/^[$!]/.test(x)
        ? MASK
        : maskKeys(x),
    ]),
  );
}

export function readModelsJson(file: string): ModelsJson | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as ModelsJson;
    return typeof j === "object" && j !== null ? j : null;
  } catch {
    return null;
  }
}

export interface DiffOp {
  op: "add" | "remove" | "replace";
  /** 以 / 分隔；数组里带 id 的元素按 id 取，不按下标。 */
  path: string;
  before?: unknown;
  after?: unknown;
}

const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const byId = (v: unknown): v is Json[] =>
  Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === "string");

/** 结构化 diff：只列出变化的叶子，而不是整份覆盖。 */
export function diffJson(
  before: unknown,
  after: unknown,
  path = "",
  out: DiffOp[] = [],
): DiffOp[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  if (before === undefined) out.push({ op: "add", path, after });
  else if (after === undefined) out.push({ op: "remove", path, before });
  else if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)]))
      diffJson(before[k], after[k], `${path}/${k}`, out);
  } else if (byId(before) && byId(after)) {
    const a = new Map(before.map((x) => [x.id as string, x]));
    const b = new Map(after.map((x) => [x.id as string, x]));
    for (const id of new Set([...a.keys(), ...b.keys()]))
      diffJson(a.get(id), b.get(id), `${path}/${id}`, out);
  } else out.push({ op: "replace", path, before, after });
  return out;
}
