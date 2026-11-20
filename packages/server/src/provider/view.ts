import type {
  AuthMethod,
  KeyStorage,
  LastTest,
  ModelSpec,
  ProviderCompat,
  ProviderRecord,
} from "../store/providers.js";
import {
  type CredentialDeps,
  type CredentialInfo,
  inspectCredential,
} from "./credentials.js";
import { DEFAULT_MAX_CONCURRENT } from "./limiter.js";
import { canProbeApi } from "./probe.js";

// off = 未配置；warn = 需注意（测过但失败，或自定义端点还没测通）；ok = 已连接。
export type ProviderStatus = "off" | "warn" | "ok";

/** 永远不含 key：只有 hasKey 与凭据来源名。 */
export interface ProviderView {
  id: string;
  name: string;
  custom: boolean;
  /** 用户添加过：自定义端点恒为 true，内置供应商看库里有没有记录。环境凭据不算。 */
  added: boolean;
  methods: AuthMethod[];
  method: AuthMethod;
  status: ProviderStatus;
  /** 自定义供应商是四种之一；内置的是 pi 目录里的协议名，可能不在四种里（如 mistral-conversations）。 */
  api?: string;
  baseUrl?: string;
  /** 能否探测端点（拉模型列表、测端点可达）；false 时测试只验证凭据与首 token。 */
  probeable: boolean;
  slug?: string;
  /** 自定义鉴权头（仅自定义供应商）；不含密钥。 */
  authHeader?: string;
  /** 同时在途的模型请求数上限（缺省 50）；超了在服务端排队 */
  maxConcurrent: number;
  compat?: ProviderCompat;
  keyStorage: KeyStorage;
  envVariable?: string;
  command?: string;
  hasKey: boolean;
  credential: CredentialInfo;
  lastTest?: LastTest;
  models: ModelSpec[];
}

export const CUSTOM_METHODS: AuthMethod[] = ["key", "env", "cmd"];

// 本地端点常不需要密钥：自定义供应商选了 API Key 却没填，视为无鉴权端点。
export const isKeyless = (rec: ProviderRecord | null, hasKey: boolean) =>
  rec?.custom === true && rec.method === "key" && !hasKey;

export function statusOf(
  cred: CredentialInfo,
  rec: ProviderRecord | null,
  hasKey: boolean,
): ProviderStatus {
  const custom = rec?.custom === true;
  // 无鉴权端点没有凭据可证明连得上，所以必须测过才算已连接。
  if (cred.source === null && !isKeyless(rec, hasKey)) return "off";
  if (rec?.lastTest && !rec.lastTest.ok) return "warn";
  if (custom && !rec?.lastTest?.ok) return "warn";
  return "ok";
}

export async function buildView(
  d: CredentialDeps,
  id: string,
  rec: ProviderRecord | null,
): Promise<ProviderView> {
  const custom = rec?.custom === true;
  const cred = await inspectCredential(d, id, rec, custom);
  const hasKey = !!rec?.secretId || d.providers.sessionKey(id) !== null;
  const api = custom ? rec?.api : d.catalog.api(id);
  const baseUrl = rec?.baseUrl ?? d.catalog.baseUrl(id);
  const mine = rec?.models ?? [];
  return {
    id,
    name: custom ? (rec?.name ?? id) : d.catalog.name(id),
    custom,
    added: rec !== null,
    methods: custom ? CUSTOM_METHODS : d.catalog.methods(id),
    method: rec?.method ?? d.catalog.defaultMethod(id),
    status: statusOf(cred, rec, hasKey),
    ...(api ? { api } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    probeable: !!baseUrl && canProbeApi(api),
    ...(rec?.slug ? { slug: rec.slug } : {}),
    ...(rec?.authHeader ? { authHeader: rec.authHeader } : {}),
    maxConcurrent: rec?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    ...(rec?.compat ? { compat: rec.compat } : {}),
    keyStorage: rec?.keyStorage ?? "auth",
    ...(rec?.envVariable ? { envVariable: rec.envVariable } : {}),
    ...(rec?.command ? { command: rec.command } : {}),
    hasKey,
    credential: cred,
    ...(rec?.lastTest ? { lastTest: rec.lastTest } : {}),
    // 内置供应商也只列用户添加的：目录里的模型要先「从端点获取」挑出来才算添加（目录规格见 /catalog-models）
    models: mine,
  };
}
