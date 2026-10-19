export interface SessionInfo {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  workspaceId?: string | null;
  reviewPolicy?: string | null;
}

export type Tier = "rules" | "auto" | "full";

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  tier: Tier;
  createdAt: string;
}

export interface RuleInfo {
  id: string;
  kind: "path" | "command";
  access: "read" | "write" | null;
  value: string;
  createdAt: string;
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

export type CallFailure =
  | Failure
  | { kind: "bad_request" }
  | { kind: "not_found" }
  | { kind: "conflict" };

export type CallResult<T> =
  | { ok: true; data: T }
  | ({ ok: false } & CallFailure);

// 带请求体或非 GET 的调用。204 视为成功且无数据。
async function call<T>(
  method: string,
  path: string,
  token: string | null,
  body: unknown,
  pick: (b: never) => T,
): Promise<CallResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, kind: "network" };
  }
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

const enc = encodeURIComponent;

export const listWorkspaces = (token: string | null) =>
  get("/api/v1/workspaces", token, (b: { workspaces: WorkspaceInfo[] }) => {
    if (!Array.isArray(b.workspaces)) throw new Error("shape");
    return b.workspaces;
  });

export const createWorkspace = (
  token: string | null,
  body: { path: string; name?: string },
) => call("POST", "/api/v1/workspaces", token, body, (b: WorkspaceInfo) => b);

export const patchWorkspace = (
  token: string | null,
  id: string,
  body: { name?: string; tier?: Tier },
) =>
  call(
    "PATCH",
    `/api/v1/workspaces/${enc(id)}`,
    token,
    body,
    (b: WorkspaceInfo) => b,
  );

export const deleteWorkspace = (token: string | null, id: string) =>
  call("DELETE", `/api/v1/workspaces/${enc(id)}`, token, undefined, () => {});

export const listRules = (token: string | null, workspaceId: string) =>
  get(
    `/api/v1/workspaces/${enc(workspaceId)}/rules`,
    token,
    (b: { rules: RuleInfo[] }) => {
      if (!Array.isArray(b.rules)) throw new Error("shape");
      return b.rules;
    },
  );

export const deleteRule = (
  token: string | null,
  workspaceId: string,
  ruleId: string,
) =>
  call(
    "DELETE",
    `/api/v1/workspaces/${enc(workspaceId)}/rules/${enc(ruleId)}`,
    token,
    undefined,
    () => {},
  );

export const createSession = (
  token: string | null,
  body: { workspaceId?: string },
) =>
  call("POST", "/api/v1/sessions", token, body, (b: { id: string }) => {
    if (typeof b.id !== "string") throw new Error("shape");
    return b;
  });

// reviewPolicy 空串表示清除。
export const patchSession = (
  token: string | null,
  id: string,
  body: { reviewPolicy: string },
) => call("PATCH", `/api/v1/sessions/${enc(id)}`, token, body, () => {});

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
  readable: boolean;
  writable: boolean;
  truncated: boolean;
}

// path 缺省为服务端用户 home；400 表示路径不存在或不是目录。
export const listDirs = (token: string | null, path?: string, hidden = false) =>
  call(
    "GET",
    `/api/v1/fs/dirs?${path === undefined ? "" : `path=${enc(path)}&`}hidden=${hidden ? 1 : 0}`,
    token,
    undefined,
    (b: DirListing) => {
      if (typeof b.path !== "string" || !Array.isArray(b.dirs))
        throw new Error("shape");
      return b;
    },
  );

export type ModelApiKind =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export interface ModelInfo {
  id: string;
  name: string;
  api: ModelApiKind;
  baseUrl: string;
  modelId: string;
  contextWindow: number | null;
  reasoning: boolean;
  image: boolean;
  hasKey: boolean;
  isDefault: boolean;
}

export interface ModelInput {
  name: string;
  api: ModelApiKind;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  reasoning: boolean;
  image: boolean;
  apiKey?: string;
}

export const listModels = (token: string | null) =>
  call("GET", "/api/v1/models", token, undefined, (b: { models: ModelInfo[] }) => {
    if (!Array.isArray(b.models)) throw new Error("shape");
    return b.models;
  });

export const createModel = (token: string | null, input: ModelInput) =>
  call("POST", "/api/v1/models", token, input, (b: ModelInfo) => b);

export const setDefaultModel = (token: string | null, id: string) =>
  call("PATCH", `/api/v1/models/${enc(id)}`, token, { isDefault: true }, (b: ModelInfo) => b);

export const deleteModel = (token: string | null, id: string) =>
  call("DELETE", `/api/v1/models/${enc(id)}`, token, undefined, () => {});

export const testModel = (token: string | null, input: ModelInput) =>
  call(
    "POST",
    "/api/v1/models/test",
    token,
    input,
    (b: { ok: boolean; error?: string }) => {
      if (typeof b.ok !== "boolean") throw new Error("shape");
      return b;
    },
  );
