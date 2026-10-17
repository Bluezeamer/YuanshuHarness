export interface SessionInfo {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
}

export type Failure =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "rate_limited"; retryAfter: number | null }
  | { kind: "network" }
  | { kind: "server" };

export type Result<T> = { ok: true; data: T } | ({ ok: false } & Failure);

const STORAGE_KEY = "yuanshu.token";

export const loadToken = (): string | null =>
  sessionStorage.getItem(STORAGE_KEY);
export const saveToken = (token: string): void =>
  sessionStorage.setItem(STORAGE_KEY, token);
export const clearToken = (): void => sessionStorage.removeItem(STORAGE_KEY);

// token 只通过参数传入，不在这里读存储：调用方决定用哪个令牌。
export async function listSessions(
  token: string | null,
): Promise<Result<SessionInfo[]>> {
  let res: Response;
  try {
    res = await fetch("/api/v1/sessions", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  if (res.ok) {
    const body = (await res.json()) as { sessions: SessionInfo[] };
    return { ok: true, data: body.sessions };
  }
  if (res.status === 401) return { ok: false, kind: "unauthorized" };
  if (res.status === 403) return { ok: false, kind: "forbidden" };
  if (res.status === 429) {
    const secs = Number(res.headers.get("Retry-After"));
    return {
      ok: false,
      kind: "rate_limited",
      retryAfter: Number.isFinite(secs) && secs > 0 ? secs : null,
    };
  }
  return { ok: false, kind: "server" };
}
