// pane 内容用的服务端接口封装：文件（ADR-0038）、终端（ADR-0036）、审计（ADR-0037）。
// 带 JSON 的调用复用 api.ts 的 call；读写文件内容需要原始字节，单独走 raw。
import { type CallResult, call, enc } from "../api";

export interface FileEntry {
  name: string;
  type: "dir" | "file" | "other";
  size: number;
  mtimeMs: number;
  symlink?: string;
  broken?: boolean;
}

export interface FileListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
}

const files = (env: string) => `/api/v1/environments/${enc(env)}/files`;
const auth = (token: string | null): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};
const sid = (sessionId: string | null) =>
  sessionId ? `&sessionId=${enc(sessionId)}` : "";

export const listFiles = (
  token: string | null,
  env: string,
  path: string,
  hidden: boolean,
) =>
  call(
    "GET",
    `${files(env)}/list?path=${enc(path)}${hidden ? "&hidden=1" : ""}`,
    token,
    undefined,
    (b: FileListing) => {
      if (!Array.isArray(b.entries)) throw new Error("shape");
      return b;
    },
  );

export const makeDir = (
  token: string | null,
  env: string,
  path: string,
  sessionId: string | null,
) =>
  call(
    "POST",
    `${files(env)}/mkdir`,
    token,
    { path, ...(sessionId ? { sessionId } : {}) },
    (b: { path: string }) => b,
  );

export const removeEntry = (
  token: string | null,
  env: string,
  path: string,
  recursive: boolean,
  sessionId: string | null,
) =>
  call(
    "DELETE",
    `${files(env)}/entry?path=${enc(path)}${recursive ? "&recursive=1" : ""}${sid(sessionId)}`,
    token,
    undefined,
    () => undefined,
  );

// 原始字节的调用：失败只区分 pane 需要分别提示的几类。
export type RawFailure =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "network"
  | "server";
export type Raw<T> = { ok: true; data: T } | { ok: false; kind: RawFailure };

const kindOf = (status: number): RawFailure =>
  status === 401
    ? "unauthorized"
    : status === 403
      ? "forbidden"
      : status === 404
        ? "not_found"
        : status === 409
          ? "conflict"
          : status === 413
            ? "too_large"
            : "server";

async function raw<T>(
  url: string,
  init: RequestInit,
  token: string | null,
  read: (res: Response) => Promise<T>,
): Promise<Raw<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...auth(token), ...(init.headers ?? {}) },
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  if (!res.ok) return { ok: false, kind: kindOf(res.status) };
  try {
    return { ok: true, data: await read(res) };
  } catch {
    return { ok: false, kind: "network" };
  }
}

export interface Preview {
  contentType: string;
  bytes: Uint8Array;
  // 文件总大小；响应不带范围信息时等于已取字节数。
  total: number;
}

// 只取前 limit 字节。Range 由服务端按字节截取，文本与二进制同一条路径。
export const readPreview = (
  token: string | null,
  env: string,
  path: string,
  limit: number,
  asText: boolean,
) =>
  raw<Preview>(
    `${files(env)}/content?path=${enc(path)}${asText ? "&as=text" : ""}`,
    { headers: { Range: `bytes=0-${limit - 1}` } },
    token,
    async (res) => {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const range = /\/(\d+)$/.exec(res.headers.get("Content-Range") ?? "");
      return {
        contentType: res.headers.get("Content-Type") ?? "",
        bytes,
        total: range ? Number(range[1]) : bytes.length,
      };
    },
  );

export const readBytes = (token: string | null, env: string, path: string) =>
  raw(
    `${files(env)}/content?path=${enc(path)}`,
    {},
    token,
    async (res) => new Uint8Array(await res.arrayBuffer()),
  );

export const readDownload = (token: string | null, env: string, path: string) =>
  raw(`${files(env)}/content?path=${enc(path)}&download=1`, {}, token, (res) =>
    res.blob(),
  );

export const uploadFile = (
  token: string | null,
  env: string,
  path: string,
  body: Blob,
  overwrite: boolean,
  sessionId: string | null,
) =>
  raw(
    `${files(env)}/content?path=${enc(path)}${overwrite ? "&overwrite=1" : ""}${sid(sessionId)}`,
    { method: "PUT", body },
    token,
    async () => undefined,
  );

// ---- 终端 ----

export interface TerminalInfo {
  id: string;
  environmentId: string;
  cwd: string;
  cols: number;
  rows: number;
}

export const createTerminal = (
  token: string | null,
  body: {
    environmentId: string;
    cwd?: string;
    cols: number;
    rows: number;
    sessionId?: string;
  },
): Promise<CallResult<TerminalInfo>> =>
  call("POST", "/api/v1/terminals", token, body, (b: TerminalInfo) => b);

export const closeTerminal = (token: string | null, id: string) =>
  call(
    "DELETE",
    `/api/v1/terminals/${enc(id)}`,
    token,
    undefined,
    () => undefined,
  );

const SUBPROTOCOL = "yuanshu.v1";

// 令牌走第二个子协议（ADR-0026）。
export function openTerminalSocket(
  id: string,
  token: string | null,
): WebSocket {
  const url = new URL(`/api/v1/terminals/${enc(id)}/stream`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    url.toString(),
    token ? [SUBPROTOCOL, `bearer.${token}`] : [SUBPROTOCOL],
  );
  ws.binaryType = "arraybuffer";
  return ws;
}

// ---- 审计 ----

export const AUDIT_KINDS = [
  "tool",
  "permission",
  "terminal",
  "file",
  "transfer",
  "env",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditEntry {
  id: number;
  ts: string;
  sessionId: string | null;
  actor: "user" | "agent" | "system";
  kind: AuditKind;
  environmentId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export const listAudit = (
  token: string | null,
  q: { session: string | null; kind: AuditKind | null; before?: number },
) => {
  const p = new URLSearchParams({ limit: "100" });
  if (q.session) p.set("session", q.session);
  if (q.kind) p.set("kind", q.kind);
  if (q.before !== undefined) p.set("before", String(q.before));
  return call(
    "GET",
    `/api/v1/audit?${p}`,
    token,
    undefined,
    (b: { entries: AuditEntry[]; nextBefore: number | null }) => {
      if (!Array.isArray(b.entries)) throw new Error("shape");
      return b;
    },
  );
};
