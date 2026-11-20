// 令牌存取、fetch 封装与统一失败类型。token 只通过参数传入，不在这里读存储：调用方决定用哪个令牌。

export type Failure =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "rate_limited"; retryAfter: number | null }
  | { kind: "network" }
  | { kind: "server" };

export type Result<T> = { ok: true; data: T } | ({ ok: false } & Failure);

export type CallFailure =
  | Failure
  | { kind: "bad_request" }
  | { kind: "not_found" }
  | { kind: "conflict" };

export type CallResult<T> =
  | { ok: true; data: T }
  | ({ ok: false } & CallFailure);

const STORAGE_KEY = "yuanshu.token";

// 桌面按页签存（sessionStorage）；手机端装成独立应用后冷启动要还在，入口处改用 localStorage。
let tokenStorage: Storage = sessionStorage;
export const setTokenStorage = (storage: Storage): void => {
  tokenStorage = storage;
};

export const loadToken = (): string | null => tokenStorage.getItem(STORAGE_KEY);
export const saveToken = (token: string): void =>
  tokenStorage.setItem(STORAGE_KEY, token);
export const clearToken = (): void => tokenStorage.removeItem(STORAGE_KEY);

export const enc = encodeURIComponent;

const auth = (token: string | null): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

export function failure(res: Response): Failure {
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 429) {
    const secs = Number(res.headers.get("Retry-After"));
    return {
      kind: "rate_limited",
      retryAfter: Number.isFinite(secs) && secs > 0 ? secs : null,
    };
  }
  return { kind: "server" };
}

interface SendInit {
  method?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
  keepalive?: boolean;
}

// 所有请求的唯一出口；返回 null 表示网络层失败（fetch 抛错）。
export async function send(
  path: string,
  init: SendInit,
  token: string | null,
): Promise<Response | null> {
  try {
    return await fetch(path, {
      ...init,
      headers: { ...auth(token), ...init.headers },
    });
  } catch {
    return null;
  }
}

export const sendJson = (
  method: string,
  path: string,
  token: string | null,
  body: unknown,
  keepalive?: boolean,
) =>
  send(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(keepalive === undefined ? {} : { keepalive }),
    },
    token,
  );

export async function get<T>(
  path: string,
  token: string | null,
  pick: (body: never) => T,
): Promise<Result<T>> {
  const res = await send(path, {}, token);
  if (!res) return { ok: false, kind: "network" };
  if (!res.ok) return { ok: false, ...failure(res) };
  try {
    return { ok: true, data: pick((await res.json()) as never) };
  } catch {
    return { ok: false, kind: "server" };
  }
}

// 带请求体或非 GET 的调用。204 视为成功且无数据。
export async function call<T>(
  method: string,
  path: string,
  token: string | null,
  body: unknown,
  pick: (b: never) => T,
): Promise<CallResult<T>> {
  const res =
    body === undefined
      ? await send(path, { method }, token)
      : await sendJson(method, path, token, body);
  if (!res) return { ok: false, kind: "network" };
  if (res.status === 400) return { ok: false, kind: "bad_request" };
  if (res.status === 404) return { ok: false, kind: "not_found" };
  if (res.status === 409) return { ok: false, kind: "conflict" };
  if (!res.ok) return { ok: false, ...failure(res) };
  if (res.status === 204) return { ok: true, data: undefined as T };
  try {
    return { ok: true, data: pick((await res.json()) as never) };
  } catch {
    return { ok: false, kind: "server" };
  }
}

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

export const rawKind = (status: number): RawFailure =>
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

export async function raw<T>(
  url: string,
  init: SendInit,
  token: string | null,
  read: (res: Response) => Promise<T>,
): Promise<Raw<T>> {
  const res = await send(url, init, token);
  if (!res) return { ok: false, kind: "network" };
  if (!res.ok) return { ok: false, kind: rawKind(res.status) };
  try {
    return { ok: true, data: await read(res) };
  } catch {
    return { ok: false, kind: "network" };
  }
}

// ---- WebSocket ----

const SUBPROTOCOL = "yuanshu.v1";

// 浏览器 WebSocket 不能设请求头，令牌走第二个子协议（ADR-0026）。
export const subprotocols = (token: string | null): string[] =>
  token ? [SUBPROTOCOL, `bearer.${token}`] : [SUBPROTOCOL];

export function wsUrl(path: string): string {
  const url = new URL(path, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

// 终端与侧边浏览器的二进制流；会话流有序号协议，由 Stream 自己建连。
export function openSocket(path: string, token: string | null): WebSocket {
  const ws = new WebSocket(wsUrl(path), subprotocols(token));
  ws.binaryType = "arraybuffer";
  return ws;
}

// ---- 抛错式调用（新界面用；旧界面继续用上面的 Result） ----

export class ApiError extends Error {
  constructor(
    readonly status: number,
    // 服务端错误体（JSON）；网络失败或非 JSON 时为 null，网络失败时 status 为 0。
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
    this.name = "ApiError";
  }

  // 服务端错误体里的错误码，形如 {error: "not_found"} 或 {error: {code}}。
  get code(): string | null {
    const e = (this.body as { error?: unknown } | null)?.error;
    if (typeof e === "string") return e;
    const c = (e as { code?: unknown } | null | undefined)?.code;
    return typeof c === "string" ? c : null;
  }
}

let onUnauthorized: (() => void) | null = null;

// 由 Gate 注册：抛错式调用遇到 401 时回到令牌输入。
export const setUnauthorizedHandler = (fn: (() => void) | null): void => {
  onUnauthorized = fn;
};

export async function request<T = void>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const res =
    body === undefined
      ? await send(path, { method }, token)
      : await sendJson(method, path, token, body);
  if (!res) throw new ApiError(0, null);
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok)
    throw new ApiError(res.status, await res.json().catch(() => null));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
