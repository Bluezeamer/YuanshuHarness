export interface SessionInfo {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
}

export interface ChatEntry {
  index: number;
  role: "user" | "assistant";
  text: string;
}

export interface Page {
  messages: ChatEntry[];
  nextBefore: string | null;
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

function failure(res: Response): Failure {
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

// token 只通过参数传入，不在这里读存储：调用方决定用哪个令牌。
async function get<T>(
  path: string,
  token: string | null,
  pick: (body: never) => T,
): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  if (!res.ok) return { ok: false, ...failure(res) };
  try {
    return { ok: true, data: pick((await res.json()) as never) };
  } catch {
    return { ok: false, kind: "server" };
  }
}

export const listSessions = (token: string | null) =>
  get(
    "/api/v1/sessions",
    token,
    (b: { sessions: SessionInfo[] }) => b.sessions,
  );

// 服务端上限 200 条；默认 50 条恰好等于快照窗口，取不到更早的历史。
export const listMessages = (
  id: string,
  token: string | null,
  before?: string,
) =>
  get(
    `/api/v1/sessions/${encodeURIComponent(id)}/messages?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    token,
    (b: Page) => {
      if (!Array.isArray(b.messages)) throw new Error("bad page");
      return { messages: b.messages, nextBefore: b.nextBefore ?? null };
    },
  );

export interface Workbench {
  revision: number;
  document: unknown | null;
}

export const getWorkbench = (token: string | null) =>
  get("/api/v1/workbench", token, (b: Workbench) => {
    if (typeof b.revision !== "number") throw new Error("shape");
    return { revision: b.revision, document: b.document ?? null };
  });

export type PutResult =
  | { ok: true; revision: number }
  | { ok: false; kind: "conflict"; current: Workbench }
  | ({ ok: false } & Failure);

// 409 带回当前文档，所以不走通用的 get。pagehide 期间走 keepalive。
export async function putWorkbench(
  token: string | null,
  baseRevision: number,
  document: unknown,
  keepalive = false,
): Promise<PutResult> {
  let res: Response;
  try {
    res = await fetch("/api/v1/workbench", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ baseRevision, document }),
      keepalive,
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  try {
    if (res.status === 409) {
      const b = (await res.json()) as Workbench;
      return {
        ok: false,
        kind: "conflict",
        current: { revision: b.revision, document: b.document ?? null },
      };
    }
    if (!res.ok) return { ok: false, ...failure(res) };
    const b = (await res.json()) as { revision: number };
    if (typeof b.revision !== "number") return { ok: false, kind: "server" };
    return { ok: true, revision: b.revision };
  } catch {
    return { ok: false, kind: "server" };
  }
}

export interface SavedLayout {
  id: string;
  revision: number;
  document: unknown;
}

export const listSavedLayouts = (token: string | null) =>
  get("/api/v1/saved-layouts", token, (b: { layouts: SavedLayout[] }) => {
    if (!Array.isArray(b.layouts)) throw new Error("shape");
    return b.layouts;
  });

export type CreateSavedResult =
  | { ok: true; id: string; revision: number }
  | ({ ok: false } & Failure);

export async function createSavedLayout(
  token: string | null,
  document: unknown,
): Promise<CreateSavedResult> {
  let res: Response;
  try {
    res = await fetch("/api/v1/saved-layouts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ document }),
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  try {
    if (res.status === 201) {
      const b = (await res.json()) as { id: string; revision: number };
      if (typeof b.id !== "string" || typeof b.revision !== "number")
        return { ok: false, kind: "server" };
      return { ok: true, id: b.id, revision: b.revision };
    }
    if (!res.ok) return { ok: false, ...failure(res) };
    return { ok: false, kind: "server" };
  } catch {
    return { ok: false, kind: "server" };
  }
}

export type DeleteSavedResult =
  | { ok: true }
  | { ok: false; kind: "not_found" }
  | ({ ok: false } & Failure);

export async function deleteSavedLayout(
  token: string | null,
  id: string,
): Promise<DeleteSavedResult> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/saved-layouts/${id}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  if (res.status === 204) return { ok: true };
  if (res.status === 404) return { ok: false, kind: "not_found" };
  return { ok: false, ...failure(res) };
}
