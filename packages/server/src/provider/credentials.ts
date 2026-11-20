import { execFile } from "node:child_process";
import type { ProviderRecord, ProviderStore } from "../store/providers.js";
import type { SecretStore } from "../store/secrets.js";
import type { Catalog } from "./catalog.js";
import { authHeaders } from "./probe.js";

// pi 的解析顺序：运行时 --api-key → auth.json → models.json 的 apiKey → 环境变量 / 云凭据。
export const CRED_SOURCES = [
  "--api-key",
  "auth.json",
  "models.json",
  "env",
] as const;
export type CredSource = (typeof CRED_SOURCES)[number];

export interface CredentialTier {
  source: CredSource;
  hit: boolean;
  /** 只放来源名：环境变量名、云凭据来源名。永远不放值。 */
  detail?: string;
}

export interface CredentialInfo {
  /** 命中的第一档；都没命中为 null。 */
  source: CredSource | null;
  detail?: string;
  chain: CredentialTier[];
}

export interface CredentialDeps {
  catalog: Catalog;
  providers: ProviderStore;
  secrets: SecretStore;
}

// pi 对已存的 API Key 返回 source "stored credential"，对订阅登录的 OAuth 凭据返回 type "oauth"
// （source 是 "OAuth"）；其余来源是环境变量名或云凭据名。
const PI_STORED = "stored credential";

export async function inspectCredential(
  d: CredentialDeps,
  id: string,
  rec: ProviderRecord | null,
  custom: boolean,
): Promise<CredentialInfo> {
  const key = rec?.method === "key";
  // 内置供应商问 pi：它知道 auth.json、环境变量和云凭据的真实情况。自定义供应商没注册进 pi。
  const pi = custom ? undefined : await d.catalog.runtime.checkAuth(id);
  const piStored = pi?.source === PI_STORED || pi?.type === "oauth";
  const envName =
    custom &&
    rec?.method === "env" &&
    rec.envVariable &&
    process.env[rec.envVariable]
      ? rec.envVariable
      : undefined;

  const chain: CredentialTier[] = [
    { source: "--api-key", hit: key && d.providers.sessionKey(id) !== null },
    {
      source: "auth.json",
      hit: piStored || (key && rec?.keyStorage === "auth" && !!rec.secretId),
    },
    {
      source: "models.json",
      hit:
        (key && rec?.keyStorage === "models" && !!rec.secretId) ||
        (rec?.method === "cmd" && !!rec.command),
    },
    {
      source: "env",
      hit: envName !== undefined || (!!pi && !piStored),
      ...(envName
        ? { detail: envName }
        : pi && !piStored
          ? { detail: pi.source }
          : {}),
    },
  ];
  const first = chain.find((t) => t.hit);
  return {
    source: first?.source ?? null,
    ...(first?.detail ? { detail: first.detail } : {}),
    chain,
  };
}

function runCommand(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { timeout: 5000, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        const out = err ? "" : stdout.split("\n")[0]?.trim();
        resolve(out || null);
      },
    );
  });
}

export interface ResolvedAuth {
  /** 我们自己持有的 key（会话 / 密码库 / 命令 / 自定义供应商的环境变量）；内置供应商走 pi 自己的来源时为 null。 */
  own: string | null;
  /** 探测请求用的完整鉴权头。 */
  headers: Record<string, string>;
  /** 本次涉及的全部秘密值，供错误文本遮罩。 */
  secrets: string[];
}

const bare = (v: string) => v.replace(/^Bearer\s+/i, "");

/** 取出真正用于请求的凭据；只在探测/测试内部使用，结果不得写进任何响应。 */
export async function resolveAuth(
  d: CredentialDeps,
  id: string,
  rec: ProviderRecord | null,
  custom: boolean,
  api: string,
): Promise<ResolvedAuth> {
  const own = await ownKey(d, id, rec, custom);
  if (own || custom)
    return {
      own,
      headers: authHeaders(api, own, custom ? rec?.authHeader : null),
      secrets: own ? [own] : [],
    };
  // 内置供应商：pi 已经把 auth.json / 环境变量 / 云凭据解析成了可直接用的头或 key。
  const res = await d.catalog.runtime.getAuth(id);
  const auth = res?.auth as
    | { apiKey?: string; headers?: Record<string, string> }
    | undefined;
  const headers =
    auth?.headers ?? (auth?.apiKey ? authHeaders(api, auth.apiKey) : {});
  return {
    own: null,
    headers,
    secrets: [auth?.apiKey, ...Object.values(headers).map(bare)].filter(
      (x): x is string => !!x,
    ),
  };
}

async function ownKey(
  d: CredentialDeps,
  id: string,
  rec: ProviderRecord | null,
  custom: boolean,
): Promise<string | null> {
  if (rec?.method === "key") {
    const session = d.providers.sessionKey(id);
    if (session) return session;
    if (rec.secretId) return d.secrets.reveal(rec.secretId);
  }
  if (rec?.method === "cmd" && rec.command) return runCommand(rec.command);
  if (custom && rec?.method === "env" && rec.envVariable)
    return process.env[rec.envVariable] ?? null;
  return null;
}
